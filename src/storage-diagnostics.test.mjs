import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildLines,
  DEFAULTS,
  isProtectedName,
  isSafeName,
  nextAlertState,
  scanTree,
  startStorageDiagnostics,
} from "./storage-diagnostics.js";

const DAY = 24 * 60 * 60 * 1000;
const CANARY = "CANARY_SECRET_VALUE_9f3a";

function put(root, rel, size = 1024, ageDays = 0) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, CANARY.padEnd(size, "x"));
  const t = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(p, t, t);
  return p;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diag-"));
  // protected data (must never be named nor become a candidate)
  put(root, ".openclaw/agents/main/sessions/abc.jsonl", 40_000, 30);
  put(root, ".openclaw/whatsapp/creds.json", 5_000, 30);
  put(root, ".openclaw/credentials/token.txt.bak", 2_000, 30);
  put(root, "workspace/MEMORY.md", 3_000, 30);
  put(root, "workspace/memory/2026-11-01.md", 4_000, 30);
  put(root, "workspace/memory/old.tmp", 4_000, 30);
  put(root, ".openclaw/state.sqlite", 6_000, 30);
  // backups of sensitive files outside protected directories stay protected, never candidates
  put(root, "workspace/customers.sqlite.bak", 6_000, 30);
  put(root, "workspace/IDENTITY.md.bak", 2_000, 30);
  put(root, "workspace/creds.json.old", 2_000, 30);
  put(root, "workspace/openclaw.json.bak.1", 2_000, 30);
  // unprotected, measurable candidates
  put(root, "tmp/old.tmp", 10_000, 20);
  put(root, "workspace/notes.md.bak", 7_000, 20);
  put(root, ".cache/Homebrew/dl.tar.gz", 20_000, 20);
  put(root, "workspace/exports/a.pdf", 30_000, 40);
  put(root, "workspace/server.log", 5_000, 20);
  // active / recent must be excluded
  put(root, "tmp/fresh.tmp", 8_000, 0);
  put(root, ".cache/Homebrew/x.lock", 100, 40);
  // identifying names must not leak
  put(root, "workspace/+966501234567.json", 900, 1);
  // possible duplicates by name+size (contents are never compared)
  put(root, "workspace/a/video.mp4", 2_000_000, 1);
  put(root, "workspace/b/video.mp4", 2_000_000, 1);
  return root;
}

test("names: protected and unsafe names are classified conservatively", () => {
  for (const n of ["MEMORY.md", "memory", "sessions", "whatsapp", "credentials", "creds.json", "x.sqlite", "openclaw.json.bak", ".env", "IDENTITY.md", "a.jsonl"])
    assert.ok(isProtectedName(n), n);
  for (const n of ["customers.sqlite.bak", "IDENTITY.md.bak", "creds.json.old", "openclaw.json.bak.1", "MEMORY.md~", "x.db-wal.bak"])
    assert.ok(isProtectedName(n), n);
  for (const n of ["workspace", "exports", ".linuxbrew", "tmp", "notes.md.bak", "old.tmp", "~"]) assert.ok(!isProtectedName(n), n);
  assert.ok(!isSafeName("+966501234567.json"));
  assert.ok(!isSafeName("a".repeat(40)));
  assert.ok(!isSafeName("0123456789abcdef0123"));
  assert.ok(isSafeName(".linuxbrew"));
});

test("scan: protected data is only an anonymous total; candidates exclude it", async () => {
  const root = fixture();
  const r = await scanTree(root, { now: Date.now() });
  assert.ok(r.protectedBytes > 0);
  // candidates only come from unprotected trees and old-enough, non-active files
  assert.equal(r.candidates.tmp.n, 1, "tmp/old.tmp only (protected old.tmp and fresh.tmp excluded)");
  assert.equal(r.candidates.backup.n, 1, "notes.md.bak only (credentials/*.bak is protected)");
  assert.equal(r.candidates.cache.n, 1);
  assert.equal(r.candidates.exportsOld.n, 1);
  assert.equal(r.candidates.log.n, 1);
  assert.ok(r.activeExcluded.n >= 2, "fresh.tmp and a cache .lock file are excluded from candidates");
  assert.equal(r.dupes.n, 1);
  assert.ok(r.dupes.bytes >= 2_000_000 - 4096);
  fs.rmSync(root, { recursive: true, force: true });
});

test("output never contains protected names, identifying names or file contents", async () => {
  const root = fixture();
  const r = await scanTree(root, { now: Date.now() });
  const [summary, detail] = buildLines(r, { total: 5e9, used: 3.9e9, free: 1.1e9, pct: 78 }, "ok");
  const all = summary + detail;
  for (const bad of ["sessions", "whatsapp", "credentials", "MEMORY", "creds", "state.sqlite", "966501234567", CANARY, "abc.jsonl", "video.mp4"])
    assert.ok(!all.includes(bad), `leaked ${bad}`);
  assert.ok(all.includes("<protected>"));
  assert.ok(JSON.parse(summary).candidates.cache.mb >= 0);
  assert.ok(detail.length <= 3500);
  fs.rmSync(root, { recursive: true, force: true });
});

test("scan: symlinks are not followed and mount boundaries are respected", async () => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "diag-out-"));
  put(outside, "big.bin", 5_000_000, 40);
  fs.symlinkSync(outside, path.join(root, "workspace", "link"));
  const before = await scanTree(root, { now: Date.now() });
  assert.equal(before.symlinksSkipped, 1);
  assert.ok(before.bytes < 1_000_000 + 4_500_000, "outside tree not counted");
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("scan: entry budget truncates instead of running unbounded", async () => {
  const root = fixture();
  const r = await scanTree(root, { now: Date.now(), maxEntries: 3 });
  assert.equal(r.truncated, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("module has no write/delete/read-content primitives", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "storage-diagnostics.js"), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const bad of ["readFile", "createReadStream", "writeFile", "appendFile", "unlink", "rmSync", "rm(", "rename", "copyFile", "truncate(", "child_process", "exec(", "spawn", "fetch("])
    assert.ok(!code.includes(bad), `forbidden primitive: ${bad}`);
});

test("alerts: one notice per level rise, hysteresis, daily reminder, single recovery", () => {
  let s = null;
  const t0 = 1_000_000_000;
  const step = (pct, t) => {
    const r = nextAlertState(s, pct, t, DEFAULTS);
    s = r.state;
    return r.emit;
  };
  assert.equal(step(70, t0), null);
  assert.equal(step(86, t0 + 1), "warn");
  assert.equal(step(87, t0 + 3600_000), null, "no repeat within 24h");
  assert.equal(step(84, t0 + 7200_000), null, "inside hysteresis band stays warn without alert");
  assert.equal(step(96, t0 + 7300_000), "crit");
  assert.equal(step(96, t0 + 7400_000), null);
  assert.equal(step(96, t0 + 7300_000 + 25 * 3600_000), "reminder");
  assert.equal(step(70, t0 + 30 * 3600_000), "recovered");
  assert.equal(step(70, t0 + 31 * 3600_000), null);
});

test("start: disabled by default and touches nothing", () => {
  let touched = false;
  const h = startStorageDiagnostics({
    log: { info() { touched = true; }, warn() { touched = true; } },
    env: {},
    setTimeoutFn: () => { touched = true; },
  });
  assert.equal(h, null);
  assert.equal(touched, false);
});

test("start: a statfs failure keeps the previous alert state and emits no false recovery", async () => {
  const root = fixture();
  const lines = [];
  const log = { info: (c, m) => lines.push(["info", m]), warn: (c, m) => lines.push(["warn", m]) };
  let fail = false;
  const h = startStorageDiagnostics({
    log,
    env: { DIAG_STORAGE: "1", DIAG_STORAGE_ROOT: root },
    statfs: async () => {
      if (fail) throw new Error("statfs unavailable");
      return { blocks: 1000, bsize: 1_000_000, bfree: 30, bavail: 30 }; // 97% used
    },
    setTimeoutFn: () => ({ unref() {} }),
  });
  assert.equal((await h.runOnce()).emit, "crit");
  fail = true;
  const r = await h.runOnce();
  assert.equal(r.emit, null);
  assert.equal(JSON.parse(r.summary).level, "crit", "level preserved");
  assert.equal(JSON.parse(r.summary).fs, null);
  assert.ok(!lines.some(([, m]) => /back below/.test(m)), "no false recovery message");
  h.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

test("start: opt-in runOnce logs two compact lines and a single warning above 85%", async () => {
  const root = fixture();
  const lines = [];
  const log = { info: (c, m) => lines.push(["info", m]), warn: (c, m) => lines.push(["warn", m]) };
  const h = startStorageDiagnostics({
    log,
    env: { DIAG_STORAGE: "1", DIAG_STORAGE_ROOT: root },
    statfs: async () => ({ blocks: 1000, bsize: 1_000_000, bfree: 100, bavail: 100 }), // 90% used
    setTimeoutFn: () => ({ unref() {} }),
  });
  assert.ok(h);
  const first = await h.runOnce();
  assert.equal(first.emit, "warn");
  const second = await h.runOnce();
  assert.equal(second.emit, null, "no repeated alert");
  const json = lines.filter(([, m]) => m.startsWith("{"));
  assert.equal(json.length, 4);
  for (const [, m] of json) assert.ok(m.length <= 4000 && JSON.parse(m).v === 1);
  assert.equal(lines.filter(([k]) => k === "warn").length, 1);
  h.stop();
  fs.rmSync(root, { recursive: true, force: true });
});
