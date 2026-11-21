// Encrypted backup: format round-trip, tamper/wrong-key/truncation refusal, and the real wrapper route end to end
// (fake gateway, temp dirs, synthetic "secrets" only). Restore through /setup/api/import is exercised in docs/BACKUP.md's
// container drill because the import route only accepts state under /data.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildFindArgs } from "./backup.js";
import { createEncryptStream, decryptFile, keyId, loadPublicKey, readHeader } from "./backup-format.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(ROOT, "scripts", "basht-backup.mjs");
const FAKE = path.join(ROOT, "scripts", "fixtures", "fake-openclaw.mjs");
const PASSWORD = "synthetic-setup-password-for-backup-tests";
const PASSPHRASE = "synthetic-backup-passphrase-0123";
const CANARY = "SYNTHETIC-CANARY-7d1f";
const BASIC = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`;

let T; // temp root
let keys; // { dir, pub, priv }
let wrapper;
let port;
let output = "";

const tool = (args, env = {}) =>
  spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", env: { ...process.env, BASHT_BACKUP_PASSPHRASE: PASSPHRASE, ...env } });
const put = (rel, content) => {
  const p = path.join(T, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const post = (url, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${url}`, { method: "POST", headers: { authorization: BASIC, origin: `http://127.0.0.1:${port}`, ...headers } });

before(async () => {
  T = fs.mkdtempSync(path.join(os.tmpdir(), "basht-backup-test-"));
  keys = { dir: path.join(T, "keys") };
  const k = tool(["keygen", keys.dir]);
  assert.equal(k.status, 0, k.stderr);
  keys.pub = path.join(keys.dir, "basht-backup-public.pem");
  keys.priv = path.join(keys.dir, "basht-backup-private.pem");

  // synthetic production-shaped data
  put("data/.openclaw/openclaw.json", JSON.stringify({ gateway: { mode: "local" }, note: CANARY }));
  put("data/.openclaw/credentials/whatsapp/default/creds.json", JSON.stringify({ me: "+10000000000", noise: CANARY }));
  put("data/.openclaw/state/openclaw.sqlite", `SQLite format 3\0${CANARY}`);
  put("data/.openclaw/agents/main/agent/openclaw-agent.sqlite", `SQLite format 3\0${CANARY}`);
  put("data/.openclaw/cache/big.bin", "x".repeat(10_000));
  put("data/.openclaw/tmp/scratch", "tmp");
  put("data/workspace/MEMORY.md", `# memory ${CANARY}`);
  put("data/workspace/memory/2026-11-21.md", `note ${CANARY}`);
  put("data/workspace/skills/basht-daftra/SKILL.md", "synced from the image");
  put("data/workspace/exports/invoice-1-0123456789abcdef0123456789abcdef.pdf", "%PDF-1.4 synthetic");
  fs.symlinkSync("/etc/passwd", path.join(T, "data/workspace/link-to-outside"));

  port = await freePort();
  const env = { ...process.env };
  for (const k2 of Object.keys(env)) if (k2.startsWith("RAILWAY_") || k2.startsWith("OPENCLAW_") || k2.startsWith("BASHT_")) delete env[k2];
  wrapper = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...env,
      PORT: String(port),
      INTERNAL_GATEWAY_PORT: String(await freePort()),
      OPENCLAW_STATE_DIR: path.join(T, "data/.openclaw"),
      OPENCLAW_WORKSPACE_DIR: path.join(T, "data/workspace"),
      OPENCLAW_ENTRY: FAKE,
      OPENCLAW_GATEWAY_TOKEN: "synthetic-gateway-token-for-backup-tests",
      OPENCLAW_PERSONA_SEED: "0",
      SETUP_PASSWORD: PASSWORD,
      BASHT_BACKUP_PUBLIC_KEY: fs.readFileSync(keys.pub, "utf8"),
    },
  });
  wrapper.stdout.on("data", (d) => (output += d));
  wrapper.stderr.on("data", (d) => (output += d));
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/setup/healthz`);
      if ((await r.json()).gatewayReachable) return;
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

test("format: round trip; wrong key, truncation and any flipped byte are refused with no output", async () => {
  const pub = loadPublicKey(fs.readFileSync(keys.pub, "utf8"));
  const priv = crypto.createPrivateKey({ key: fs.readFileSync(keys.priv), passphrase: PASSPHRASE });
  const plain = crypto.randomBytes(200_000);
  const file = path.join(T, "unit.bkp");
  const enc = createEncryptStream(pub, { content: "unit" });
  const chunks = [];
  enc.on("data", (c) => chunks.push(c));
  enc.end(plain);
  await new Promise((r) => enc.on("end", r));
  fs.writeFileSync(file, Buffer.concat(chunks));
  assert.equal(readHeader(file).header.kid, keyId(pub));
  const out = path.join(T, "unit.out");
  await decryptFile(file, priv, out);
  assert.ok(fs.readFileSync(out).equals(plain));

  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 }).privateKey;
  await assert.rejects(decryptFile(file, other, path.join(T, "o1")), /wrong key/);
  assert.ok(!fs.existsSync(path.join(T, "o1")));

  const bytes = fs.readFileSync(file);
  for (const pos of [readHeader(file).headerBytes.length + 10, bytes.length - 1, 40]) {
    const bad = Buffer.from(bytes);
    bad[pos] ^= 0x01;
    const f = path.join(T, `bad-${pos}.bkp`);
    fs.writeFileSync(f, bad);
    await assert.rejects(decryptFile(f, priv, path.join(T, `bad-${pos}.out`)));
    assert.ok(!fs.existsSync(path.join(T, `bad-${pos}.out`)), "no output from a tampered file");
  }
  const cut = path.join(T, "cut.bkp");
  fs.writeFileSync(cut, bytes.subarray(0, bytes.length - 5000));
  await assert.rejects(decryptFile(cut, priv, path.join(T, "cut.out")));
  assert.ok(!fs.existsSync(path.join(T, "cut.out")));
});

test("keys: weak or non-RSA public keys are rejected", () => {
  const weak = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" });
  assert.throws(() => loadPublicKey(weak), /3072/);
  const ec = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  assert.throws(() => loadPublicKey(ec), /RSA/);
});

test("find args: excludes rebuildable paths and lists only files and directories", () => {
  const { roots, args } = buildFindArgs("/data/.openclaw", "/data/workspace");
  assert.deepEqual(roots, ["data/.openclaw", "data/workspace"]);
  for (const p of ["data/.openclaw/cache", "data/.openclaw/tmp", "data/workspace/skills/basht-daftra"]) assert.ok(args.includes(p));
  assert.ok(args.join(" ").includes("-type f -o -type d"));
  assert.deepEqual(buildFindArgs("/x/state", "/x/state/workspace").roots, ["x/state"], "nested workspace is not listed twice");
});

test("route: anonymous 401, cross-site 403, before anything is paused or written", async () => {
  const anon = await fetch(`http://127.0.0.1:${port}/setup/api/backup`, { method: "POST" });
  assert.equal(anon.status, 401);
  const csrf = await post("/setup/api/backup", { origin: "https://evil.example" });
  assert.equal(csrf.status, 403);
  const get = await fetch(`http://127.0.0.1:${port}/setup/api/backup`, { headers: { authorization: BASIC } });
  assert.equal(get.headers.get("x-backup-key-id"), null, "GET never triggers a backup");
  assert.ok(!/gateway paused/.test(output), "nothing was paused");
});

test("route: encrypted, consistent backup; nothing written to the volume; gateway back up; restorable archive", async () => {
  const before = fs.readdirSync(path.join(T, "data")).sort();
  const res = await post("/setup/api/backup");
  assert.equal(res.status, 200, await res.clone().text());
  assert.match(res.headers.get("content-disposition"), /basht-backup-.*\.bkp/);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(res.headers.get("x-backup-key-id"), keyId(loadPublicKey(fs.readFileSync(keys.pub, "utf8"))));
  assert.ok(!body.includes(Buffer.from(CANARY)), "ciphertext must not contain plaintext");
  assert.ok(!body.includes(Buffer.from("creds.json")), "file names are encrypted too");
  assert.deepEqual(fs.readdirSync(path.join(T, "data")).sort(), before, "no new files on the volume");
  assert.ok(/gateway paused \d+ ms/.test(output), "gateway pause is logged");

  let reachable = false;
  for (let i = 0; i < 100 && !reachable; i++) {
    reachable = (await (await fetch(`http://127.0.0.1:${port}/setup/healthz`)).json()).gatewayReachable === true;
    if (!reachable) await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(reachable, true, "gateway restarted after the backup");

  const bkp = path.join(T, "prod-shaped.bkp");
  fs.writeFileSync(bkp, body);
  const ins = tool(["inspect", bkp]);
  assert.equal(ins.status, 0, ins.stderr);
  assert.equal(JSON.parse(ins.stdout).content, "tar.gz");

  const tgz = path.join(T, "restore.tar.gz");
  const dec = tool(["decrypt", bkp, keys.priv, tgz]);
  assert.equal(dec.status, 0, dec.stderr);
  const list = spawnSync("tar", ["-tzf", tgz], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map((e) => e.replace(/\/$/, ""));
  const stateRel = path.join(T, "data/.openclaw").replace(/^\//, "");
  const wsRel = path.join(T, "data/workspace").replace(/^\//, "");
  for (const must of ["openclaw.json", "credentials/whatsapp/default/creds.json", "state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite"])
    assert.ok(list.includes(`${stateRel}/${must}`), `missing ${must}`);
  for (const must of ["MEMORY.md", "memory/2026-11-21.md", "exports/invoice-1-0123456789abcdef0123456789abcdef.pdf"])
    assert.ok(list.includes(`${wsRel}/${must}`), `missing ${must}`);
  for (const never of [`${stateRel}/cache`, `${stateRel}/tmp`, `${stateRel}/server.log`, `${wsRel}/skills/basht-daftra`, `${wsRel}/link-to-outside`])
    assert.ok(!list.some((e) => e === never || e.startsWith(never + "/")), `must not contain ${never}`);

  const pw = "synthetic-import-password";
  const zip = path.join(T, "restore.zip");
  const z = tool(["to-import-zip", tgz, zip], { BASHT_IMPORT_PASSWORD: pw });
  assert.equal(z.status, 0, z.stderr);
  // Same entry rules as /setup/api/import: every entry under the state or workspace prefix, no absolute/.. paths.
  const entries = spawnSync("unzip", ["-Z1", zip], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  for (const e of entries) {
    const n = e.replace(/\/+$/, "");
    assert.ok(!n.startsWith("/") && !n.split("/").includes(".."), e);
    assert.ok([stateRel, wsRel].some((p) => n === p || n.startsWith(p + "/")), `import would refuse entry: ${e}`);
  }
  const x = path.join(T, "unzipped");
  assert.equal(spawnSync("unzip", ["-q", "-P", pw, zip, "-d", x]).status, 0);
  const restored = fs.readFileSync(path.join(x, stateRel, "credentials/whatsapp/default/creds.json"), "utf8");
  assert.equal(restored, fs.readFileSync(path.join(T, "data/.openclaw/credentials/whatsapp/default/creds.json"), "utf8"));
  assert.equal(fs.readFileSync(path.join(x, wsRel, "MEMORY.md"), "utf8"), `# memory ${CANARY}`);
});

test("seal: a legacy export ZIP can be encrypted locally and opened only with the private key", () => {
  const legacy = path.join(T, "legacy-export.zip");
  fs.writeFileSync(legacy, `PK legacy ${CANARY}`);
  const sealed = path.join(T, "legacy-export.bkp");
  assert.equal(tool(["seal", legacy, keys.pub, sealed]).status, 0);
  assert.ok(!fs.readFileSync(sealed).includes(Buffer.from(CANARY)));
  const back = path.join(T, "legacy-back.zip");
  assert.equal(tool(["decrypt", sealed, keys.priv, back]).status, 0);
  assert.equal(fs.readFileSync(back, "utf8"), `PK legacy ${CANARY}`);
  assert.notEqual(tool(["decrypt", sealed, keys.priv, path.join(T, "x")], { BASHT_BACKUP_PASSPHRASE: "wrong-passphrase-123" }).status, 0);
});
