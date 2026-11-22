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
const canDrop = !isRoot || spawnSync("runuser", ["-u", RUN_AS, "--", process.execPath, "-e", "0"]).status === 0;
const integration = { skip: !PKG ? "set OPENCLAW_PACKAGE_ROOT to an installed openclaw@2026.10.9" : !canDrop ? `running as root and cannot drop to '${RUN_AS}'` : false };

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
  const before = snapshot([st.state, st.ws, st.home, st.tmp]);
  const cmd = isRoot ? ["runuser", ["-u", RUN_AS, "--", "env", ...Object.entries(childEnv).map(([k, v]) => `${k}=${v}`), process.execPath, CHECK]] : [process.execPath, [CHECK]];
  const r = spawnSync(cmd[0], cmd[1], { env: isRoot ? process.env : childEnv, encoding: "utf8", timeout: 180_000 });
  const after = snapshot([st.state, st.ws, st.home, st.tmp]);
  assert.equal(after, before, "the checker must not create, modify or delete any file (state, workspace, HOME, TMPDIR)");
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

test("READY on a production-like config: owner explicit, DM session present, anonymous flush has zero tools", integration, () => {
  const st = makeState();
  try {
    const { status, out } = runCheck(st);
    assert.equal(status, 0);
    assert.match(out.VERDICT, /^READY/);
    assert.equal(out.q1_explicit_whatsapp_owner_entries, 1);
    assert.equal(out.q2_owner_has_whatsapp_dm_session, true);
    assert.deepEqual([out.sim_flush_anonymous.read, out.sim_flush_anonymous.write, out.sim_flush_anonymous.tools], [false, false, 0], "reproduces the production 'No callable tools remain'");
    assert.deepEqual([out.q2q3_flush_with_owner_identity.read, out.q2q3_flush_with_owner_identity.write, out.q2q3_flush_with_owner_identity.tools], [true, true, 2], "owner flush keeps exactly read + write");
    assert.equal(out.security_flush_unknown_sender.write, false);
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
    assert.ok(out.q2q3_flush_with_owner_identity.removedBy.write.length > 0);
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
