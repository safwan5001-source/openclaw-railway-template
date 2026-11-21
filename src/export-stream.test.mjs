// Streaming export against the real wrapper (fake gateway), with a large synthetic data set.
// Regression for the production incident: build-then-send export -> 499s, orphaned zips, leftover temp copies, OOM.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE = path.join(ROOT, "scripts", "fixtures", "fake-openclaw.mjs");
const PASSWORD = "synthetic-export-password";
const BASIC = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`;
const BIG_FILES = 6; // x 50 MB of incompressible data
let T;
let TMP; // the wrapper's os.tmpdir(): the old export left its copies here
let wrapper;
let port;
let output = "";

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const put = (rel, content) => {
  const p = path.join(T, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};
const childZips = () => {
  try {
    return execFileSync("ps", ["--ppid", String(wrapper.pid), "-o", "comm="], { encoding: "utf8" })
      .split("\n")
      .filter((c) => c.trim() === "zip").length;
  } catch {
    return 0;
  }
};
const rssMb = () => Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${wrapper.pid}/status`, "utf8"))[1]) / 1024;

/** GET the export; resolves with timings/bytes. `abortAfterBytes` simulates a phone that gives up mid-download. */
function getExport({ saveTo, abortAfterBytes } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let first = null;
    let bytes = 0;
    let peakRss = 0;
    const out = saveTo ? fs.createWriteStream(saveTo) : null;
    const req = http.get({ host: "127.0.0.1", port, path: "/setup/api/export", headers: { authorization: BASIC } }, (res) => {
      if (res.statusCode !== 200) {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, body }));
        return;
      }
      res.on("data", (chunk) => {
        if (first === null) first = Date.now() - t0;
        bytes += chunk.length;
        if (bytes % (20 * 1024 * 1024) < chunk.length) peakRss = Math.max(peakRss, rssMb());
        out?.write(chunk);
        if (abortAfterBytes && bytes >= abortAfterBytes) {
          req.destroy();
          resolve({ status: 200, aborted: true, bytes, ttfbMs: first });
        }
      });
      res.on("end", () => {
        out?.end();
        out ? out.on("finish", () => resolve({ status: 200, bytes, ttfbMs: first, totalMs: Date.now() - t0, peakRss, headers: res.headers })) : resolve({ status: 200, bytes, ttfbMs: first, totalMs: Date.now() - t0, peakRss, headers: res.headers });
      });
    });
    req.on("error", (e) => (abortAfterBytes ? null : reject(e)));
  });
}

before(async () => {
  T = fs.mkdtempSync(path.join(os.tmpdir(), "basht-export-test-"));
  TMP = path.join(T, "wrapper-tmp");
  fs.mkdirSync(TMP);
  put("data/.openclaw/openclaw.json", JSON.stringify({ gateway: { mode: "local" } }));
  put("data/.openclaw/credentials/whatsapp/default/creds.json", '{"synthetic":true}');
  put("data/.openclaw/state/openclaw.sqlite", "SQLite format 3\0synthetic");
  put("data/.openclaw/cache/huge-cache.bin", crypto.randomBytes(5 * 1024 * 1024));
  put("data/.openclaw/server.log", "log");
  put("data/workspace/MEMORY.md", "# synthetic memory");
  put("data/workspace/skills/basht-daftra/SKILL.md", "synced");
  for (let i = 0; i < BIG_FILES; i++) put(`data/workspace/exports/big-${i}.bin`, crypto.randomBytes(50 * 1024 * 1024));
  fs.symlinkSync("/etc/passwd", path.join(T, "data/workspace/link"));
  port = await freePort();
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("RAILWAY_") || k.startsWith("OPENCLAW_") || k.startsWith("BASHT_")) delete env[k];
  wrapper = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...env,
      TMPDIR: TMP,
      PORT: String(port),
      INTERNAL_GATEWAY_PORT: String(await freePort()),
      OPENCLAW_STATE_DIR: path.join(T, "data/.openclaw"),
      OPENCLAW_WORKSPACE_DIR: path.join(T, "data/workspace"),
      OPENCLAW_ENTRY: FAKE,
      OPENCLAW_GATEWAY_TOKEN: "synthetic-gateway-token-export-tests",
      OPENCLAW_PERSONA_SEED: "0",
      SETUP_PASSWORD: PASSWORD,
    },
  });
  wrapper.stdout.on("data", (d) => (output += d));
  wrapper.stderr.on("data", (d) => (output += d));
  for (let i = 0; i < 150; i++) {
    try {
      if ((await (await fetch(`http://127.0.0.1:${port}/setup/healthz`)).json()).gatewayReachable) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("wrapper not ready\n" + output);
});

after(async () => {
  if (wrapper && wrapper.exitCode === null) {
    const exited = new Promise((r) => wrapper.once("exit", r));
    wrapper.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  try {
    process.kill(-wrapper.pid, "SIGKILL");
  } catch {}
  wrapper?.stdout?.destroy();
  wrapper?.stderr?.destroy();
  fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("plan: reports what the export will contain before downloading", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/setup/api/export/plan`, { headers: { authorization: BASIC } });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.ok(j.bytes >= BIG_FILES * 50 * 1024 * 1024 && j.bytes < BIG_FILES * 50 * 1024 * 1024 + 1024 * 1024, `bytes ${j.bytes} (cache excluded)`);
  assert.equal(j.running, false);
});

test("stream: first byte at once, wrapper memory flat, nothing written to temp, valid restorable ZIP", async (t) => {
  const zip = path.join(T, "export.zip");
  const r = await getExport({ saveTo: zip });
  assert.equal(r.status, 200);
  t.diagnostic(`export ${Math.round(r.bytes / 1e6)} MB: first byte ${r.ttfbMs} ms, total ${r.totalMs} ms, wrapper RSS peak ${Math.round(r.peakRss)} MB`);
  assert.ok(r.ttfbMs < 3000, `first byte after ${r.ttfbMs} ms (old export: only after the whole archive was built)`);
  assert.ok(r.bytes > BIG_FILES * 50 * 1024 * 1024, "full archive received");
  assert.ok(r.peakRss < 250, `wrapper RSS peaked at ${Math.round(r.peakRss)} MB during a ${Math.round(r.bytes / 1e6)} MB export`);
  assert.deepEqual(fs.readdirSync(TMP).filter((f) => /export/.test(f)), [], "no temp copy");
  assert.match(r.headers["content-disposition"], /attachment; filename="openclaw-export-.*\.zip"/);
  assert.equal(spawnSync("unzip", ["-tq", "-P", PASSWORD, zip]).status, 0, "archive valid with the setup password");
  assert.notEqual(spawnSync("unzip", ["-tq", "-P", "wrong", zip]).status, 0, "and only with it");
  const entries = spawnSync("unzip", ["-Z1", zip], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  const stateRel = path.join(T, "data/.openclaw").slice(1);
  const wsRel = path.join(T, "data/workspace").slice(1);
  for (const must of [`${stateRel}/credentials/whatsapp/default/creds.json`, `${stateRel}/state/openclaw.sqlite`, `${wsRel}/MEMORY.md`, `${wsRel}/exports/big-0.bin`])
    assert.ok(entries.includes(must), `missing ${must}`);
  for (const never of [`${stateRel}/cache/huge-cache.bin`, `${stateRel}/server.log`, `${wsRel}/skills/basht-daftra/SKILL.md`, `${wsRel}/link`])
    assert.ok(!entries.includes(never), `must not contain ${never}`);
  // the import's entry rule (everything under the state or workspace path)
  for (const e of entries) {
    const n = e.replace(/\/+$/, "");
    assert.ok([stateRel, wsRel].some((p) => n === p || n.startsWith(p + "/")), `import would refuse ${e}`);
  }
});

test("one export at a time; a client that gives up stops the zip at once (no orphan, no leftover)", async () => {
  const first = getExport({ abortAfterBytes: 5 * 1024 * 1024 });
  await new Promise((r) => setTimeout(r, 50));
  const second = await getExport();
  assert.equal(second.status, 409, "concurrent export refused");
  const r = await first;
  assert.ok(r.aborted);
  await new Promise((r2) => setTimeout(r2, 500));
  assert.equal(childZips(), 0, "zip killed when the client went away");
  assert.match(output, /stopped \(client went away\)/);
  assert.deepEqual(fs.readdirSync(TMP).filter((f) => /export/.test(f)), []);
  const again = await getExport({ abortAfterBytes: 1024 });
  assert.equal(again.status, 200, "a new export can start right after");
  await new Promise((r2) => setTimeout(r2, 300));
});

test("export remains behind the setup login", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/setup/api/export`);
  assert.equal(r.status, 401);
  const p = await fetch(`http://127.0.0.1:${port}/setup/api/export/plan`);
  assert.equal(p.status, 401);
});
