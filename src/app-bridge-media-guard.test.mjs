// BASHT app bridge, batch 2: what the app can download. Pins the roots and the type allowlist (so nothing widens silently) and the
// initial protected-path guard (memory, config and credential files are never listed or served), for BOTH listing (checkMediaFile) and
// serving (openMediaFile), plus the legitimate flows that must keep working. A temp tree whose engine root itself sits under a hidden
// directory (like /data/.openclaw) proves the guard looks only below the root.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { APP_SESSION_KEY, createAppBridge } from "./app-bridge.js";
import { MAX_MEDIA_BYTES, MEDIA_TYPES, PROTECTED_DIRS, PROTECTED_FILES, PROTECTED_STEMS, PROTECTED_WORDS, SECRET_SCAN_BYTES, _testHooks, checkMediaFile, cleanLiveText, extractMedia, isProtectedRelPath, mediaRoots, openMediaFile, splitAttachedMarkers, splitMediaLines } from "./app-bridge-media.js";

const APP_TOKEN = "synthetic-app-token-0123456789abcdef0123";
const GW_TOKEN = "synthetic-gateway-token-0123456789abcdef";
const PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(40, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(40, 3)]);
const WEBP = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBP", "latin1"), Buffer.alloc(30)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(40, 3)]);
const PDF = Buffer.from("%PDF-1.4\n%%EOF\n");
const ZIP = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(60, 5)]);
const MP3 = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.alloc(60, 6)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypmp42", "latin1"), Buffer.alloc(40, 7)]);
const OGG = Buffer.concat([Buffer.from("OggS", "latin1"), Buffer.alloc(40, 8)]);
const WAV = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WAVE", "latin1"), Buffer.alloc(30)]);
const TEXT = "تقرير\nline two\n";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n";

let base, ws, stateDir, outside, ctx, ownHome, savedHome;
const w = (rel, data, root = ws) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };

before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "app-bridge-guard-")));
  // the engine's own folders live under a hidden directory, as /data/.openclaw does in production
  ws = path.join(base, ".openclaw", "workspace"); stateDir = path.join(base, ".openclaw", "state"); outside = path.join(base, "outside");
  fs.mkdirSync(ws, { recursive: true }); fs.mkdirSync(path.join(stateDir, "media", "inbound"), { recursive: true }); fs.mkdirSync(outside, { recursive: true });
  ctx = { workspaceDir: ws, stateDir, roots: mediaRoots(ws, stateDir) };
  // legitimate
  for (const [n, b] of [["photo.png", PNG], ["PHOTO.JPG", JPEG], ["pic.jpeg", JPEG], ["a.webp", WEBP], ["a.gif", GIF], ["a.heic", HEIC], ["doc.pdf", PDF], ["REPORT.PDF", PDF],
    ["doc.docx", ZIP], ["sheet.xlsx", ZIP], ["deck.pptx", ZIP], ["data.csv", TEXT], ["data.json", '{"a":1}'], ["notes.md", TEXT], ["notes.txt", TEXT], ["REPORT.MD", TEXT],
    ["a.mp3", MP3], ["a.m4a", MP4], ["a.mp4", MP4], ["a.ogg", OGG], ["a.wav", WAV],
    ["out/chart.png", PNG], ["out/summary.md", TEXT], ["reports/2026/q1.csv", TEXT], ["reports/2026/q1.json", '{"rows":[]}'],
    // names that only look like protected ones
    ["tokenizer-notes.md", TEXT], ["secretary.md", TEXT], ["authors.md", TEXT], ["memoryless.md", TEXT], ["docs/membership.md", TEXT], ["passwordless.txt", TEXT],
    ["cert.txt", "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"], ["pub.txt", "-----BEGIN PUBLIC KEY-----\nMFww\n-----END PUBLIC KEY-----\n"],
    ["short.txt", "sk-abc and Bearer abc and ghp_short and AKIA123"], ["authority/readme.md", TEXT], ["usermanual.md", TEXT]]) w(n, b);
  w("inbound/photo---1.jpg", JPEG, path.join(stateDir, "media")); w("outbound/gen.png", PNG, path.join(stateDir, "media")); w("tool-speech-synthesis/voice---1.mp3", MP3, path.join(stateDir, "media"));
  fs.writeFileSync(path.join(stateDir, "media", "inbound", "abc123"), JPEG); // an id with no extension (served only with a recorded image type)
  // protected
  for (const [n, b] of [["MEMORY.md", TEXT], ["notes/MEMORY.md", TEXT], ["Memory.MD", TEXT], ["memory/2026-11-28.md", TEXT], ["Memories/x.md", TEXT], ["dreams/a.md", TEXT], ["dreaming/a.md", TEXT],
    [".env.json", "{}"], [".hidden/notes.md", TEXT], ["sub/.secret.txt", TEXT], [".git/config.txt", TEXT], [".openclaw/openclaw.json", "{}"], ["openclaw.json", "{}"],
    ["auth-profiles.json", "{}"], ["auth.json", "{}"], ["credentials.json", "{}"], ["credentials/x.json", "{}"], ["secrets.json", "{}"], ["secrets/a.md", TEXT], ["auth/a.md", TEXT],
    ["backups/a.md", TEXT], ["node_modules/p/readme.md", TEXT], ["config.json", "{}"], ["settings.json", "{}"], ["SOUL.md", TEXT], ["USER.md", TEXT], ["IDENTITY.md", TEXT],
    ["AGENTS.md", TEXT], ["TOOLS.md", TEXT], ["HEARTBEAT.md", TEXT], ["BOOTSTRAP.md", TEXT], ["DREAMS.md", TEXT], ["nested/deep/soul.md", TEXT],
    ["my-token.json", "{}"], ["db_password.txt", TEXT], ["API_KEY.txt", TEXT], ["my.apikey.md", TEXT], ["private-key.md", TEXT], ["private_key.txt", TEXT], ["privatekey.txt", TEXT],
    ["the secret plan.md", TEXT], ["tokens.csv", TEXT], ["credential.txt", TEXT], ["auth-profile.md", TEXT], ["passwords.md", TEXT], ["Secret.TXT", TEXT],
    ["pem-note.txt", PEM], ["head.md", `# notes\nkey: sk-ant-api03-${"A".repeat(40)}\n`], ["ant-short.md", `sk-ant-${"Z9".repeat(11)}`], ["openai.txt", `sk-${"a1B2".repeat(10)}`], ["gh.json", `{"t":"ghp_${"a".repeat(36)}"}`],
    ["pat.txt", `github_pat_${"A1_".repeat(20)}`], ["aws.csv", "id,AKIAABCDEFGHIJKLMNOP"], ["slack.md", `xoxb-${"1".repeat(12)}-${"a".repeat(12)}`],
    ["jwt.txt", `Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk`]]) w(n, b);
  w("memory-store/x.md", TEXT); // `memory-store` is not the directory `memory`: allowed, see the test
  // links: an allowed name pointing at a protected file or directory (the real path is what is judged)
  fs.symlinkSync(path.join(ws, "MEMORY.md"), path.join(ws, "innocent.md"));
  fs.symlinkSync(path.join(ws, "memory"), path.join(ws, "linkdir"));
  fs.symlinkSync(path.join(ws, ".openclaw", "openclaw.json"), path.join(ws, "settings-copy.json"));
  fs.symlinkSync(path.join(ws, "pem-note.txt"), path.join(ws, "readme-link.txt"));
  fs.symlinkSync(path.join(ws, "notes.md"), path.join(ws, "ok-link.md")); // a link to an allowed file stays allowed
  w("secret.txt", "x", outside); fs.symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "escape.txt"));
  ownHome = ws; savedHome = process.env.HOME; process.env.HOME = ownHome; // `~/x` resolves inside the workspace
  w("home-note.md", TEXT);
});
after(() => { process.env.HOME = savedHome; fs.rmSync(base, { recursive: true, force: true }); });

/** open and check must agree; returns whether the file is served. */
async function served(src, hint) {
  const o = await openMediaFile(src, { ...ctx, hint });
  const c = checkMediaFile(src, { ...ctx, hint });
  await o.fh?.close();
  assert.equal(c.ok, !o.error, `listing and serving disagree for ${src} (${JSON.stringify(o.error)})`);
  return !o.error;
}

// ------------------------------------------------------------------ pins: roots and allowlist -----------------------------------------

test("pin: the roots a file may come from are the workspace and <stateDir>/media, nothing else", () => {
  assert.deepEqual(mediaRoots(ws, stateDir)(), [fs.realpathSync(ws), fs.realpathSync(path.join(stateDir, "media"))]);
  assert.deepEqual(mediaRoots(ws, undefined)(), [fs.realpathSync(ws)]);
  assert.deepEqual(mediaRoots(undefined, stateDir)(), [fs.realpathSync(path.join(stateDir, "media"))]);
  assert.deepEqual(mediaRoots(undefined, undefined)(), []);
  assert.equal(MAX_MEDIA_BYTES, 20 * 1024 * 1024);
});

test("pin: the type allowlist (extension -> content type, inline-viewable) is exactly this", () => {
  assert.deepEqual(MEDIA_TYPES, {
    ".png": ["image/png", true], ".jpg": ["image/jpeg", true], ".jpeg": ["image/jpeg", true], ".gif": ["image/gif", true], ".webp": ["image/webp", true],
    ".heic": ["image/heic", false], ".heif": ["image/heif", false], ".pdf": ["application/pdf", false], ".txt": ["text/plain", false], ".md": ["text/markdown", false],
    ".csv": ["text/csv", false], ".json": ["application/json", false],
    ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", false],
    ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", false],
    ".pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation", false],
    ".mp3": ["audio/mpeg", false], ".m4a": ["audio/mp4", false], ".ogg": ["audio/ogg", false], ".wav": ["audio/wav", false], ".mp4": ["video/mp4", false],
  });
  assert.ok(!(".svg" in MEDIA_TYPES) && !(".html" in MEDIA_TYPES) && !(".js" in MEDIA_TYPES) && !(".sh" in MEDIA_TYPES));
});

test("pin: the protected-path lists", () => {
  assert.deepEqual([...PROTECTED_DIRS], ["memory", "memories", "dreams", "dreaming", "credentials", "secrets", "auth", "backups", "node_modules", ".openclaw"]);
  assert.deepEqual([...PROTECTED_FILES], ["memory.md", "soul.md", "user.md", "identity.md", "agents.md", "tools.md", "heartbeat.md", "bootstrap.md", "boot.md", "dreams.md",
    "openclaw.json", "auth.json", "auth-profiles.json", "credentials.json", "secrets.json", "config.json", "settings.json"]);
  assert.deepEqual([...PROTECTED_STEMS], ["env", "dotenv", "cookies", "wallet", "keys", "session", "id_rsa", "id_ed25519", "passwd"]);
  assert.equal(SECRET_SCAN_BYTES, 64 * 1024);
  assert.deepEqual([...PROTECTED_WORDS], ["secret", "secrets", "credential", "credentials", "token", "tokens", "password", "passwords", "apikey", "api-key", "api_key",
    "privatekey", "private-key", "private_key", "auth-profile", "auth-profiles"]);
});

// ------------------------------------------------------------------ legitimate flows --------------------------------------------------

test("legitimate files are listed and served: images, documents, reports, audio, video, the media store", async () => {
  const names = ["photo.png", "PHOTO.JPG", "pic.jpeg", "a.webp", "a.gif", "a.heic", "doc.pdf", "REPORT.PDF", "doc.docx", "sheet.xlsx", "deck.pptx", "data.csv", "data.json", "notes.md",
    "notes.txt", "REPORT.MD", "a.mp3", "a.m4a", "a.mp4", "a.ogg", "a.wav", "out/chart.png", "out/summary.md", "reports/2026/q1.csv", "reports/2026/q1.json",
    "tokenizer-notes.md", "secretary.md", "authors.md", "memoryless.md", "docs/membership.md", "passwordless.txt", "cert.txt", "pub.txt", "short.txt", "authority/readme.md",
    "usermanual.md", "ok-link.md", "memory-store/x.md"];
  for (const n of names) assert.equal(await served(n), true, `relative ${n}`);
  for (const n of ["photo.png", "out/summary.md", "reports/2026/q1.csv"]) assert.equal(await served(path.join(ws, n)), true, `absolute ${n}`);
  assert.equal(await served("~/home-note.md"), true, "~/ inside the roots");
  assert.equal(await served("media://inbound/photo---1.jpg"), true, "the inbound store");
  assert.equal(await served(path.join(stateDir, "media", "outbound", "gen.png")), true, "the outbound store");
  assert.equal(await served(path.join(stateDir, "media", "tool-speech-synthesis", "voice---1.mp3")), true, "the speech store");
  assert.equal(await served("media://inbound/abc123", "image/jpeg"), true, "an id with no extension and a recorded image type");
  // the size reported is the file's
  assert.equal(checkMediaFile("photo.png", ctx).size, PNG.length);
});

test("legitimate flows through extractMedia: inline image blocks and __openclaw.media image facts still list and serve", async () => {
  const k = APP_SESSION_KEY;
  const inline = extractMedia({ role: "user", content: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }], __openclaw: { id: "msg-guard-0001" } }, k);
  assert.deepEqual([inline.media[0].avail, inline.media[0].mime], [true, "image/png"]);
  const fact = extractMedia({ role: "user", content: [{ type: "image", mimeType: "image/jpeg", omitted: true, bytes: 5 }], __openclaw: { id: "msg-guard-0002",
    media: [{ path: "media://inbound/photo---1.jpg", url: "media://inbound/photo---1.jpg", contentType: "image/jpeg", kind: "image" }] } }, k);
  assert.equal(fact.media.length, 1);
  assert.equal(await served(fact.media[0].file, fact.media[0].hint), true);
});

// ------------------------------------------------------------------ protected files ---------------------------------------------------

test("protected files are refused by listing AND serving, however the reference names them", async () => {
  const refused = ["MEMORY.md", "notes/MEMORY.md", "Memory.MD", "memory/2026-11-28.md", "Memories/x.md", "dreams/a.md", "dreaming/a.md", ".env.json", ".hidden/notes.md", "sub/.secret.txt",
    ".git/config.txt", ".openclaw/openclaw.json", "openclaw.json", "auth-profiles.json", "auth.json", "credentials.json", "credentials/x.json", "secrets.json", "secrets/a.md", "auth/a.md",
    "backups/a.md", "node_modules/p/readme.md", "config.json", "settings.json", "SOUL.md", "USER.md", "IDENTITY.md", "AGENTS.md", "TOOLS.md", "HEARTBEAT.md", "BOOTSTRAP.md", "DREAMS.md",
    "nested/deep/soul.md", "my-token.json", "db_password.txt", "API_KEY.txt", "my.apikey.md", "private-key.md", "private_key.txt", "privatekey.txt", "the secret plan.md", "tokens.csv",
    "credential.txt", "auth-profile.md", "passwords.md", "Secret.TXT", "pem-note.txt", "head.md", "ant-short.md", "openai.txt", "gh.json", "pat.txt", "aws.csv", "slack.md", "jwt.txt",
    // links: the real path is what counts
    "innocent.md", "linkdir/2026-11-28.md", "settings-copy.json", "readme-link.txt",
    // not a protected-path matter, but still never served
    "escape.txt", "missing.md"];
  for (const n of refused) {
    assert.equal(await served(n), false, `relative ${n}`);
    assert.equal(await served(path.join(ws, n)), false, `absolute ${n}`);
  }
  assert.equal(await served("~/MEMORY.md"), false);
  // the guard refuses without a reason: the same result as a file that is not there
  assert.deepEqual(await openMediaFile("MEMORY.md", ctx), await openMediaFile("missing.md", ctx));
  assert.deepEqual(await openMediaFile("pem-note.txt", ctx), { error: "unavailable" });
  // under the media store too
  w("memory/x.md", TEXT, path.join(stateDir, "media")); w(".hidden.png", PNG, path.join(stateDir, "media")); w("my-token.json", "{}", path.join(stateDir, "media"));
  for (const n of ["memory/x.md", ".hidden.png", "my-token.json"]) assert.equal(await served(path.join(stateDir, "media", n)), false, n);
  w("secrets.json", "{}", path.join(stateDir, "media", "inbound"));
  assert.equal(await served("media://inbound/secrets.json"), false);
});

test("isProtectedRelPath: segments, names and whole words", () => {
  for (const p of ["a/.b", ".a", "MEMORY.MD", "x/Memory/y.md", "a/AUTH/b.txt", "api-key.txt", "x_token_y.json", "TOKEN.md", "my token.md", "Credentials.JSON", "private_key.pem.txt", "MEMORY.md.txt", "memory.md.bak.txt", "x.soul.md.old", "boot.md", "env.txt", "ID_RSA.md", "id_ed25519.pub.txt", "Session.JSON", "wallet.json", "keys.csv", "cookies.txt", "passwd.txt",
    "accesstoken.txt", "accessToken.json", "gatewaytoken.txt", "apiKey.json", "MyToken.json", "mytoken.json", "db-secret1.txt"]) assert.equal(isProtectedRelPath(p), true, p);
  for (const p of ["tokenizer-notes.md", "secretary.md", "passwordless.txt", "authors.md", "memory-store/x.md", "memoryless.md", "usermanual.md", "a/b.png", "out/report-2026.json"]) assert.equal(isProtectedRelPath(p), false, p);
  assert.equal(isProtectedRelPath(""), true);
});

test("the guard looks below the root only: a root that itself lies under hidden or protected-looking folders still serves its ordinary files", async () => {
  assert.ok(ws.includes(`${path.sep}.openclaw${path.sep}`), "the fixture root is under a hidden directory");
  assert.equal(await served("notes.md"), true);
});

// ------------------------------------------------------------------ the route -----------------------------------------------------------

let server, gateway, rows = [], url;
before(async () => {
  gateway = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      const { tool } = JSON.parse(body || "{}");
      if (tool === "sessions_history") return res.end(JSON.stringify({ ok: true, result: { details: { sessionKey: APP_SESSION_KEY, hasMore: false, messages: rows } } }));
      if (tool === "sessions_list") return res.end(JSON.stringify({ ok: true, result: { details: { sessions: [{ key: APP_SESSION_KEY }], hasMore: false } } }));
      res.end(JSON.stringify({ ok: false }));
    });
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  fs.writeFileSync(path.join(base, "openclaw.json"), "{}");
  const app = express();
  app.use("/app/v1", createAppBridge({ token: APP_TOKEN, gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, gatewayToken: GW_TOKEN, configPath: path.join(base, "openclaw.json"),
    gatewayCall: async () => { throw new Error("unexpected"); }, stateDir, workspaceDir: ws }));
  server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${server.address().port}/app/v1`;
});
after(() => { server?.close(); gateway?.close(); });

test("an assistant reply that names protected files gets entries marked unavailable, and /media answers 404 for them; ordinary files are served", async () => {
  const lines = ["MEDIA:MEMORY.md", "MEDIA:memory/2026-11-28.md", "MEDIA:.openclaw/openclaw.json", "MEDIA:auth-profiles.json", "MEDIA:pem-note.txt", "MEDIA:innocent.md", "MEDIA:out/summary.md", "MEDIA:out/chart.png"];
  rows = [{ role: "assistant", content: [{ type: "text", text: `هذه الملفات\n${lines.join("\n")}` }], timestamp: 1, __openclaw: { id: "msg-guard-reply" } }];
  const get = (p) => fetch(url + p, { headers: { authorization: `Bearer ${APP_TOKEN}` } });
  const h = await (await get("/history?limit=10")).json();
  const m = h.messages[0];
  assert.equal(m.media.length, lines.length);
  assert.deepEqual(m.media.map((x) => x.available), [false, false, false, false, false, false, true, true]);
  for (const [i, x] of m.media.entries()) {
    const r = await get(`/media?key=${encodeURIComponent(APP_SESSION_KEY)}&msg=msg-guard-reply&ref=${x.ref}`);
    assert.equal(r.status, i < 6 ? 404 : 200, lines[i]);
    await r.arrayBuffer();
  }
  assert.ok(!JSON.stringify(h).includes(ws), "no path in the public JSON");
});

// ------------------------------------------------------------------ review round -------------------------------------------------------

/** A layout of the engine's folders under a fresh temp dir: { ws, state }, with the same sample files everywhere. */
function layout(name, wsRel, stateRel) {
  const root = path.join(base, name);
  const ws = path.join(root, wsRel); const state = path.join(root, stateRel);
  const lw = (p, d) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d); };
  fs.mkdirSync(ws, { recursive: true }); fs.mkdirSync(path.join(state, "media", "inbound"), { recursive: true });
  const real = { ws: fs.realpathSync(ws), state: fs.realpathSync(state) };
  const stateFiles = ["identity/device-auth.json", "devices/paired.json", "devices/pending.json", "nodes/paired.json", "agents/main/agent/models.json", "agents/main/sessions/sessions.json",
    "cron/jobs.json", "exec-approvals.json", "subagents/runs.json", "telegram/update-offset-default.json", "update-check.json", "app-bridge/reset-ledger.json", "gateway.json", "logs/audit.txt"];
  for (const f of stateFiles) lw(path.join(real.state, f), f.endsWith(".txt") ? "log line\n" : '{"x":1}');
  lw(path.join(real.state, "media", "inbound", "up---1.png"), PNG); lw(path.join(real.state, "media", "outbound", "gen.png"), PNG); lw(path.join(real.state, "media", "tool-speech-synthesis", "voice---1.mp3"), MP3);
  lw(path.join(real.ws, "report.md"), TEXT); lw(path.join(real.ws, "out", "chart.png"), PNG);
  return { ...real, ctx: { workspaceDir: real.ws, stateDir: real.state, roots: mediaRoots(real.ws, real.state) }, stateFiles };
}
const servedIn = async (ctxx, src, hint) => {
  const o = await openMediaFile(src, { ...ctxx, hint }); const c = checkMediaFile(src, { ...ctxx, hint }); await o.fh?.close();
  assert.equal(c.ok, !o.error, `listing and serving disagree for ${src}`);
  return !o.error;
};

test("the state dir is never served, except <stateDir>/media: workspace == state, workspace above the state, production and default layouts", async () => {
  const layouts = [
    ["same", layout("L-same", "state", "state"), "state"],                      // OPENCLAW_WORKSPACE_DIR == OPENCLAW_STATE_DIR
    ["parent", layout("L-parent", ".", "state"), "parent"],                       // the workspace is the parent of a non-hidden state dir (/data + /data/state)
    ["production", layout("L-prod", "workspace", ".openclaw"), "production"],    // /data/workspace + /data/.openclaw
    ["default", layout("L-default", ".openclaw/workspace", ".openclaw"), "default"], // the workspace lives below the state dir
  ];
  for (const [name, L] of layouts) {
    for (const f of L.stateFiles) {
      assert.equal(await servedIn(L.ctx, path.join(L.state, f)), false, `${name}: absolute ${f}`);
      assert.equal(await servedIn(L.ctx, path.relative(L.ws, path.join(L.state, f))), false, `${name}: relative ${f}`);
    }
    for (const f of ["up---1.png", "outbound/gen.png", "tool-speech-synthesis/voice---1.mp3"]) {
      const p = f.startsWith("up") ? path.join(L.state, "media", "inbound", f) : path.join(L.state, "media", f);
      assert.equal(await servedIn(L.ctx, p), true, `${name}: media ${f}`);
    }
    assert.equal(await servedIn(L.ctx, "media://inbound/up---1.png"), true, `${name}: media://inbound`);
    if (name !== "same") { // in `same` the "workspace" IS the state dir: only its media folder is a download
      assert.equal(await servedIn(L.ctx, path.join(L.ws, "report.md")), true, `${name}: workspace file`);
      assert.equal(await servedIn(L.ctx, path.join(L.ws, "out", "chart.png")), true, `${name}: workspace subdir`);
    }
  }
  // a symlink out of the workspace into the state dir (and the other way) is judged by its real path
  const P = layouts[2][1]; fs.symlinkSync(path.join(P.state, "cron"), path.join(P.ws, "c")); fs.symlinkSync(path.join(P.state, "media"), path.join(P.ws, "m"));
  assert.equal(await servedIn(P.ctx, "c/jobs.json"), false);
  assert.equal(await servedIn(P.ctx, "m/outbound/gen.png"), true, "a link INTO the media store is that media file by its real path");
});

test("TOCTOU: a directory swapped for a symlink between the check and the open is caught by judging the opened file", async () => {
  const L = layout("L-race", "workspace", ".openclaw");
  const agent = path.join(L.state, "agents", "main", "agent");
  fs.mkdirSync(path.join(L.ws, "memory"), { recursive: true }); fs.writeFileSync(path.join(L.ws, "memory", "report.md"), "PRIVATE DAILY MEMORY\n");
  const attempts = [["models.json", agent, '{"providers":{"x":{"note":"harmless"}}}'], ["report.md", path.join(L.ws, "memory"), "innocent\n"], ["notes.md", L.state, "x"]];
  try {
    for (const [name, target, innocent] of attempts) {
      for (const mode of ["open", "check"]) {
        fs.rmSync(path.join(L.ws, "d"), { recursive: true, force: true }); fs.mkdirSync(path.join(L.ws, "d"));
        fs.writeFileSync(path.join(L.ws, "d", name), innocent);
        fs.writeFileSync(path.join(target, name), "REAL PRIVATE CONTENT\n");
        let swapped = 0;
        _testHooks.afterRealpath = () => { swapped++; fs.rmSync(path.join(L.ws, "d"), { recursive: true }); fs.symlinkSync(target, path.join(L.ws, "d")); };
        const src = `d/${name}`;
        if (mode === "open") { const o = await openMediaFile(src, L.ctx); assert.equal(o.fh, undefined, `${name}: served after the swap`); assert.equal(o.error, "unavailable"); await o.fh?.close(); }
        else assert.equal(checkMediaFile(src, L.ctx).ok, false, `${name}: listed after the swap`);
        assert.equal(swapped, 1, "the race hook ran between the realpath and the open");
        _testHooks.afterRealpath = null;
        assert.equal(await servedIn(L.ctx, src), false, "and the swapped path stays refused afterwards");
      }
    }
    // no swap: the same names in a plain directory are served
    fs.rmSync(path.join(L.ws, "d"), { recursive: true, force: true }); fs.mkdirSync(path.join(L.ws, "d")); fs.writeFileSync(path.join(L.ws, "d", "ok.md"), "fine\n");
    assert.equal(await servedIn(L.ctx, "d/ok.md"), true);
  } finally { _testHooks.afterRealpath = null; }
});

test("deny-list gaps: boot.md, env-like names, key/cookie/wallet/session names, every dot-separated part, joined and camelCase words", async () => {
  const L = layout("L-gaps", "workspace", ".openclaw");
  const wr = (n, d) => { const f = path.join(L.ws, n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); };
  const refused = { "BOOT.md": TEXT, "notes/Soul.Md": TEXT, "MEMORY.md.txt": TEXT, "memory.md.bak.txt": TEXT, "USER.MD.old.txt": TEXT, "env.txt": TEXT, "dotenv.txt": TEXT, "id_rsa.md": TEXT, "id_ed25519.txt": TEXT,
    "wallet.json": "{}", "session.json": "{}", "cookies.txt": TEXT, "keys.json": "{}", "passwd.txt": TEXT, "gateway-token.txt": TEXT, "gatewaytoken.txt": TEXT, "accesstoken.txt": TEXT,
    "accessToken.json": "{}", "apiKey.json": "{}", "MyToken.json": "{}", "db_password.txt": TEXT };
  for (const [n, d] of Object.entries(refused)) wr(n, d);
  const allowed = { "tokenizer-notes.md": TEXT, "secretary.md": TEXT, "passwordless.txt": TEXT, "environment.txt": TEXT, "keyboard.md": TEXT, "sessions-overview.md": TEXT, "walletless.txt": TEXT, "monkeys.txt": TEXT };
  for (const [n, d] of Object.entries(allowed)) wr(n, d);
  for (const n of Object.keys(refused)) assert.equal(await servedIn(L.ctx, n), false, n);
  for (const n of Object.keys(allowed)) assert.equal(await servedIn(L.ctx, n), true, n);
});

test("content: KEY=VALUE secrets, escaped hyphens, and a head of 64 KiB, the same for listing and serving; ordinary text passes", async () => {
  const L = layout("L-content", "workspace", ".openclaw");
  const wr = (n, d) => { const f = path.join(L.ws, n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); };
  const secret = { "kv1.txt": "OPENCLAW_GATEWAY_TOKEN=4f1c2e9a7b3d8e6f0a1b2c3d4e5f6071\n", "kv2.md": "TELEGRAM_BOT_TOKEN: 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5\n", "kv3.csv": "name,v\nSETUP_PASSWORD=hunter2hunter2hunter2\n",
    "kv4.json": '{"apiKey":"or-v1-0123456789abcdef0123456789abcdef"}', "kv5.txt": "db_passwd = 0123456789abcdef0123", "kv6.txt": "my.api-key: 0123456789abcdef0123456789", "kv7.txt": "client_secret=\"0123456789abcdef0123\"",
    "jsonesc.json": JSON.stringify({ k: `sk-ant-api03-${"C".repeat(40)}` }).replace("sk-", "sk\\u002d"), "esc2.txt": `sk\\-ant-api03-${"D".repeat(40)}`,
    "late-60k.md": `${"x".repeat(60000)}\nsk-ant-api03-${"A".repeat(60)}\n`, "late-5k.md": `${"x".repeat(5000)}\nsk-ant-api03-${"A".repeat(60)}\n`, "late-4100.json": JSON.stringify({ pad: "y".repeat(4100), key: `sk-proj-${"B".repeat(48)}` }) };
  for (const [n, d] of Object.entries(secret)) wr(n, d);
  const fine = { "p1.txt": "The token: please ask the owner\npassword policy: change it often\nsecret: none\n", "p2.md": `${"lorem ipsum dolor ".repeat(4000)}\nkey=short\n`, "p3.json": '{"tokens_used": 12345, "token": "abc", "name": "x"}',
    "p4.txt": "task-force-alpha-bravo-charlie-delta-echo-foxtrot sk-learn is a library", "p5.csv": "id,secretary\n1,Ann\n" };
  for (const [n, d] of Object.entries(fine)) wr(n, d);
  wr("beyond.md", `${"x".repeat(SECRET_SCAN_BYTES + 100)}\nsk-ant-api03-${"A".repeat(60)}\n`); // best effort: past the head it is not seen
  for (const n of Object.keys(secret)) assert.equal(await servedIn(L.ctx, n), false, n);
  for (const n of Object.keys(fine)) assert.equal(await servedIn(L.ctx, n), true, n);
  assert.equal(await servedIn(L.ctx, "beyond.md"), true, "documented limit: only the first 64 KiB is looked at");
});

test("owner uploads keep their file names: only the secret-word rule is skipped under <stateDir>/media/inbound", async () => {
  const L = layout("L-inbound", "workspace", ".openclaw");
  const inb = path.join(L.state, "media", "inbound");
  for (const [n, d] of [["my-password-screen---3f2a.png", PNG], ["token-photo---1.jpg", JPEG], ["secret-santa---2.pdf", PDF], ["keys.json", "{}"], ["MEMORY.md", TEXT], ["session.json", "{}"], [".hidden---1.png", PNG], ["cfg---3.txt", `SETUP_PASSWORD=hunter2hunter2hunter2`]]) fs.writeFileSync(path.join(inb, n), d);
  for (const n of ["my-password-screen---3f2a.png", "token-photo---1.jpg", "secret-santa---2.pdf"]) assert.equal(await servedIn(L.ctx, `media://inbound/${n}`), true, n);
  for (const n of ["keys.json", "MEMORY.md", "session.json", ".hidden---1.png", "cfg---3.txt"]) assert.equal(await servedIn(L.ctx, `media://inbound/${n}`), false, n);
  // the same names anywhere else are still refused by the word rule
  fs.mkdirSync(path.join(L.state, "media", "outbound"), { recursive: true });
  fs.writeFileSync(path.join(L.state, "media", "outbound", "my-password-screen.png"), PNG); fs.writeFileSync(path.join(L.ws, "my-password-screen.png"), PNG);
  assert.equal(await servedIn(L.ctx, path.join(L.state, "media", "outbound", "my-password-screen.png")), false);
  assert.equal(await servedIn(L.ctx, "my-password-screen.png"), false);
});

test("known false positives are refused on purpose (documented): the guard is a deny-list", async () => {
  const L = layout("L-fp", "workspace", ".openclaw");
  const wr = (n, d) => { const f = path.join(L.ws, n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); };
  const names = { "design-tokens.json": "{}", "password-policy.pdf": PDF, "secret-santa.xlsx": ZIP, "backups/q3-report.pdf": PDF, "clients/auth/letter.pdf": PDF, "Memory/photo.png": PNG, "agents.md": TEXT, "tools.md": TEXT,
    "user.md": TEXT, "config.json": "{}", "reports/.cache/chart.png": PNG, "exports/customer-credentials-checklist.pdf": PDF,
    "api-guide.md": "# API\nAuthorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdEFGH\n", "howto.md": `set OPENAI_API_KEY=sk-${"x".repeat(40)}\n` };
  for (const [n, d] of Object.entries(names)) { wr(n, d); assert.equal(await servedIn(L.ctx, n), false, n); }
});

// ------------------------------------------------------------------ linear time ---------------------------------------------------------

test("no input makes the marker, MEDIA: line or secret scans slow", async () => {
  const t = (label, fn, ms) => { const t0 = Date.now(); fn(); const d = Date.now() - t0; assert.ok(d < ms, `${label}: ${d} ms`); };
  t("1 MB of unclosed marker headers", () => splitAttachedMarkers("[media attached: ".repeat(60000)), 150);
  t("unclosed headers through the live text", () => cleanLiveText("[media attached: x \"".repeat(50000), { streaming: true }), 250);
  t("a header per line, no bracket", () => splitAttachedMarkers("[media attached: a\n".repeat(50000)), 250);
  t("MEDIA: line, 60k spaces", () => splitMediaLines(`MEDIA:a${" ".repeat(60000)}b`), 100);
  t("MEDIA: line, 60k spaces, live text", () => cleanLiveText(`MEDIA:a${" ".repeat(60000)}b`, { streaming: true }), 100);
  // the MEDIA: rule itself is unchanged
  assert.deepEqual(splitMediaLines("a\nMEDIA:/x/a.png\n   MEDIA: \"./b c.pdf\"\n    MEDIA:/code.png\nMEDIA:\nMEDIA:a\rb").sources, ["/x/a.png", "./b c.pdf"]);
  const L = layout("L-time", "workspace", ".openclaw");
  const hostile = { "a.txt": "a".repeat(SECRET_SCAN_BYTES), "b.txt": "token=".repeat(10000), "c.txt": "sk-".repeat(20000), "d.txt": "-----BEGIN ".repeat(5000), "e.txt": `Bearer${" ".repeat(60000)}x`,
    "f.txt": "tokentokentoken".repeat(4000), "g.txt": ":".repeat(SECRET_SCAN_BYTES), "h.txt": "password".repeat(8000), "i.txt": `${"=".repeat(30000)}token${"0".repeat(30000)}` };
  for (const [n, d] of Object.entries(hostile)) fs.writeFileSync(path.join(L.ws, n), d);
  const t0 = Date.now();
  for (const n of Object.keys(hostile)) { const o = await openMediaFile(n, L.ctx); await o.fh?.close(); checkMediaFile(n, L.ctx); }
  assert.ok(Date.now() - t0 < 1500, `secret scans took ${Date.now() - t0} ms`);
});
