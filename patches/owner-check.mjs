#!/usr/bin/env node
// BASHT read-only owner / memory-flush check (companion to the PR #25 memory-flush owner-identity patch).
//
//   gosu openclaw node /app/patches/owner-check.mjs        # in the OpenClaw service's Railway console
//
// Answers, for the WhatsApp owner:
//   q1  is there an explicit (non-wildcard) WhatsApp owner in commands.ownerAllowFrom?
//   q2  does that owner have a WhatsApp DM session, i.e. will the PR #25 patch re-verify it at flush time?
//   q3  does any tool policy still remove read/write from the memory flush once the owner identity is kept?
//
// Guarantees (enforced by patches/owner-check.test.mjs, which snapshots every file before and after a run):
//   * NO WRITES to production. It never runs the OpenClaw CLI and never opens a database: even OpenClaw's read commands
//     (`config get`, `sessions list`) write to state/openclaw.sqlite when they open it. Instead it reads openclaw.json
//     and the session-store bytes through read-only file handles, and replays OpenClaw's tool-policy assembly in a child
//     process whose HOME, TMPDIR, XDG_CACHE_HOME, OPENCLAW_STATE_DIR and workspace all point into one throwaway directory
//     (deleted before exit), with a minimal environment (no secrets inherited). Nothing is sent, restarted or changed.
//   * NO DATA OUT. The child's stdout/stderr go to /dev/null and its result returns on a private pipe; the parent prints
//     nothing else. The only output is one line `BASHT_OWNER_CHECK {json}` with
//     booleans, counts, sanitised policy-step names and a verdict; any 7+ digit run is masked as a last line of defence;
//     errors are reduced to their type.
//   * Refuses to run as root and refuses any OpenClaw version other than the one the patch was validated against.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_OPENCLAW = "2026.10.9";
const AGENT_TOOLS_CHUNK = "dist/agent-tools-Bpi7xWYy.mjs";
const SESSION_KEY_RE = /agent:[a-z0-9_-]{1,64}:whatsapp:direct:(\+?\d{7,15})(?!\d)/g;
const emit = process.stdout.write.bind(process.stdout);
const finish = (out, code = 0) => {
  emit(`BASHT_OWNER_CHECK ${JSON.stringify(out).replace(/\+?\d{7,}/g, "<n>")}\n`);
  process.exit(code);
};

if (typeof process.getuid === "function" && process.getuid() === 0) {
  finish({ readOnly: true, VERDICT: "REFUSED: run as the gateway user: gosu openclaw node owner-check.mjs" }, 2);
}
// Silence everything printed in-process (OpenClaw warnings could echo config text). Only finish() writes to stdout.
process.stdout.write = () => true;
process.stderr.write = () => true;
for (const k of ["log", "info", "warn", "error", "debug", "trace"]) console[k] = () => {};

const PKG = process.env.OPENCLAW_PACKAGE_ROOT || "/usr/local/lib/node_modules/openclaw";
const label = (s) => String(s ?? "?").replace(/[^A-Za-z0-9 ._()*-]/g, "").slice(0, 80);
const typeOf = (err) => (err && typeof err === "object" && typeof err.name === "string" ? err.name : "Error").replace(/[^A-Za-z]/g, "").slice(0, 40);

// ---- Child mode: replays OpenClaw's tool assembly. Started by the parent with stdout/stderr -> /dev/null and every
// writable location (HOME, TMPDIR, XDG_CACHE_HOME, OPENCLAW_STATE_DIR, workspace) inside the parent's sandbox; its only
// output channel is fd 3. Input (policy sections + candidate numbers) arrives on stdin.
if (process.env.BASHT_OWNER_CHECK_CHILD === "1") {
  const res = {};
  try {
    const { cfg, num, ws } = JSON.parse(fs.readFileSync(0, "utf8"));
    const mod = await import(pathToFileURL(path.join(PKG, AGENT_TOOLS_CHUNK)).href);
    const sim = async (n, flags) => {
      const removedBy = { read: [], write: [] };
      const tools = await mod.i({ config: cfg, agentId: "main", sessionKey: `agent:main:whatsapp:direct:${n}`, workspaceDir: ws,
        messageProvider: "whatsapp", messageChannel: "whatsapp", chatType: "direct", ...flags }, undefined, (e) => {
        for (const t of ["read", "write"]) if (e.before.some((x) => x.name === t) && !e.after.some((x) => x.name === t)) removedBy[t].push(label(e.step?.label));
      });
      const names = new Set(tools.map((t) => t.name));
      return { read: names.has("read"), write: names.has("write"), tools: names.size, removedBy };
    };
    const flush = { trigger: "memory", memoryFlushWritePath: `memory/${new Date().toISOString().slice(0, 10)}.md` };
    const unknown = "+10000000001"; // synthetic: never a real number
    res.sim_flush_anonymous = await sim(num ?? "+10000000000", { ...flush, senderIsOwner: false });
    if (num) {
      res.q3_owner_live_turn = await sim(num, { senderIsOwner: true, senderE164: num, senderId: num });
      res.q2q3_flush_with_owner_identity = await sim(num, { ...flush, senderIsOwner: true, senderE164: num, senderId: num });
    }
    res.security_flush_unknown_sender = await sim(unknown, { ...flush, senderIsOwner: false, senderE164: unknown, senderId: unknown });
  } catch (err) {
    res.simulation_error = typeOf(err);
  }
  fs.writeSync(3, JSON.stringify(res));
  process.exit(0);
}

let version;
try { version = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")).version; } catch {}
if (version !== EXPECTED_OPENCLAW) finish({ readOnly: true, VERDICT: `REFUSED: expected OpenClaw ${EXPECTED_OPENCLAW}` }, 3);

const out = { readOnly: true, openclaw: version };
const e164 = (v) => { const d = String(v).replace(/[^\d]/g, ""); return d.length >= 7 && d.length <= 15 ? `+${d}` : undefined; };

// Real production paths (read-only use only).
const home = os.homedir();
const STATE = path.resolve(process.env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw"));
const CONFIG = path.resolve(process.env.OPENCLAW_CONFIG_PATH || path.join(STATE, "openclaw.json"));

// Read-only file access: open with O_RDONLY, never stat-then-write, never create.
const readOnlyBytes = (file) => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
};

// ---- config (openclaw.json; JSON5 via OpenClaw's own json5 dependency)
let cfgAll;
try {
  const text = readOnlyBytes(CONFIG).toString("utf8");
  try { cfgAll = JSON.parse(text); } catch { cfgAll = createRequire(path.join(PKG, "package.json"))("json5").parse(text); }
} catch (err) { out.config_error = typeOf(err); }
out.config_read = Boolean(cfgAll && typeof cfgAll === "object");
out.config_uses_include = Boolean(cfgAll && JSON.stringify(cfgAll).includes("\"$include\""));
// Only policy-relevant sections are kept; credentials and channel tokens are never copied out of cfgAll.
const cfg = cfgAll ? { commands: cfgAll.commands, tools: cfgAll.tools, agents: cfgAll.agents,
  channels: cfgAll.channels?.whatsapp ? { whatsapp: { allowFrom: cfgAll.channels.whatsapp.allowFrom, groupAllowFrom: cfgAll.channels.whatsapp.groupAllowFrom,
    dmPolicy: cfgAll.channels.whatsapp.dmPolicy, groupPolicy: cfgAll.channels.whatsapp.groupPolicy, groups: cfgAll.channels.whatsapp.groups } } : undefined,
  session: cfgAll.session } : {};
cfgAll = undefined;

// commands.ownerAllowFrom resolved like OpenClaw's resolveOwnerAllowFromList for channel "whatsapp": wildcards and other
// channels' prefixed entries dropped, "whatsapp:" prefix removed, numbers normalised to E.164.
const raw = Array.isArray(cfg.commands?.ownerAllowFrom) ? cfg.commands.ownerAllowFrom.map(String) : [];
const owners = new Set(raw.filter((v) => v.trim() !== "*" && (!/^[a-z][a-z0-9-]*:/i.test(v.trim()) || /^whatsapp:/i.test(v.trim())))
  .map((v) => e164(v.trim().replace(/^whatsapp:/i, ""))).filter(Boolean));
out.q1_ownerAllowFrom_present = raw.length > 0;
out.q1_explicit_whatsapp_owner_entries = owners.size;
out.q1_wildcard_entry_present = raw.some((v) => v.trim() === "*");
const chanAllow = new Set((cfg.channels?.whatsapp?.allowFrom ?? []).map(e164).filter(Boolean));
out.info_channel_allowFrom_entries_not_owner = [...chanAllow].filter((n) => !owners.has(n)).length;

// ---- WhatsApp DM session keys: byte scan of the agent session stores (+ WAL), read-only, no SQLite connection.
const directNums = new Set();
let storesRead = 0;
try {
  const agentsDir = path.join(STATE, "agents");
  for (const agent of fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir) : []) {
    for (const name of ["openclaw-agent.sqlite", "openclaw-agent.sqlite-wal"]) {
      const file = path.join(agentsDir, agent, "agent", name);
      if (!fs.existsSync(file)) continue;
      for (const m of readOnlyBytes(file).toString("latin1").matchAll(SESSION_KEY_RE)) { const n = e164(m[1]); if (n) directNums.add(n); }
      storesRead += 1;
    }
  }
} catch (err) { out.sessions_error = typeOf(err); }
out.session_stores_read = storesRead;
out.whatsapp_direct_sessions = directNums.size;
const ownerSessions = [...directNums].filter((n) => owners.has(n));
out.q2_owner_has_whatsapp_dm_session = ownerSessions.length > 0;

// ---- Replay OpenClaw's real tool assembly in a child process, sandboxed: every writable location points into one
// throwaway directory (deleted below); the child's stdout/stderr go to /dev/null; its result comes back on fd 3 only.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "basht-owner-check-"));
try {
  for (const d of ["home", "tmp", "cache", "state", "ws"]) fs.mkdirSync(path.join(sandbox, d));
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "production", BASHT_OWNER_CHECK_CHILD: "1", OPENCLAW_PACKAGE_ROOT: PKG,
    HOME: path.join(sandbox, "home"), TMPDIR: path.join(sandbox, "tmp"), XDG_CACHE_HOME: path.join(sandbox, "cache"),
    OPENCLAW_STATE_DIR: path.join(sandbox, "state"), OPENCLAW_WORKSPACE_DIR: path.join(sandbox, "ws"), OPENCLAW_CONFIG_PATH: path.join(sandbox, "state", "openclaw.json") };
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env, cwd: sandbox, timeout: 120_000,
    input: JSON.stringify({ cfg, num: ownerSessions[0] ?? [...owners][0], ws: path.join(sandbox, "ws") }), stdio: ["pipe", "ignore", "ignore", "pipe"] });
  const res = JSON.parse(String(r.output?.[3] ?? "") || "{}");
  Object.assign(out, res);
  if (!("sim_flush_anonymous" in res) && !res.simulation_error) out.simulation_error = r.error ? typeOf(r.error) : `ChildExit${r.status ?? r.signal ?? ""}`.replace(/[^A-Za-z0-9]/g, "");
} catch (err) {
  out.simulation_error = typeOf(err);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

const p = out.q2q3_flush_with_owner_identity;
out.VERDICT =
  !out.config_read ? "BLOCKED: openclaw.json could not be read (see config_error)"
  : out.config_uses_include ? "BLOCKED: openclaw.json uses $include; this check reads one file only"
  : out.simulation_error ? "BLOCKED: simulation failed (see simulation_error)"
  : !out.q1_ownerAllowFrom_present || out.q1_explicit_whatsapp_owner_entries === 0 ? "BLOCKED: no explicit WhatsApp owner in commands.ownerAllowFrom (patch fails closed)"
  : !out.q2_owner_has_whatsapp_dm_session ? "BLOCKED: configured owner has no WhatsApp DM session (owner entry does not match the chatting number)"
  : out.security_flush_unknown_sender?.write && !out.sim_flush_anonymous?.write ? "BLOCKED: an unknown sender identity gets write in the flush (review toolsBySender)"
  : p?.read && p?.write ? "READY: PR #25 will recognise the owner and the flush keeps read + append-only write"
  : "BLOCKED: owner is verified but tool policy still removes read/write for the flush (see removedBy)";
finish(out);
