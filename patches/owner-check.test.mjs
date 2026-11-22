// Tests for patches/owner-check.mjs with SYNTHETIC state only (no production data, no network).
//   OPENCLAW_PACKAGE_ROOT=<installed openclaw@2026.10.9> node --test patches/owner-check.test.mjs
// Every run asserts: exactly one output line, empty stderr, no 7+ digit run, no synthetic secret, and a byte-identical
// filesystem (state dir, workspace, HOME, /tmp entries) before vs after. The checker refuses root, so when the test
// itself runs as root it executes the checker as an unprivileged user via runuser (skips if that is impossible).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, "owner-check.mjs");
const PKG = process.env.OPENCLAW_PACKAGE_ROOT;
const OWNER = "+15550001234";       // synthetic
const OTHER = "+15550009876";       // synthetic
const SECRETS = ["SYNTHETIC-SECRET-API-KEY-7f3a", "SYNTHETIC-GATEWAY-TOKEN-91bc", "SYNTHETIC-ENV-SECRET-44de"];
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const RUN_AS = process.env.OWNER_CHECK_TEST_USER || "nobody";
// As root, the checker runs as RUN_AS, which must be able to execute node, read the checker and read the OpenClaw install.
const canDrop = !isRoot || (PKG && spawnSync("runuser", ["-u", RUN_AS, "--", process.execPath, "-e",
  "const fs=require('fs');for(const f of process.argv.slice(1))fs.accessSync(f,fs.constants.R_OK)", CHECK, path.join(PKG, "package.json"),
  path.join(PKG, "dist", "agent-tools-Bpi7xWYy.mjs")]).status === 0);
const integration = { skip: !PKG ? "set OPENCLAW_PACKAGE_ROOT to an installed openclaw@2026.10.9" : !canDrop ? `running as root and '${RUN_AS}' cannot run node or read the OpenClaw install` : false };

const BASE_CONFIG = {
  gateway: { auth: { token: SECRETS[1] } },
  models: { providers: { fake: { apiKey: SECRETS[0], baseUrl: "http://127.0.0.1:1/v1" } } },
  commands: { ownerAllowFrom: [`whatsapp:${OWNER}`] },
  tools: { profile: "coding", toolsBySender: { [`e164:${OWNER}`]: {}, "*": { deny: ["*"] } } },   // production-like: anonymous = 0 tools
  agents: { entries: { main: { tools: { allow: ["*", "message", "browser"] } } } },
  channels: { whatsapp: { dmPolicy: "allowlist", allowFrom: [OWNER, OTHER], authDir: "/data/.openclaw/credentials/whatsapp/default" } },
};

/** Synthetic state: openclaw.json + a fake session store that only needs to contain the session-key bytes. */
function makeState({ config = BASE_CONFIG, configText, sessionNumbers = [OWNER], wal = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-test-state-"));
  const state = path.join(root, "state"), ws = path.join(root, "ws"), home = path.join(root, "home"), tmp = path.join(root, "tmp");
  fs.mkdirSync(path.join(state, "agents", "main", "agent"), { recursive: true });
  fs.mkdirSync(ws); fs.mkdirSync(home); fs.mkdirSync(tmp);
  fs.writeFileSync(path.join(state, "openclaw.json"), configText ?? JSON.stringify(config, null, 2));
  const blob = Buffer.concat([crypto.randomBytes(4096), ...sessionNumbers.map((n) => Buffer.from(`\u0000agent:main:whatsapp:direct:${n}\u0000`)), crypto.randomBytes(4096)]);
  fs.writeFileSync(path.join(state, "agents", "main", "agent", wal ? "openclaw-agent.sqlite-wal" : "openclaw-agent.sqlite"), blob);
  fs.writeFileSync(path.join(ws, "MEMORY.md"), "# synthetic\n");
  if (isRoot) spawnSync("chown", ["-R", `${RUN_AS}:`, root]);
  return { root, state, ws, home, tmp };
}

function snapshot(dirs) {
  const rows = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { rows.push(`D ${p}`); walk(p); }
      else { const s = fs.lstatSync(p); rows.push(`F ${p} ${s.size} ${s.mtimeMs} ${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`); }
    }
  };
  for (const d of dirs) walk(d);
  return rows.sort().join("\n");
}

function runCheck(st, { env = {}, pkg = PKG } = {}) {
  // A private TMPDIR (instead of the shared /tmp, where concurrent processes create entries) makes the sandbox-cleanup
  // assertion deterministic: it must be empty again after the run.
  const childEnv = { PATH: process.env.PATH, HOME: st.home, TMPDIR: st.tmp, OPENCLAW_STATE_DIR: st.state, OPENCLAW_WORKSPACE_DIR: st.ws, OPENCLAW_PACKAGE_ROOT: pkg,
    GH_TOKEN: SECRETS[2], AWJ_API_KEY: SECRETS[2], ...env };
  const extra = st.extraDirs ?? [];
  const logDir = sharedLogDirOwnedByRunUser();
  const before = snapshot([st.state, st.ws, st.home, st.tmp, ...extra, ...(logDir ? [logDir] : [])]);
  const cmd = isRoot ? ["runuser", ["-u", RUN_AS, "--", "env", ...Object.entries(childEnv).map(([k, v]) => `${k}=${v}`), process.execPath, CHECK]] : [process.execPath, [CHECK]];
  const r = spawnSync(cmd[0], cmd[1], { env: isRoot ? process.env : childEnv, encoding: "utf8", timeout: 180_000 });
  const after = snapshot([st.state, st.ws, st.home, st.tmp, ...extra, ...(logDir ? [logDir] : [])]);
  assert.equal(after, before, "the checker must not create, modify or delete any file (state, workspace, HOME, TMPDIR, extra dirs, /tmp/openclaw logs)");
  assert.deepEqual(fs.readdirSync(st.tmp), [], "the checker's sandbox under TMPDIR is removed");
  assert.equal(r.stderr, "", "stderr must be empty");
  const lines = r.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `exactly one output line, got: ${lines.length}`);
  assert.match(lines[0], /^BASHT_OWNER_CHECK \{/);
  assert.ok(!/\d{7,}/.test(lines[0]), "no phone-number-like digit run in the output");
  for (const s of SECRETS) assert.ok(!lines[0].includes(s), `secret leaked: ${s}`);
  for (const s of ["credentials", "authDir", "apiKey", "token"]) assert.ok(!lines[0].includes(s), `config detail leaked: ${s}`);
  return { status: r.status, out: JSON.parse(lines[0].slice("BASHT_OWNER_CHECK ".length)) };
}

const cleanup = (st) => fs.rmSync(st.root, { recursive: true, force: true });

/**
 * F1: OpenClaw's file logger always uses /tmp/openclaw (TMPDIR is ignored); in production that directory belongs to the
 * gateway user and holds the live gateway log. When the run user can own it here, make it exist (as it does in
 * production) and include it in the snapshot so any appended log line fails the test.
 */
function sharedLogDirOwnedByRunUser() {
  const dir = "/tmp/openclaw";
  const uid = isRoot ? Number(spawnSync("id", ["-u", RUN_AS], { encoding: "utf8" }).stdout.trim()) : process.getuid?.();
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { mode: 0o700 });
      if (isRoot) fs.chownSync(dir, uid, -1);
    }
    const st = fs.statSync(dir);
    if (st.uid !== uid) return undefined;
    const log = path.join(dir, `openclaw-${new Date().toISOString().slice(0, 10)}.log`);
    if (!fs.existsSync(log)) { fs.writeFileSync(log, "pre-existing gateway log line\n", { mode: 0o600 }); if (isRoot) fs.chownSync(log, uid, -1); }
    return dir;
  } catch { return undefined; }
}

/** F2: a real WAL-mode SQLite database (as the gateway keeps open) that the checker must never open. */
async function makeWalDb(dir) {
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "openclaw-agent.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES ('agent:main:whatsapp:direct:+15550001234');");
  db.close();
  fs.writeFileSync(path.join(dir, "auth-profiles.json"), JSON.stringify({ token: SECRETS[0] }));
  if (isRoot) spawnSync("chown", ["-R", `${RUN_AS}:`, dir]);
}

test("READY on a production-like config: owner explicit, DM session present, anonymous flush has zero tools", integration, () => {
  const st = makeState();
  try {
    const { status, out } = runCheck(st);
    assert.equal(status, 0);
    assert.match(out.VERDICT, /^READY/);
    assert.equal(out.q1_explicit_whatsapp_owner_entries, 1);
    assert.equal(out.q2_owner_has_whatsapp_dm_session, true);
    const [a] = out.agents;
    assert.equal(a.agent, "main");
    assert.deepEqual([a.flush_anonymous.read, a.flush_anonymous.write, a.flush_anonymous.tools], [false, false, 0], "reproduces the production 'No callable tools remain'");
    assert.deepEqual([a.flush_with_owner_identity.read, a.flush_with_owner_identity.write, a.flush_with_owner_identity.tools], [true, true, 2], "owner flush keeps exactly read + write");
    assert.equal(a.flush_unknown_sender.write, false);
    assert.equal(out.info_channel_allowFrom_entries_not_owner, 1, "channel allowFrom entry that is not the owner is counted, never shown");
  } finally { cleanup(st); }
});

test("BLOCKED when ownerAllowFrom is missing, wildcard-only, or only another channel", integration, () => {
  for (const ownerAllowFrom of [undefined, ["*"], ["telegram:12345"]]) {
    const st = makeState({ config: { ...BASE_CONFIG, commands: ownerAllowFrom ? { ownerAllowFrom } : {} } });
    try {
      const { out } = runCheck(st);
      assert.match(out.VERDICT, /^BLOCKED: no explicit WhatsApp owner/, JSON.stringify(ownerAllowFrom));
      assert.equal(out.q1_explicit_whatsapp_owner_entries, 0);
      if (ownerAllowFrom?.[0] === "*") assert.equal(out.q1_wildcard_entry_present, true);
    } finally { cleanup(st); }
  }
});

test("BLOCKED when the configured owner never chatted (no matching DM session)", integration, () => {
  const st = makeState({ sessionNumbers: [OTHER] });
  try {
    const { out } = runCheck(st);
    assert.match(out.VERDICT, /^BLOCKED: configured owner has no WhatsApp DM session/);
    assert.equal(out.whatsapp_direct_sessions, 1);
  } finally { cleanup(st); }
});

test("BLOCKED when tool policy removes write even for the verified owner", integration, () => {
  const st = makeState({ config: { ...BASE_CONFIG, agents: { entries: { main: { tools: { allow: ["*"], deny: ["write"] } } } } } });
  try {
    const { out } = runCheck(st);
    assert.match(out.VERDICT, /^BLOCKED: owner is verified but tool policy still removes/);
    assert.ok(out.agents[0].flush_with_owner_identity.removedBy.write.length > 0);
  } finally { cleanup(st); }
});

test("reads JSON5 config and WAL-only session stores; refuses $include", integration, () => {
  const json5 = `// synthetic\n{ commands: { ownerAllowFrom: ['whatsapp:${OWNER}',], }, tools: { profile: 'coding', }, }\n`;
  let st = makeState({ configText: json5, wal: true });
  try { assert.match(runCheck(st).out.VERDICT, /^READY/); } finally { cleanup(st); }
  st = makeState({ config: { ...BASE_CONFIG, $include: "./extra.json5" } });
  try { assert.match(runCheck(st).out.VERDICT, /^BLOCKED: openclaw.json uses \$include/); } finally { cleanup(st); }
});

test("fails closed on unreadable config and on a different OpenClaw version", integration, () => {
  const st = makeState();
  try {
    fs.rmSync(path.join(st.state, "openclaw.json"));
    assert.match(runCheck(st).out.VERDICT, /^BLOCKED: openclaw.json could not be read/);
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), "oc-test-pkg-"));
    fs.writeFileSync(path.join(fake, "package.json"), JSON.stringify({ version: "2026.11.1" }));
    if (isRoot) spawnSync("chown", ["-R", `${RUN_AS}:`, fake]);
    const { status, out } = runCheck(st, { pkg: fake });
    assert.equal(status, 3);
    assert.match(out.VERDICT, /^REFUSED: expected OpenClaw 2026\.10\.9/);
    fs.rmSync(fake, { recursive: true, force: true });
  } finally { cleanup(st); }
});

test("F1: OpenClaw's shared /tmp/openclaw gateway log is not appended to", { ...integration, skip: integration.skip || (!sharedLogDirOwnedByRunUser() ? "/tmp/openclaw belongs to another user here (covered in CI)" : false) }, () => {
  const st = makeState();
  try { assert.match(runCheck(st).out.VERDICT, /^READY/); } finally { cleanup(st); } // runCheck snapshots /tmp/openclaw
});

test("F2: agentDir / session.store pointing at a live WAL database are never opened or touched", integration, async () => {
  const st = makeState();
  const dbDir = path.join(st.root, "live-agent");
  try {
    await makeWalDb(dbDir);
    const config = { ...BASE_CONFIG, session: { store: path.join(dbDir, "sessions.json") },
      agents: { entries: { main: { agentDir: dbDir, workspace: dbDir, tools: { allow: ["*", "message", "browser"] } } } } };
    fs.writeFileSync(path.join(st.state, "openclaw.json"), JSON.stringify(config));
    if (isRoot) spawnSync("chown", ["-R", `${RUN_AS}:`, st.root]);
    st.extraDirs = [dbDir];
    const { out } = runCheck(st);                        // snapshot includes dbDir: no -wal/-shm may appear
    assert.match(out.VERDICT, /^READY/);
    assert.ok(!fs.existsSync(path.join(dbDir, "openclaw-agent.sqlite-shm")), "no SQLite side files created");
  } finally { cleanup(st); }
});

test("F3: every agent that holds the owner's DM is simulated; a non-main agent that denies write is BLOCKED", integration, () => {
  const st = makeState({ sessionNumbers: [] });
  try {
    fs.mkdirSync(path.join(st.state, "agents", "ops", "agent"), { recursive: true });
    fs.writeFileSync(path.join(st.state, "agents", "ops", "agent", "openclaw-agent.sqlite"), Buffer.from(`\u0000agent:ops:whatsapp:direct:${OWNER}\u0000`));
    const config = { ...BASE_CONFIG, agents: { entries: { main: { tools: { allow: ["*"] } }, ops: { tools: { allow: ["*"], deny: ["write"] } } } } };
    fs.writeFileSync(path.join(st.state, "openclaw.json"), JSON.stringify(config));
    if (isRoot) spawnSync("chown", ["-R", `${RUN_AS}:`, st.root]);
    const { out } = runCheck(st);
    assert.deepEqual(out.q2_agents_with_owner_dm, ["ops"]);
    assert.equal(out.agents[0].agent, "ops");
    assert.match(out.VERDICT, /^BLOCKED: owner is verified but tool policy still removes/);
  } finally { cleanup(st); }
});

test("F4: owner entries OpenClaw would not accept (legacy user: form, ${ENV}) fail closed", integration, () => {
  for (const entry of [`whatsapp:user:${OWNER}`, "${OWNER_NUMBER}", `whatsapp:${OWNER.slice(0, 4)} ${OWNER.slice(4)}`]) {
    const st = makeState({ config: { ...BASE_CONFIG, commands: { ownerAllowFrom: [entry] } } });
    try {
      const { out } = runCheck(st);
      assert.match(out.VERDICT, /^BLOCKED: commands.ownerAllowFrom has entries OpenClaw does not accept/, entry);
    } finally { cleanup(st); }
  }
  const st = makeState({ config: { ...BASE_CONFIG, tools: { ...BASE_CONFIG.tools, deny: ["${DENY}"] } } });
  try { assert.match(runCheck(st).out.VERDICT, /^BLOCKED: tool policy uses \$\{ENV\}/); } finally { cleanup(st); }
});

test("F5: malformed config values never produce a stack trace or a second output line", integration, () => {
  for (const allowFrom of ["+15550001234", { a: 1 }, 42]) {
    const st = makeState({ config: { ...BASE_CONFIG, channels: { whatsapp: { allowFrom } }, agents: { list: "not-a-list", entries: 5 } } });
    try { runCheck(st); } finally { cleanup(st); }       // runCheck asserts: one line, empty stderr, no leaks
  }
});

test("F6: session keys embedded in other keys or free text are not counted as DM sessions", integration, () => {
  const st = makeState({ sessionNumbers: [] });
  try {
    fs.writeFileSync(path.join(st.state, "agents", "main", "agent", "openclaw-agent.sqlite"),
      Buffer.from(`xagent:main:whatsapp:direct:${OWNER}:thread:9 and agent:main:whatsapp:direct:${OWNER}:topic:2 and agent:main:whatsapp:direct:${OWNER}1234`));
    if (isRoot) spawnSync("chown", ["-R", `${RUN_AS}:`, st.root]);
    const { out } = runCheck(st);
    // The ":thread:"/":topic:" keys and the prefixed key are not DMs; "+…1234" is a different (longer) number, not the owner.
    assert.equal(out.q2_owner_has_whatsapp_dm_session, false);
    assert.equal(out.whatsapp_direct_sessions, 1, "only the different 15-digit number is a well-formed DM key");
    assert.match(out.VERDICT, /^BLOCKED: configured owner has no WhatsApp DM session/);
  } finally { cleanup(st); }
});

test("F7: secrets in tools/agents sections stay in the parent (only policy fields reach the child)", integration, () => {
  const config = { ...BASE_CONFIG, tools: { ...BASE_CONFIG.tools, web: { search: { apiKey: SECRETS[0] } } },
    agents: { defaults: { memorySearch: { remote: { apiKey: SECRETS[1] } } }, entries: BASE_CONFIG.agents.entries } };
  const st = makeState({ config });
  try { assert.match(runCheck(st).out.VERDICT, /^READY/); } finally { cleanup(st); }
  const src = fs.readFileSync(CHECK, "utf8");
  assert.match(src, /const POLICY_KEYS = \["profile", "allow", "alsoAllow", "deny"\];/, "child receives only allowlisted policy keys");
  assert.match(src, /OPENCLAW_LOG_LEVEL: "silent"/, "child logging silenced (F1)");
});

test("refuses to run as root", { skip: !isRoot ? "not running as root" : false }, () => {
  const r = spawnSync(process.execPath, [CHECK], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /REFUSED: run as the gateway user/);
});

test("static: the checker never invokes the OpenClaw CLI, never opens SQLite, never writes outside its sandbox", () => {
  const src = fs.readFileSync(CHECK, "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(!/dist\/entry\.js|openclaw\.mjs|["']config["'],\s*["']get|["']sessions["']/.test(src), "no OpenClaw CLI invocation");
  assert.ok(!/node:sqlite|DatabaseSync|better-sqlite/.test(src), "no SQLite connection");
  assert.ok(!/writeFileSync|appendFileSync|createWriteStream|renameSync|unlinkSync|copyFileSync|chmodSync|chownSync/.test(src), "no file writes");
  const rm = [...src.matchAll(/rmSync\(([^,)]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(rm, ["sandbox"], "the only deletion is the checker's own sandbox");
  assert.match(src, /O_RDONLY/, "production files are opened read-only");
  assert.match(src, /stdio: \["pipe", "ignore", "ignore", "pipe"\]/, "child stdout/stderr discarded; result on a private pipe");
});
