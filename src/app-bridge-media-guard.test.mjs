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
import { MAX_MEDIA_BYTES, MEDIA_TYPES, PROTECTED_DIRS, PROTECTED_FILES, PROTECTED_WORDS, checkMediaFile, extractMedia, isProtectedRelPath, mediaRoots, openMediaFile } from "./app-bridge-media.js";

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
    ["pem-note.txt", PEM], ["head.md", `# notes\nkey: sk-ant-api03-${"A".repeat(40)}\n`], ["openai.txt", `sk-${"a1B2".repeat(10)}`], ["gh.json", `{"t":"ghp_${"a".repeat(36)}"}`],
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
  assert.deepEqual([...PROTECTED_FILES], ["memory.md", "soul.md", "user.md", "identity.md", "agents.md", "tools.md", "heartbeat.md", "bootstrap.md", "dreams.md",
    "openclaw.json", "auth.json", "auth-profiles.json", "credentials.json", "secrets.json", "config.json", "settings.json"]);
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
    "credential.txt", "auth-profile.md", "passwords.md", "Secret.TXT", "pem-note.txt", "head.md", "openai.txt", "gh.json", "pat.txt", "aws.csv", "slack.md", "jwt.txt",
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
  for (const p of ["a/.b", ".a", "MEMORY.MD", "x/Memory/y.md", "a/AUTH/b.txt", "api-key.txt", "x_token_y.json", "TOKEN.md", "my token.md", "Credentials.JSON", "private_key.pem.txt"]) assert.equal(isProtectedRelPath(p), true, p);
  for (const p of ["tokenizer-notes.md", "secretary.md", "mytoken.json", "passwordless.txt", "authors.md", "memory-store/x.md", "memoryless.md", "usermanual.md", "a/b.png", "out/report-2026.json"]) assert.equal(isProtectedRelPath(p), false, p);
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
