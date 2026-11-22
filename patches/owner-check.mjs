#!/usr/bin/env node
// BASHT read-only owner / memory-flush check (companion to the PR #25 memory-flush owner-identity patch).
//
//   gosu openclaw node /app/patches/owner-check.mjs        # in the OpenClaw service's Railway console
//
// Answers, for the WhatsApp owner:
//   q1  is there an explicit (non-wildcard) WhatsApp owner in commands.ownerAllowFrom, in a form OpenClaw accepts?
//   q2  does that owner have a WhatsApp DM session, i.e. will the PR #25 patch re-verify it at flush time?
//   q3  for every agent that holds such a session, does tool policy still remove read/write from the memory flush once
//       the owner identity is kept?
//
// Guarantees (enforced by patches/owner-check.test.mjs and E2E case G):
//   * NO WRITES to production. It never runs the OpenClaw CLI and never opens a database (even OpenClaw's read commands
//     write to state/openclaw.sqlite). The parent reads openclaw.json and the agent session-store bytes through
//     O_RDONLY|O_NOFOLLOW handles. The tool-policy replay runs in a child process that receives ONLY an allowlist of
//     tool-policy fields (no paths such as agentDir/session.store, no API keys), whose HOME, TMPDIR, XDG_CACHE_HOME,
//     OPENCLAW_STATE_DIR and workspace live in one throwaway directory (deleted before exit), with a minimal environment
//     and OpenClaw logging silenced (its file logger otherwise appends to the shared /tmp/openclaw/*.log the live gateway
//     uses). Nothing is sent, restarted or changed.
//   * NO DATA OUT. The child's stdout/stderr go to /dev/null; its result returns on a private pipe. The parent prints one
//     line `BASHT_OWNER_CHECK {json}` (booleans, counts, sanitised agent ids / policy-step names, verdict). Any 7+ digit
//     run is masked; errors are reduced to their type; uncaught errors still end in that single line.
//   * Fails closed: refuses root and any OpenClaw version other than 2026.10.9; BLOCKED on unreadable config, $include,
//     unsubstituted ${ENV} in policy fields, ownerAllowFrom entries OpenClaw would not accept, or any simulation error.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_OPENCLAW = "2026.10.9";
const AGENT_TOOLS_CHUNK = "dist/agent-tools-Bpi7xWYy.mjs";
// A DM session key as stored: not preceded by an identifier character, and not followed by more key segments
// (":thread:…") or digits, so keys embedded in other keys or in free text do not count.
const SESSION_KEY_RE = /(?<![A-Za-z0-9_:.-])agent:([a-z0-9][a-z0-9_-]{0,63}):whatsapp:direct:(\+?\d{7,15})(?![\d:A-Za-z_-])/g;
const OWNER_ENTRY_RE = /^(?:whatsapp:)?\+?\d{7,15}$/i;
const emit = process.stdout.write.bind(process.stdout);
let finished = false;
const finish = (out, code = 0) => {
  if (finished) return;
  finished = true;
  emit(`BASHT_OWNER_CHECK ${JSON.stringify(out).replace(/\+?\d{7,}/g, "<n>")}\n`);
  process.exit(code);
};
const typeOf = (err) => (err && typeof err === "object" && typeof err.name === "string" ? err.name : "Error").replace(/[^A-Za-z]/g, "").slice(0, 40);
const label = (s) => String(s ?? "?").replace(/[^A-Za-z0-9 ._()*-]/g, "").slice(0, 80);
const IS_CHILD = process.env.BASHT_OWNER_CHECK_CHILD === "1";

// Any uncaught error still ends in the single result line (parent) or a silent exit (child).
const onFatal = (err) => (IS_CHILD ? process.exit(70) : finish({ readOnly: true, VERDICT: "BLOCKED: internal error", internal_error: typeOf(err) }, 1));
process.on("uncaughtException", onFatal);
process.on("unhandledRejection", onFatal);

if (typeof process.getuid === "function" && process.getuid() === 0) {
  finish({ readOnly: true, VERDICT: "REFUSED: run as the gateway user: gosu openclaw node owner-check.mjs" }, 2);
}
// Silence everything printed in-process (OpenClaw warnings could echo config text). Only finish() writes to stdout.
process.stdout.write = () => true;
process.stderr.write = () => true;
for (const k of ["log", "info", "warn", "error", "debug", "trace"]) console[k] = () => {};

const PKG = process.env.OPENCLAW_PACKAGE_ROOT || "/usr/local/lib/node_modules/openclaw";

// ---- Child mode: replays OpenClaw's tool assembly for each (agent, owner number) pair. Its only output is fd 3.
if (IS_CHILD) {
  const res = {};
  try {
    const { cfg, pairs, fallback, ws } = JSON.parse(fs.readFileSync(0, "utf8"));
    const mod = await import(pathToFileURL(path.join(PKG, AGENT_TOOLS_CHUNK)).href);
    const sim = async (agentId, n, flags) => {
      const removedBy = { read: [], write: [] };
      const tools = await mod.i({ config: cfg, agentId, sessionKey: `agent:${agentId}:whatsapp:direct:${n}`, workspaceDir: ws,
        messageProvider: "whatsapp", messageChannel: "whatsapp", chatType: "direct", ...flags }, undefined, (e) => {
        for (const t of ["read", "write"]) if (e.before.some((x) => x.name === t) && !e.after.some((x) => x.name === t)) removedBy[t].push(label(e.step?.label));
      });
      const names = new Set(tools.map((t) => t.name));
      return { read: names.has("read"), write: names.has("write"), tools: names.size, removedBy };
    };
    const flush = { trigger: "memory", memoryFlushWritePath: `memory/${new Date().toISOString().slice(0, 10)}.md` };
    const unknown = "+10000000001"; // synthetic: never a real number
    res.agents = [];
    for (const { agent, num } of pairs.length ? pairs : [{ agent: "main", num: fallback }]) {
      const r = { agent: label(agent) };
      r.flush_anonymous = await sim(agent, num ?? "+10000000000", { ...flush, senderIsOwner: false });
      if (num) {
        r.owner_live_turn = await sim(agent, num, { senderIsOwner: true, senderE164: num, senderId: num });
        r.flush_with_owner_identity = await sim(agent, num, { ...flush, senderIsOwner: true, senderE164: num, senderId: num });
      }
      r.flush_unknown_sender = await sim(agent, unknown, { ...flush, senderIsOwner: false, senderE164: unknown, senderId: unknown });
      res.agents.push(r);
    }
  } catch (err) {
    res.simulation_error = typeOf(err);
  }
  fs.writeSync(3, JSON.stringify(res));
  process.exit(0);
}

// ---- Parent
const out = { readOnly: true };
let version;
try { version = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")).version; } catch {}
if (version !== EXPECTED_OPENCLAW) finish({ readOnly: true, VERDICT: `REFUSED: expected OpenClaw ${EXPECTED_OPENCLAW}` }, 3);
out.openclaw = version;

const e164 = (v) => { const d = String(v).replace(/[^\d]/g, ""); return d.length >= 7 && d.length <= 15 ? `+${d}` : undefined; };
const STATE = path.resolve(process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw"));
const CONFIG = path.resolve(process.env.OPENCLAW_CONFIG_PATH || path.join(STATE, "openclaw.json"));
const readOnlyBytes = (file) => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
};

// Only fields that decide tool policy for a WhatsApp DM are forwarded to the child (see resolveEffectiveToolPolicy,
// resolveSenderToolPolicy): no paths (agentDir, workspace, session.store), no credentials, no API keys.
const POLICY_KEYS = ["profile", "allow", "alsoAllow", "deny"];
const pickPolicy = (t) => {
  if (!t || typeof t !== "object") return undefined;
  const o = {};
  for (const k of POLICY_KEYS) if (t[k] !== undefined) o[k] = t[k];
  if (t.byProvider && typeof t.byProvider === "object") o.byProvider = Object.fromEntries(Object.entries(t.byProvider).map(([k, v]) => [k, pickPolicy(v) ?? {}]));
  if (t.toolsBySender && typeof t.toolsBySender === "object") o.toolsBySender = Object.fromEntries(Object.entries(t.toolsBySender).map(([k, v]) => [k, pickPolicy(v) ?? {}]));
  return o;
};
const pickAgent = (a) => (a && typeof a === "object" ? { ...(a.id !== undefined ? { id: a.id } : {}), ...(a.default !== undefined ? { default: a.default } : {}), ...(a.tools ? { tools: pickPolicy(a.tools) } : {}) } : a);

let cfg;
try {
  let all;
  const text = readOnlyBytes(CONFIG).toString("utf8");
  try { all = JSON.parse(text); } catch { all = createRequire(path.join(PKG, "package.json"))("json5").parse(text); }
  out.config_read = Boolean(all && typeof all === "object");
  out.config_uses_include = JSON.stringify(all ?? {}).includes("\"$include\"");
  const agents = all?.agents && typeof all.agents === "object" ? {
    ...(all.agents.defaults ? { defaults: all.agents.defaults.tools ? { tools: pickPolicy(all.agents.defaults.tools) } : {} } : {}),
    ...(Array.isArray(all.agents.list) ? { list: all.agents.list.map(pickAgent) } : {}),
    ...(all.agents.entries && typeof all.agents.entries === "object" ? { entries: Object.fromEntries(Object.entries(all.agents.entries).map(([k, v]) => [k, pickAgent(v)])) } : {}),
  } : undefined;
  cfg = { ...(all?.tools ? { tools: pickPolicy(all.tools) } : {}), ...(agents ? { agents } : {}) };
  out.config_unsubstituted_env = JSON.stringify(cfg).includes("${");
  const raw = Array.isArray(all?.commands?.ownerAllowFrom) ? all.commands.ownerAllowFrom.map((v) => String(v).trim()) : [];
  const whatsappish = raw.filter((v) => v !== "*" && (!/^[a-z][a-z0-9-]*:/i.test(v) || /^whatsapp:/i.test(v)));
  out.q1_ownerAllowFrom_present = raw.length > 0;
  out.q1_wildcard_entry_present = raw.includes("*");
  out.q1_unrecognised_owner_entries = whatsappish.filter((v) => !OWNER_ENTRY_RE.test(v)).length + (raw.some((v) => v.includes("${")) ? 1 : 0);
  cfg.owners = [...new Set(whatsappish.filter((v) => OWNER_ENTRY_RE.test(v)).map((v) => e164(v.replace(/^whatsapp:/i, ""))).filter(Boolean))];
  out.q1_explicit_whatsapp_owner_entries = cfg.owners.length;
  const chan = Array.isArray(all?.channels?.whatsapp?.allowFrom) ? all.channels.whatsapp.allowFrom : [];
  out.info_channel_allowFrom_entries_not_owner = [...new Set(chan.map(e164).filter(Boolean))].filter((n) => !cfg.owners.includes(n)).length;
  const sandboxModes = [all?.agents?.defaults?.sandbox, ...(Array.isArray(all?.agents?.list) ? all.agents.list.map((a) => a?.sandbox) : []),
    ...Object.values(all?.agents?.entries ?? {}).map((a) => a?.sandbox)].filter(Boolean);
  out.info_sandbox_restricts_workspace = sandboxModes.some((s) => s.mode && s.mode !== "off" && s.workspaceAccess !== "rw");
} catch (err) {
  out.config_read = false;
  out.config_error = typeOf(err);
}

// ---- WhatsApp DM session keys per agent: byte scan of the agent session stores (+ WAL), read-only, no SQLite connection.
const dms = new Map(); // "agent\0number" -> {agent, num}
let storesRead = 0;
try {
  const agentsDir = path.join(STATE, "agents");
  for (const dir of fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir) : []) {
    for (const name of ["openclaw-agent.sqlite", "openclaw-agent.sqlite-wal"]) {
      const file = path.join(agentsDir, dir, "agent", name);
      if (!fs.existsSync(file)) continue;
      for (const m of readOnlyBytes(file).toString("latin1").matchAll(SESSION_KEY_RE)) {
        const num = e164(m[2]);
        if (num) dms.set(`${m[1]}\0${num}`, { agent: m[1], num });
      }
      storesRead += 1;
    }
  }
} catch (err) { out.sessions_error = typeOf(err); }
out.session_stores_read = storesRead;
out.whatsapp_direct_sessions = new Set([...dms.values()].map((d) => d.num)).size;
const owners = new Set(cfg?.owners ?? []);
const pairs = [...dms.values()].filter((d) => owners.has(d.num));
out.q2_owner_has_whatsapp_dm_session = pairs.length > 0;
out.q2_agents_with_owner_dm = [...new Set(pairs.map((p) => p.agent))].map(label);

// ---- Replay OpenClaw's tool assembly in a sandboxed child.
if (cfg && out.config_read) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "basht-owner-check-"));
  try {
    for (const d of ["home", "tmp", "cache", "state", "ws"]) fs.mkdirSync(path.join(sandbox, d));
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "production", BASHT_OWNER_CHECK_CHILD: "1", OPENCLAW_PACKAGE_ROOT: PKG,
      OPENCLAW_LOG_LEVEL: "silent", HOME: path.join(sandbox, "home"), TMPDIR: path.join(sandbox, "tmp"), XDG_CACHE_HOME: path.join(sandbox, "cache"),
      OPENCLAW_STATE_DIR: path.join(sandbox, "state"), OPENCLAW_WORKSPACE_DIR: path.join(sandbox, "ws"), OPENCLAW_CONFIG_PATH: path.join(sandbox, "state", "openclaw.json") };
    const { owners: ownerList, ...policyCfg } = cfg;
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env, cwd: sandbox, timeout: 120_000,
      input: JSON.stringify({ cfg: policyCfg, pairs, fallback: ownerList[0], ws: path.join(sandbox, "ws") }), stdio: ["pipe", "ignore", "ignore", "pipe"] });
    const res = JSON.parse(String(r.output?.[3] ?? "") || "{}");
    if (res.simulation_error) out.simulation_error = res.simulation_error;
    else if (!Array.isArray(res.agents)) out.simulation_error = r.error ? typeOf(r.error) : `ChildExit${r.status ?? r.signal ?? ""}`.replace(/[^A-Za-z0-9]/g, "");
    else out.agents = res.agents;
  } catch (err) {
    out.simulation_error = typeOf(err);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

const sims = out.agents ?? [];
const pass = (a) => a.flush_with_owner_identity?.read && a.flush_with_owner_identity?.write;
out.VERDICT =
  !out.config_read ? "BLOCKED: openclaw.json could not be read (see config_error)"
  : out.config_uses_include ? "BLOCKED: openclaw.json uses $include; this check reads one file only"
  : out.config_unsubstituted_env ? "BLOCKED: tool policy uses ${ENV} substitution; this check cannot resolve it"
  : out.simulation_error ? "BLOCKED: simulation failed (see simulation_error)"
  : out.q1_unrecognised_owner_entries > 0 ? "BLOCKED: commands.ownerAllowFrom has entries OpenClaw does not accept as a WhatsApp owner (run openclaw doctor)"
  : !out.q1_ownerAllowFrom_present || out.q1_explicit_whatsapp_owner_entries === 0 ? "BLOCKED: no explicit WhatsApp owner in commands.ownerAllowFrom (patch fails closed)"
  : !out.q2_owner_has_whatsapp_dm_session ? "BLOCKED: configured owner has no WhatsApp DM session (owner entry does not match the chatting number)"
  : out.info_sandbox_restricts_workspace ? "BLOCKED: a sandbox without workspaceAccess rw makes the memory flush skip"
  : sims.some((a) => a.flush_unknown_sender?.write && !a.flush_anonymous?.write) ? "BLOCKED: an unknown sender identity gets write in the flush (review toolsBySender)"
  : sims.length > 0 && sims.every(pass) ? "READY: PR #25 will recognise the owner and the flush keeps read + append-only write"
  : "BLOCKED: owner is verified but tool policy still removes read/write for the flush (see agents[].removedBy)";
finish(out);
