// BASHT app bridge, batch 2 (attachments & viewer): every shape a user image can have in the transcript rows the bridge reads, and what
// the bridge does with each (kept in /history, served through /media, never a path / base64 / artifact id in a public JSON).
// The shapes were observed in a lab run against OpenClaw 2026.11.10 (docs/BASHT_APP_BRIDGE.md, "Images in the transcript"); a FAKE
// gateway stands in for the engine here (loopback only, synthetic tokens, temp dirs).
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { APP_SESSION_KEY, createAppBridge, runErrorCode } from "./app-bridge.js";
import { IMAGE_ONLY_PLACEHOLDER, MAX_INLINE_BYTES, MAX_MEDIA_BYTES, checkMediaFile, cleanLiveText, extractMedia, inlineImageBytes, mediaRoots, openMediaFile, publicMedia, splitAttachedMarkers } from "./app-bridge-media.js";

const APP_TOKEN = "synthetic-app-token-0123456789abcdef0123";
const GW_TOKEN = "synthetic-gateway-token-0123456789abcdef";
const PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(60, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 9)]);
const PNG_B64 = PNG.toString("base64");
const JPEG_B64 = JPEG.toString("base64");
const BIG = Buffer.concat([PNG, Buffer.alloc(MAX_MEDIA_BYTES + 1024)]); // just over the cap, still a PNG
const BIG_B64 = BIG.toString("base64");
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(40, 3)]);
const MID = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]); // a PNG above the inline cap (5 MiB) and below the file cap
const MID_B64 = MID.toString("base64");
const PDF_BYTES = Buffer.from("%PDF-1.4\n%%EOF\n");
const HTML_B64 = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");

let dir, ws, stateDir, gateway, server, base;
let rows = []; // what sessions_history / chat.history return for the app session
let chatBodies = []; // chat-completions bodies the fake gateway received
let chatMode = "ok"; // ok | limit | boom
let engineId = null; // the id the fake engine gives the next turn on its stream chunks
const OWNER_KEY = "agent:main:whatsapp:direct:+966500000001";
let ownerRows = [];
const rpc = [];

const row = (id, role, content, ts, fields = {}) => ({ role, content, timestamp: ts, __openclaw: { id, ...(fields.facts ? { media: fields.facts } : {}) } });

async function fakeGatewayCall(method, params) {
  rpc.push({ method, params });
  if (method === "chat.history") return { sessionKey: params.sessionKey, messages: rows.filter((m) => m.__openclaw.id === params.messageId) };
  if (method === "artifacts.download") {
    if (params.artifactId === "artifact_heic") return { artifact: { mimeType: "image/heic" }, encoding: "base64", data: HEIC.toString("base64") };
    if (params.artifactId === "artifact_jpeg") return { artifact: { mimeType: "image/jpeg" }, encoding: "base64", data: JPEG_B64 };
    const e = new Error("gone"); e.refused = true; throw e;
  }
  throw new Error(`unexpected gateway call ${method}`);
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-bridge-shapes-"));
  ws = path.join(dir, "workspace"); stateDir = path.join(dir, "state");
  fs.mkdirSync(ws, { recursive: true }); fs.mkdirSync(path.join(stateDir, "media", "inbound"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "media", "inbound", "wa-photo---11.jpg"), JPEG);
  const inbound = path.join(stateDir, "media", "inbound");
  fs.writeFileSync(path.join(inbound, "abc123"), JPEG); // an upload with no extension in its id
  fs.writeFileSync(path.join(inbound, "abc124"), "<html><script>1</script></html>"); // not what its recorded type says
  fs.writeFileSync(path.join(inbound, "abc125"), PDF_BYTES);
  fs.writeFileSync(path.join(inbound, "abc126"), JPEG);
  fs.writeFileSync(path.join(dir, "openclaw.json"), JSON.stringify({ commands: { ownerAllowFrom: ["whatsapp:+966500000001"] } }));
  const abs = `${stateDir}/media/inbound/wa-photo---11.jpg`;
  rows = [
    // the engine's own history view of an app photo: inline payload replaced by an artifact id
    row("msg-art-0001", "user", [{ type: "text", text: "انظر" }, { type: "image", mimeType: "image/jpeg", artifactId: "artifact_jpeg", omitted: true, bytes: JPEG.length }], 10),
    // a photo sent with no words: the engine writes its own sentence for it
    row("msg-art-0002", "user", [{ type: "text", text: IMAGE_ONLY_PLACEHOLDER }, { type: "image", mimeType: "image/jpeg", artifactId: "artifact_jpeg", omitted: true, bytes: JPEG.length }], 11),
    // raw transcript shape: the payload inline
    row("msg-inl-0001", "user", [{ type: "text", text: "صورة مضمنة" }, { type: "image", data: PNG_B64, mimeType: "image/png" }], 12),
    row("msg-inl-0002", "user", [{ type: "image", data: PNG_B64, mimeType: "image/png" }], 13), // image only, nothing else: used to vanish
    row("msg-inl-0003", "user", [{ type: "text", text: "شكل المزوّد" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG_B64 } }], 14),
    // nothing left to read from the block
    row("msg-gone-001", "user", [{ type: "image", mimeType: "image/jpeg", omitted: true, bytes: 970 }], 15),
    // ... but the engine recorded the stored upload for the message
    row("msg-fact-001", "user", [{ type: "image", mimeType: "image/jpeg", omitted: true, bytes: JPEG.length }], 16,
      { facts: [{ path: "media://inbound/wa-photo---11.jpg", url: "media://inbound/wa-photo---11.jpg", contentType: "image/jpeg", kind: "image" }] }),
    // a WhatsApp photo: marker with path, type and URL; the image block (artifact) and the stored file are ONE picture
    row("msg-wa-00001", "user", [{ type: "text", text: `صورة\n[media attached: ${abs} (image/jpeg) | media://inbound/wa-photo---11.jpg]` },
      { type: "image", mimeType: "image/jpeg", artifactId: "artifact_jpeg", omitted: true, bytes: JPEG.length }], 17,
    { facts: [{ path: "media://inbound/wa-photo---11.jpg", url: "media://inbound/wa-photo---11.jpg", contentType: "image/jpeg", kind: "image" }] }),
    // refused shapes
    row("msg-bad-0001", "user", [{ type: "image", data: HTML_B64, mimeType: "image/png" }], 18), // not a PNG
    row("msg-bad-0002", "user", [{ type: "image", data: BIG_B64, mimeType: "image/png" }], 19), // over the size cap
    row("msg-bad-0003", "user", [{ type: "image", data: PNG_B64, mimeType: "image/svg+xml" }], 20), // a document, never inline
    row("msg-bad-0004", "user", [{ type: "image", data: PNG_B64, mimeType: "image/heic" }], 21), // not shown inline
    row("msg-bad-0005", "user", [{ type: "image", data: HEIC.toString("base64"), mimeType: "image/heic" }], 24), // real heic bytes: still not inline
    row("msg-bad-0006", "user", [{ type: "image", data: MID_B64, mimeType: "image/png" }], 25), // above the inline cap
    row("msg-bad-0007", "user", [{ type: "image", data: PNG_B64, mimeType: "constructor" }], 26),
    row("msg-bad-0008", "user", [{ type: "image", mimeType: "__proto__", artifactId: "artifact_jpeg" }], 27),
    row("msg-bad-0009", "user", [{ type: "image", mimeType: "image/svg+xml", artifactId: "artifact_jpeg" }], 28),
    row("msg-heic-001", "user", [{ type: "image", mimeType: "image/heic", artifactId: "artifact_heic" }], 29),
    row("msg-ext-0001", "user", [{ type: "image", mimeType: "image/jpeg", omitted: true, bytes: 10 }], 30, { facts: [{ path: "media://inbound/abc123", url: "media://inbound/abc123", contentType: "image/jpeg", kind: "image" }] }),
    row("msg-ext-0002", "user", [{ type: "image", mimeType: "image/jpeg", omitted: true, bytes: 10 }], 31, { facts: [{ path: "media://inbound/abc124", url: "media://inbound/abc124", contentType: "image/jpeg", kind: "image" }] }),
    row("msg-ext-0003", "user", "ملف [media attached: media://inbound/abc125]", 32, { facts: [{ path: "media://inbound/abc125", url: "media://inbound/abc125", contentType: "application/pdf", kind: "document" }] }),
    row("msg-ext-0004", "user", "صورة [media attached: /x/media/inbound/abc126 (image/jpeg) | media://inbound/abc126]", 33, { facts: [{ path: "media://inbound/abc126", url: "media://inbound/abc126", contentType: "image/jpeg", kind: "image" }] }),
    row("msg-empty-01", "user", [{ type: "text", text: "   " }], 22), // truly empty: still dropped
    row("msg-text-001", "user", "نص فقط", 23),
  ];
  gateway = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${GW_TOKEN}`) { res.writeHead(401); return res.end(); }
      if (req.url === "/tools/invoke") {
        res.writeHead(200, { "content-type": "application/json" });
        const { tool } = JSON.parse(body);
        if (tool === "sessions_history") { const { args } = JSON.parse(body); return res.end(JSON.stringify({ ok: true, result: { details: { sessionKey: args.sessionKey, hasMore: false, messages: args.sessionKey === OWNER_KEY ? ownerRows : rows } } })); }
        if (tool === "sessions_list") return res.end(JSON.stringify({ ok: true, result: { details: { sessions: [{ key: APP_SESSION_KEY }, { key: OWNER_KEY }], hasMore: false } } }));
        return res.end(JSON.stringify({ ok: false }));
      }
      chatBodies.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (chatMode === "limit") return res.end(`data: ${JSON.stringify({ error: { message: "429 The usage limit has been reached" } })}\n\n`);
      if (chatMode === "boom") return res.end(`data: ${JSON.stringify({ error: { message: "provider exploded" } })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...(engineId ? { id: engineId } : {}), choices: [{ index: 0, delta: { content: "تم" } }] })}\n\n`);
      setTimeout(() => res.end("data: [DONE]\n\n"), 10);
    });
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  const app = express();
  app.use("/app/v1", createAppBridge({ token: APP_TOKEN, gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, gatewayToken: GW_TOKEN,
    configPath: path.join(dir, "openclaw.json"), gatewayCall: fakeGatewayCall, stateDir, workspaceDir: ws }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/app/v1`;
});
after(() => { server?.close(); gateway?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = (p, { method = "GET", body, raw = false } = {}) =>
  fetch(base + p, { method, headers: { authorization: `Bearer ${APP_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, headers: r.headers, ...(raw ? { bytes: Buffer.from(await r.arrayBuffer()) } : { json: await r.json().catch(() => null) }) }));
const hist = async () => (await call(`/history?limit=100`)).json;
const media = (h, id) => h.messages.find((m) => m.id === id);
const getMedia = (id, ref, key = APP_SESSION_KEY) => call(`/media?key=${encodeURIComponent(key)}&msg=${id}&ref=${ref}`, { raw: true });
const waitRun = async (id) => { for (let i = 0; i < 200; i++) { const r = await call(`/runs/${id}`); if (r.json.status !== "running") return r.json; await new Promise((x) => setTimeout(x, 15)); } throw new Error("run did not finish"); };

// ------------------------------------------------------------------ unit: shapes ------------------------------------------------

test("extractMedia: every image block yields one item; its bytes are served from the block, never copied", () => {
  const k = APP_SESSION_KEY;
  const art = extractMedia(rows[0], k);
  assert.deepEqual(art.media.map((m) => [m.kind, m.mime, m.avail, !!m.artifact]), [["image", "image/jpeg", true, true]]);
  assert.equal(art.text, "انظر");
  const inl = extractMedia(rows[2], k);
  assert.deepEqual(inl.media.map((m) => [m.kind, m.mime, m.avail, m.inline, m.size]), [["image", "image/png", true, 1, PNG.length]]);
  assert.ok(!JSON.stringify(inl.media).includes(PNG_B64), "the payload is not kept on the item");
  assert.deepEqual(extractMedia(rows[4], k).media.map((m) => [m.avail, m.mime, m.name]), [[true, "image/jpeg", "image.jpg"]], "provider shape: source.data + source.media_type");
  const gone = extractMedia(rows[5], k);
  assert.deepEqual(gone.media.map((m) => [m.kind, m.avail, m.size, m.missing !== undefined]), [["image", false, 970, true]]);
  const fact = extractMedia(rows[6], k);
  assert.equal(fact.media.length, 1);
  assert.equal(fact.media[0].file, "media://inbound/wa-photo---11.jpg");
  assert.equal(fact.media[0].avail, undefined, "a file: availability is decided against the engine roots by the route");
  // whatsapp: block + marker + fact name the same picture once
  const wa = extractMedia(rows[7], k);
  assert.equal(wa.media.length, 1);
  assert.equal(wa.media[0].artifact, "artifact_jpeg");
  assert.equal(wa.text, "صورة");
  // refs differ per position and per message
  assert.notEqual(extractMedia(rows[2], k).media[0].ref, extractMedia(rows[3], k).media[0].ref);
});

test("extractMedia: refused inline payloads are listed as unavailable (type, size, magic bytes)", () => {
  const k = APP_SESSION_KEY;
  assert.equal(extractMedia(rows[8], k).media[0].avail, false, "HTML in a PNG block");
  assert.equal(extractMedia(rows[9], k).media[0].avail, false, "over MAX_MEDIA_BYTES");
  assert.equal(extractMedia(rows[10], k).media[0].avail, false, "svg is a document");
  assert.equal(extractMedia(rows[11], k).media[0].avail, false, "heic is not shown inline");
  assert.equal(extractMedia(rows[11], k).media[0].kind, "file");
  assert.deepEqual(inlineImageBytes(rows[8], extractMedia(rows[8], k).media[0]), { error: "unsupported" });
  assert.deepEqual(inlineImageBytes(rows[9], extractMedia(rows[9], k).media[0]), { error: "too_large" });
  assert.deepEqual(inlineImageBytes(rows[10], extractMedia(rows[10], k).media[0]), { error: "not_found" });
  assert.ok(inlineImageBytes(rows[2], extractMedia(rows[2], k).media[0]).bytes.equals(PNG));
  // a block that is not the inline image the item came from
  assert.deepEqual(inlineImageBytes(rows[0], { inline: 1, mime: "image/png" }), { error: "not_found" });
});

test("extractMedia: the engine's image-only sentence is never the owner's text; an image the engine kept nothing of is still listed", () => {
  const k = APP_SESSION_KEY;
  const withArt = extractMedia(rows[1], k);
  assert.equal(withArt.text, ""); assert.equal(withArt.media.length, 1); assert.equal(withArt.media[0].avail, true);
  // a model without image input: the engine dropped the block and kept only its sentence
  const dropped = extractMedia(row("msg-drop-001", "user", IMAGE_ONLY_PLACEHOLDER, 1), k);
  assert.equal(dropped.text, ""); assert.deepEqual(dropped.media.map((m) => [m.kind, m.avail]), [["image", false]]);
  // the same sentence in an assistant row, or inside other words, is just text
  assert.equal(extractMedia(row("msg-asst-001", "assistant", IMAGE_ONLY_PLACEHOLDER, 1), k).media.length, 0);
  assert.equal(extractMedia(row("msg-user-001", "user", `${IMAGE_ONLY_PLACEHOLDER} thanks`, 1), k).media.length, 0);
});

test("attachment markers: path, content type, stored-upload URL and file name parts", () => {
  const s = (t) => splitAttachedMarkers(t).sources;
  assert.deepEqual(s("[media attached: /data/.openclaw/media/inbound/a.jpg (image/jpeg) | media://inbound/a.jpg]"), ["media://inbound/a.jpg"]);
  assert.deepEqual(s('[media attached: /data/.openclaw/media/inbound/a.jpg (image/jpeg) "My Photo.jpg"]'), ["/data/.openclaw/media/inbound/a.jpg"]);
  assert.deepEqual(s('[media attached 1/2: media://inbound/b.pdf (application/pdf) | media://inbound/b.pdf "b.pdf"]'), ["media://inbound/b.pdf"]);
  assert.deepEqual(s("[media attached: media://inbound/c.png]"), ["media://inbound/c.png"]);
  assert.deepEqual(s("[media attached: ./out/d e.png (image/png)]"), ["./out/d e.png"], "a path with a space keeps it");
  assert.deepEqual(s("[media attached: /x/a.png | https://example.com/a.png]"), ["/x/a.png"], "only a stored-upload URL replaces the path");
});

// ------------------------------------------------------------------ the bridge: /history and /media ---------------------------------

test("history: an image message is never dropped; empty rows still are", async () => {
  const h = await hist();
  const ids = h.messages.map((m) => m.id);
  for (const id of ["msg-art-0001", "msg-art-0002", "msg-inl-0001", "msg-inl-0002", "msg-inl-0003", "msg-gone-001", "msg-fact-001", "msg-wa-00001", "msg-bad-0001", "msg-text-001"]) {
    assert.ok(ids.includes(id), `${id} kept`);
  }
  assert.ok(!ids.includes("msg-empty-01"), "a row with no text and no image is still dropped");
  assert.deepEqual(media(h, "msg-inl-0002"), { role: "user", text: "", at: 13, id: "msg-inl-0002", media: [{ ref: media(h, "msg-inl-0002").media[0].ref, kind: "image", name: "image.png", mime: "image/png", size: PNG.length, available: true }] });
  assert.equal(media(h, "msg-art-0002").text, "");
  assert.equal(media(h, "msg-gone-001").media[0].available, false);
  assert.equal(media(h, "msg-gone-001").media[0].size, 970);
  assert.equal(media(h, "msg-wa-00001").media.length, 1);
  assert.equal(media(h, "msg-wa-00001").text, "صورة");
  assert.equal(media(h, "msg-fact-001").media[0].available, true, "the stored upload of the message is inside the engine's media root");
  for (const id of ["msg-bad-0001", "msg-bad-0002", "msg-bad-0003", "msg-bad-0004"]) assert.equal(media(h, id).media[0].available, false, id);
  // the contract of the row stays: media is [{ref, kind, name, mime, size, available}]
  for (const m of h.messages) for (const it of m.media) assert.deepEqual(Object.keys(it), ["ref", "kind", "name", "mime", "size", "available"]);
});

test("history: no payload, path, artifact id or engine field leaks into the public JSON", async () => {
  const text = JSON.stringify(await hist());
  for (const secret of [PNG_B64.slice(0, 40), JPEG_B64.slice(0, 40), HTML_B64.slice(0, 20), "artifact_jpeg", stateDir, ws, "/media/inbound", "media://", "omitted", "artifactId", "inline", "missing"]) {
    assert.ok(!text.includes(secret), `leaked: ${secret}`);
  }
});

test("media: inline images are decoded on demand with the same headers as every other file", async () => {
  const h = await hist();
  const it = media(h, "msg-inl-0001").media[0];
  const r = await getMedia("msg-inl-0001", it.ref);
  assert.equal(r.status, 200); assert.ok(r.bytes.equals(PNG));
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("content-security-policy"), /sandbox/);
  assert.match(r.headers.get("content-disposition"), /^attachment; filename\*=UTF-8''image\.png$/);
  assert.equal(r.headers.get("content-length"), String(PNG.length));
  // the provider shape, and an image-only message
  const prov = await getMedia("msg-inl-0003", media(h, "msg-inl-0003").media[0].ref);
  assert.ok(prov.bytes.equals(JPEG)); assert.equal(prov.headers.get("content-type"), "image/jpeg", "source.media_type is the declared type when mimeType is absent");
  assert.ok((await getMedia("msg-inl-0002", media(h, "msg-inl-0002").media[0].ref)).bytes.equals(PNG));
  // artifact and stored-upload files go the way they always did
  assert.ok((await getMedia("msg-art-0002", media(h, "msg-art-0002").media[0].ref)).bytes.equals(JPEG));
  assert.ok((await getMedia("msg-fact-001", media(h, "msg-fact-001").media[0].ref)).bytes.equals(JPEG));
  assert.ok((await getMedia("msg-wa-00001", media(h, "msg-wa-00001").media[0].ref)).bytes.equals(JPEG));
});

test("media: refused payloads answer with the same codes as files; nothing is served for an image the engine kept nothing of", async () => {
  const h = await hist();
  const code = async (id) => (await getMedia(id, media(h, id).media[0].ref)).status;
  assert.equal(await code("msg-bad-0001"), 415, "bad magic bytes");
  assert.equal(await code("msg-bad-0002"), 413, "over the cap");
  assert.equal(await code("msg-bad-0003"), 404, "svg is never served inline");
  assert.equal(await code("msg-bad-0004"), 404, "heic is not an inline type");
  assert.equal(await code("msg-gone-001"), 404, "no bytes");
});

test("media: a ref is only valid for the message it came from", async () => {
  const h = await hist();
  const ref = media(h, "msg-inl-0001").media[0].ref;
  assert.equal((await getMedia("msg-inl-0003", ref)).status, 404);
  assert.equal((await getMedia("msg-art-0001", ref)).status, 404);
  assert.equal((await getMedia("msg-inl-0001", ref, "agent:main:whatsapp:direct:+966511111111")).status, 404);
  assert.equal((await getMedia("msg-inl-0001", "0".repeat(32))).status, 404);
  assert.equal((await getMedia("msg-inl-0001", ref)).status, 200);
});

// ------------------------------------------------------------------ end to end: send an image, read it back ---------------------------

test("end to end: a photo sent through /send reaches the engine as an image_url part and comes back as served media", async () => {
  const before = chatBodies.length;
  const sent = await call("/send", { method: "POST", body: { images: [{ mime: "image/jpeg", data: JPEG_B64 }] } });
  assert.equal(sent.status, 202);
  assert.equal((await waitRun(sent.json.runId)).status, "done");
  const body = chatBodies[before];
  assert.deepEqual(body.messages[0].content, [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${JPEG_B64}` } }]);
  // the engine then stores the turn; its history view shows it as the lab observed (placeholder text + artifact block)
  rows.push(row("msg-sent-001", "user", [{ type: "text", text: IMAGE_ONLY_PLACEHOLDER }, { type: "image", mimeType: "image/jpeg", artifactId: "artifact_jpeg", omitted: true, bytes: JPEG.length }], 100));
  const m = media(await hist(), "msg-sent-001");
  assert.equal(m.text, ""); assert.equal(m.media.length, 1); assert.equal(m.media[0].available, true);
  const r = await getMedia("msg-sent-001", m.media[0].ref);
  assert.equal(r.status, 200); assert.ok(r.bytes.equals(JPEG));
  assert.deepEqual(rpc.findLast((c) => c.method === "artifacts.download").params, { sessionKey: APP_SESSION_KEY, artifactId: "artifact_jpeg" });
});

// ------------------------------------------------------------------ errorCode ----------------------------------------------------

test("runErrorCode: only a provider limit has a code", () => {
  for (const msg of ["429 The usage limit has been reached", "usage_limit_reached", "Rate limit reached for requests", "rate_limit_exceeded", "HTTP 429", "Too Many Requests", "chat 429"]) {
    assert.equal(runErrorCode(new Error(msg)), "rate_limited", msg);
  }
  for (const msg of ["provider exploded", "chat 500", "fetch failed", "port 14290 refused", "", "after 429ms", "request id 429-abcd", "pid 429", "listening on :429",
    "context usage limit", "memory usage limit exceeded", "took 1429 ms"]) assert.equal(runErrorCode(new Error(msg)), null, msg);
  for (const msg of ["HTTP/1.1 429 Too", "status: 429", "429"]) assert.equal(runErrorCode(new Error(msg)), "rate_limited", msg);
  assert.equal(runErrorCode(null), null);
});

test("/runs/:id: a rate-limited turn carries errorCode next to the unchanged opaque error; other failures carry none", async () => {
  chatMode = "limit";
  const a = await call("/send", { method: "POST", body: { message: "x" } });
  const done = await waitRun(a.json.runId);
  assert.equal(done.status, "error"); assert.equal(done.error, "engine_error"); assert.equal(done.errorCode, "rate_limited");
  assert.ok(!JSON.stringify(done).includes("usage limit"), "the provider's own text stays out");
  chatMode = "boom";
  const b = await waitRun((await call("/send", { method: "POST", body: { message: "y" } })).json.runId);
  assert.equal(b.status, "error"); assert.equal(b.error, "engine_error"); assert.ok(!("errorCode" in b));
  chatMode = "ok";
  const c = await waitRun((await call("/send", { method: "POST", body: { message: "z" } })).json.runId);
  assert.equal(c.status, "done"); assert.ok(!("errorCode" in c));
});

test("extractMedia: an assistant reply with an image block and a MEDIA: line shows both pictures", () => {
  const m = row("msg-asst-002", "assistant", [{ type: "text", text: "MEDIA:./out/a.png" }, { type: "image", mimeType: "image/png", artifactId: "artifact_jpeg" }], 1);
  const { media: items } = extractMedia(m, APP_SESSION_KEY);
  assert.deepEqual(items.map((i) => (i.artifact ? "artifact" : i.file)), ["artifact", "./out/a.png"]);
});

test("extractMedia: two images in a user row pair with their own files, in order; extra files stay separate", () => {
  const m = row("msg-wa-00002", "user", [{ type: "text", text: "اثنتان [media attached 1/3: media://inbound/a.jpg (image/jpeg)] [media attached 2/3: media://inbound/b.jpg (image/jpeg)] [media attached 3/3: media://inbound/c.pdf (application/pdf)]" },
    { type: "image", mimeType: "image/jpeg", omitted: true, bytes: 5 }, { type: "image", mimeType: "image/jpeg", artifactId: "artifact_jpeg" }], 1);
  const { media: items } = extractMedia(m, APP_SESSION_KEY);
  assert.deepEqual(items.map((i) => i.artifact ?? i.file), ["media://inbound/a.jpg", "artifact_jpeg", "media://inbound/c.pdf"]);
});

// ------------------------------------------------------------------ review round: listing = serving, hostile names, limits -----------

test("an upload whose id has no extension is served by the image type the engine recorded for it, and only if the bytes agree", async () => {
  const h = await hist();
  const ok = media(h, "msg-ext-0001").media[0];
  assert.deepEqual([ok.kind, ok.mime, ok.available, ok.size, ok.name], ["image", "image/jpeg", true, JPEG.length, "abc123.jpg"]);
  const r = await getMedia("msg-ext-0001", ok.ref);
  assert.equal(r.status, 200); assert.ok(r.bytes.equals(JPEG)); assert.equal(r.headers.get("content-type"), "image/jpeg");
  // recorded as a JPEG, but the bytes are HTML: listed unavailable AND refused (415)
  const bad = media(h, "msg-ext-0002").media[0];
  assert.equal(bad.available, false);
  assert.equal((await getMedia("msg-ext-0002", bad.ref)).status, 415);
  // a recorded type that is not an inline-viewable image gives no type to an id with no extension
  const pdf = media(h, "msg-ext-0003").media[0];
  assert.deepEqual([pdf.kind, pdf.mime, pdf.available], ["file", null, false]);
  assert.equal((await getMedia("msg-ext-0003", pdf.ref)).status, 415);
  // marker + fact name one upload (the hint reaches the file the marker named)
  const wa = media(h, "msg-ext-0004");
  assert.equal(wa.media.length, 1); assert.equal(wa.media[0].available, true);
  assert.equal((await getMedia("msg-ext-0004", wa.media[0].ref)).status, 200);
});

test("listing and serving never disagree: checkMediaFile answers what openMediaFile does", async () => {
  const d = path.join(ws, "agree"); fs.mkdirSync(d, { recursive: true });
  const w = (n, b) => fs.writeFileSync(path.join(d, n), b);
  w("ok.png", PNG); w("fake.png", "<html>"); w("big.png", Buffer.concat([PNG, Buffer.alloc(MAX_MEDIA_BYTES)])); w("noext", JPEG); w("empty.png", ""); w("script.sh", "#!/bin/sh");
  fs.mkdirSync(path.join(d, "dir.png"));
  const ctx = { workspaceDir: ws, stateDir, roots: mediaRoots(ws, stateDir) };
  for (const [src, hint] of [["agree/ok.png"], ["agree/fake.png"], ["agree/big.png"], ["agree/noext"], ["agree/noext", "image/jpeg"], ["agree/noext", "image/png"], ["agree/noext", "application/pdf"],
    ["agree/empty.png"], ["agree/script.sh"], ["agree/dir.png"], ["agree/missing.png"], ["/etc/passwd"], ["media://inbound/abc123", "image/jpeg"], ["media://inbound/abc124", "image/jpeg"], ["media://inbound/abc123"]]) {
    const o = await openMediaFile(src, { ...ctx, hint });
    const listed = checkMediaFile(src, { ...ctx, hint });
    await o.fh?.close();
    assert.equal(listed.ok, !o.error, `${src} ${hint ?? ""}`);
    if (listed.ok) assert.equal(listed.size, o.size);
  }
});

test("attachment markers with hostile file names leave no debris and no extra entry", () => {
  const url = "media://inbound/x.jpg";
  const names = ['photo [1].jpg', 'a "quoted" name.jpg', 'ends with ] and "', "x".repeat(5000), "q".repeat(300) + '"]' , 'back\\slash \\" end', ' "', "[media attached: nested]"];
  for (const name of names) {
    // the engine writes the name as a JSON string; a name quoted raw (quotes unescaped) is tolerated unless it holds `"]` itself
    for (const quoted of [JSON.stringify(name), ...(name.includes('"]') ? [] : [`"${name}"`])]) {
      const t = `قبل [media attached: /d/media/inbound/x.jpg (image/jpeg) | ${url} ${quoted}] بعد`;
      const r = splitAttachedMarkers(t);
      assert.deepEqual(r.sources, [url], `sources for ${name.slice(0, 30)}`);
      assert.equal(r.text, "قبل  بعد", `text for ${name.slice(0, 30)}`);
    }
  }
  const m = row("msg-name-001", "user", `[media attached: /d/media/inbound/x.jpg (image/jpeg) | ${url} "photo [1].jpg"]`, 1);
  const { text, media: items } = extractMedia(m, APP_SESSION_KEY);
  assert.equal(text, ""); assert.equal(items.length, 1); assert.equal(items[0].file, url);
  // two markers, one hostile: both found, text between kept
  const two = splitAttachedMarkers(`a [media attached 1/2: ${url} "p [1].jpg"] b [media attached 2/2: media://inbound/y.png (image/png)] c`);
  assert.deepEqual(two.sources, [url, "media://inbound/y.png"]); assert.equal(two.text, "a  b  c");
  // not a marker: left as it is
  assert.equal(splitAttachedMarkers("see [media attached: and no end").text, "see [media attached: and no end");
  assert.equal(splitAttachedMarkers("[media attached: ]").sources.length, 0);
  // only the stored-upload URL's own characters are the source
  assert.deepEqual(splitAttachedMarkers(`[media attached: /p/x.jpg | ${url}"junk /etc/passwd]`).sources, [url]);
});

test("marker parsing is linear: many markers with long runs of spaces are cheap, also on the live-text path", () => {
  const hostile = [
    "[media attached: /p/a.jpg" + " ".repeat(2000) + " | y ",
    "[media attached: /p/a.jpg (image/jpeg)" + " ".repeat(2000) + '"x ] ',
    '[media attached: /p/a.jpg | media://inbound/a.jpg "' + 'a\\"'.repeat(1500) + " ",
  ].map((unit) => unit.repeat(500));
  const t0 = Date.now();
  for (const h of hostile) { splitAttachedMarkers(h); cleanLiveText(h, { streaming: true }); }
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

test("inline images above 5 MiB decoded are listed unavailable and refused (the re-read of the row is bounded by the CLI buffer)", async () => {
  assert.equal(MAX_INLINE_BYTES, 5 * 1024 * 1024);
  const h = await hist();
  const it = media(h, "msg-bad-0006").media[0];
  assert.deepEqual([it.available, it.size, it.mime], [false, MID.length, "image/png"]);
  assert.equal((await getMedia("msg-bad-0006", it.ref)).status, 413);
});

test("only allowlisted types are ever published; a type named like an object property is no type", async () => {
  const h = await hist();
  for (const id of ["msg-bad-0007", "msg-bad-0008"]) {
    const it = media(h, id).media[0];
    assert.deepEqual([it.mime, it.name, it.available], [null, "image", false], id);
  }
  assert.equal(media(h, "msg-bad-0009").media[0].available, false, "svg is no image type");
  assert.equal(media(h, "msg-bad-0009").media[0].mime, null);
  for (const m of h.messages) for (const it of m.media) assert.ok(it.mime === null || /^[a-z]+\/[a-z0-9.+-]+$/.test(it.mime));
});

test("heic: a real payload is never listed available inline; as an artifact it is a download (kind file), consistently with /media", async () => {
  const h = await hist();
  const inl = media(h, "msg-bad-0005").media[0];
  assert.deepEqual([inl.kind, inl.mime, inl.available], ["file", "image/heic", false]);
  assert.equal((await getMedia("msg-bad-0005", inl.ref)).status, 404);
  const art = media(h, "msg-heic-001").media[0];
  assert.deepEqual([art.kind, art.mime, art.available], ["file", "image/heic", true]);
  const r = await getMedia("msg-heic-001", art.ref);
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/heic");
});

test("publicMedia publishes an allowlisted mime or null, whatever the item carries", () => {
  const base = { ref: "a".repeat(32), kind: "file", name: "n", size: 1 };
  assert.equal(publicMedia({ ...base, mime: "constructor" }, true).mime, null);
  assert.equal(publicMedia({ ...base, mime: "__proto__" }, true).mime, null);
  assert.equal(publicMedia({ ...base, mime: "text/html" }, true).mime, null);
  assert.equal(publicMedia({ ...base, mime: "image/png" }, true).mime, "image/png");
});

// Codex P2: a named pipe with an allowlisted name in the workspace must never block the open (the listing check is synchronous, so a
// blocking open would freeze the whole wrapper until some process opened the other end of the pipe).
test("a FIFO with an allowlisted name is refused at once, by the listing check and by serving", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const fifoDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-bridge-fifo-"));
  const fifo = path.join(fifoDir, "result.txt");
  try { execFileSync("mkfifo", [fifo]); } catch { t.skip("mkfifo is not available here"); fs.rmSync(fifoDir, { recursive: true, force: true }); return; }
  try {
    const roots = mediaRoots(fifoDir, null);
    const ctx = { workspaceDir: fifoDir, stateDir: null, roots };
    // run in a child process so that a regression (a blocking open) fails by timeout instead of hanging this test process
    const script = `import("${new URL("./app-bridge-media.js", import.meta.url).href}").then(async (m) => {
      const roots = m.mediaRoots(${JSON.stringify(fifoDir)}, null);
      const ctx = { workspaceDir: ${JSON.stringify(fifoDir)}, stateDir: null, roots };
      const a = m.checkMediaFile("result.txt", ctx);
      const b = await m.openMediaFile("result.txt", ctx);
      console.log(JSON.stringify({ ok: a.ok, err: b.error ?? null }));
      process.exit(0);
    });`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 5000 }).toString().trim();
    assert.deepEqual(JSON.parse(out), { ok: false, err: "unavailable" });
    void ctx;
  } finally { fs.rmSync(fifoDir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ runId on the user row of a turn /send started ----------------------

const ENGINE_A = "chatcmpl_11111111-2222-4333-8444-555555555555";
const ENGINE_B = "chatcmpl_66666666-7777-4888-8999-aaaaaaaaaaaa";
const userRow = (id, ts, text = "سؤال") => ({ role: "user", content: text, timestamp: ts, idempotencyKey: `internal-${id}:user`, __openclaw: { id, idempotencyKey: `internal-${id}:user` } });
const replyRow = (id, ts, runId) => ({ role: "assistant", content: [{ type: "text", text: "جواب" }], timestamp: ts, __openclaw: { id, ...(runId ? { runId } : {}) } });
const runIdsOf = (h) => Object.fromEntries(h.messages.filter((m) => m.role === "user").map((m) => [m.id, m.runId]));

test("history: the user row of a turn /send started carries that turn's runId (via the reply row of the same turn); nothing else does", async () => {
  engineId = ENGINE_A;
  const sent = await call("/send", { method: "POST", body: { message: "سؤال" } });
  assert.equal((await waitRun(sent.json.runId)).status, "done");
  engineId = null;
  rows.push(userRow("msg-run-user-1", 1000), replyRow("msg-run-asst-1", 1001, ENGINE_A));
  // a turn this process did not start (other client, an earlier process): no runId, whatever its reply carries
  rows.push(userRow("msg-run-user-2", 2000), replyRow("msg-run-asst-2", 2001, ENGINE_B));
  // no reply yet / a user row followed by another user row / a reply older than the row / a reply with no run id
  rows.push(userRow("msg-run-user-3", 3000), userRow("msg-run-user-4", 3001), replyRow("msg-run-asst-4", 3002, ENGINE_A));
  rows.push(userRow("msg-run-user-5", 4000), replyRow("msg-run-asst-5", 3999, ENGINE_A));
  rows.push(userRow("msg-run-user-6", 5000), replyRow("msg-run-asst-6", 5001));
  const h = await hist();
  const ids = runIdsOf(h);
  assert.equal(ids["msg-run-user-1"], sent.json.runId);
  assert.match(sent.json.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  for (const id of ["msg-run-user-2", "msg-run-user-3", "msg-run-user-5", "msg-run-user-6"]) assert.equal(ids[id], undefined, id);
  assert.equal(ids["msg-run-user-4"], sent.json.runId, "the user row right before the reply is the turn's own (user-3 had no reply of its own)");
  for (const m of h.messages.filter((x) => x.role === "assistant")) assert.ok(!("runId" in m), "assistant rows carry no runId");
  for (const m of h.messages.filter((x) => x.id !== "msg-run-user-1" && x.id !== "msg-run-user-4")) assert.ok(!("runId" in m), m.id);
  // no engine id, internal idempotency key or other id in the public JSON
  const text = JSON.stringify(h);
  for (const secret of [ENGINE_A, ENGINE_B, "chatcmpl_", "internal-", ":user", "idempotency"]) assert.ok(!text.includes(secret), `leaked: ${secret}`);
});

test("history: a conversation other than the app session never carries a runId, even if its reply carries an id this process linked", async () => {
  ownerRows = [userRow("msg-wa-user-01", 10), replyRow("msg-wa-asst-01", 11, ENGINE_A)];
  const r = (await call(`/history?key=${encodeURIComponent(OWNER_KEY)}&limit=10`)).json;
  assert.deepEqual(r.messages.map((m) => m.id), ["msg-wa-user-01", "msg-wa-asst-01"]);
  assert.ok(r.messages.every((m) => !("runId" in m)));
});

// ------------------------------------------------------------------ base64 padding: listing and serving agree --------------------------

test("tiny inline images whose whole payload is one short base64 string: padding of 0, 1 and 2 characters is valid, malformed padding is not", async () => {
  const gif = (n) => Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(n - 6, 1)]);
  const png = (n) => Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(n - 8, 2)]);
  const good = [["gif33", gif(33), "image/gif", 0], ["gif34", gif(34), "image/gif", 2], ["gif35", gif(35), "image/gif", 1], ["gif40", gif(40), "image/gif", 2],
    ["png33", png(33), "image/png", 0], ["png34", png(34), "image/png", 2], ["png35", png(35), "image/png", 1], ["png38", png(38), "image/png", 1]];
  for (const [id, bytes, mime, pad] of good) {
    const b64 = bytes.toString("base64");
    assert.equal(b64.length <= 56 && b64.endsWith("=".repeat(pad)) && !b64.endsWith("=".repeat(pad + 1)), true, `${id} padding`);
    rows.push({ ...row(`msg-pad-${id}`, "user", [{ type: "image", data: b64, mimeType: mime }], 6000), timestamp: 6000 });
  }
  const g = Buffer.from("GIF89a", "latin1").toString("base64").slice(0, 8); // "R0lGODlh"
  const bad = { "misplaced-pad": `${g}=AAA`, "pad-in-middle": `${g}AA=AAAAA`, "three-pad": `${g}A===`, "length-3": `${g}AAA`, "bad-char": `${g}A*AA`, "empty-pad": "====" };
  for (const [id, data] of Object.entries(bad)) rows.push({ ...row(`msg-pad-bad-${id}`, "user", [{ type: "image", data, mimeType: "image/gif" }], 6001), timestamp: 6001 });
  const h = await hist();
  for (const [id, bytes, mime] of good) {
    const it = media(h, `msg-pad-${id}`).media[0];
    assert.deepEqual([it.available, it.mime, it.size], [true, mime, bytes.length], id);
    const r = await getMedia(`msg-pad-${id}`, it.ref);
    assert.equal(r.status, 200, id); assert.ok(r.bytes.equals(bytes), id);
  }
  for (const id of Object.keys(bad)) {
    const m = media(h, `msg-pad-bad-${id}`);
    assert.equal(m.media[0].available, false, id);
    assert.notEqual((await getMedia(`msg-pad-bad-${id}`, m.media[0].ref)).status, 200, id);
  }
});

// ------------------------------------------------------------------ pairing blocks with their files, heic included ---------------------

test("image blocks pair, in order, with ALL picture files of the message: a heic (not inline-viewable) does not shift the next block's file", async () => {
  const inbound = path.join(stateDir, "media", "inbound");
  for (const [n, b] of [["h1.heic", HEIC], ["h2.heic", HEIC], ["j1.jpg", JPEG], ["j2.jpg", JPEG]]) fs.writeFileSync(path.join(inbound, n), b);
  const fact = (n, ct) => ({ path: `media://inbound/${n}`, url: `media://inbound/${n}`, contentType: ct, kind: "image" });
  const gone = (mime) => ({ type: "image", mimeType: mime, omitted: true, bytes: 9 });
  const k = APP_SESSION_KEY;
  const files = (m) => extractMedia(m, k).media.map((i) => i.artifact ?? i.file ?? `<${i.missing !== undefined ? "missing" : "inline"}>`);
  const H = fact("h1.heic", "image/heic"), H2 = fact("h2.heic", "image/heic"), J = fact("j1.jpg", "image/jpeg"), J2 = fact("j2.jpg", "image/jpeg");
  const u = (id, content, facts) => row(id, "user", content, 1, { facts });
  // heic then jpeg, jpeg then heic: each block takes its own file, none twice
  assert.deepEqual(files(u("msg-pair-001", [gone("image/heic"), gone("image/jpeg")], [H, J])), ["media://inbound/h1.heic", "media://inbound/j1.jpg"]);
  assert.deepEqual(files(u("msg-pair-002", [gone("image/jpeg"), gone("image/heic")], [J, H])), ["media://inbound/j1.jpg", "media://inbound/h1.heic"]);
  assert.deepEqual(files(u("msg-pair-003", [gone("image/heic"), gone("image/heic")], [H, H2])), ["media://inbound/h1.heic", "media://inbound/h2.heic"]);
  // a heic block with an artifact keeps its artifact; the file it names is the same picture, not a second one; the jpeg keeps its own file
  assert.deepEqual(files(u("msg-pair-004", [{ type: "image", mimeType: "image/heic", artifactId: "artifact_heic" }, gone("image/jpeg")], [H, J])), ["artifact_heic", "media://inbound/j1.jpg"]);
  // a heic block with no file of its own does not take the jpeg's (types known and different); the jpeg block does
  assert.deepEqual(files(u("msg-pair-005", [gone("image/heic"), gone("image/jpeg")], [J])), ["<missing>", "media://inbound/j1.jpg"]);
  assert.deepEqual(files(u("msg-pair-005", [gone("image/jpeg"), gone("image/heic")], [H])), ["<missing>", "media://inbound/h1.heic"]);
  // more blocks than facts, more facts than blocks: no crash, no duplicates, stable order
  assert.deepEqual(files(u("msg-pair-006", [gone("image/jpeg"), gone("image/jpeg"), gone("image/jpeg")], [J, J2])), ["media://inbound/j1.jpg", "media://inbound/j2.jpg", "<missing>"]);
  assert.deepEqual(files(u("msg-pair-007", [gone("image/jpeg")], [J, J2, H])), ["media://inbound/j1.jpg", "media://inbound/j2.jpg", "media://inbound/h1.heic"]);
  assert.deepEqual(files(u("msg-pair-008", [], [H, J])), ["media://inbound/h1.heic", "media://inbound/j1.jpg"]);
  assert.deepEqual(files(u("msg-pair-009", [gone("image/jpeg")], [])), ["<missing>"]);
  // a pdf file is no picture: it never takes an image block's place and is listed after
  const pdf = { path: "media://inbound/abc125", url: "media://inbound/abc125", contentType: "application/pdf", kind: "document" };
  assert.deepEqual(files(u("msg-pair-010", [gone("image/jpeg")], [pdf, J])), ["media://inbound/j1.jpg", "media://inbound/abc125"]);
  for (const m of [u("msg-pair-001", [gone("image/heic"), gone("image/jpeg")], [H, J]), u("msg-pair-006", [gone("image/jpeg"), gone("image/jpeg"), gone("image/jpeg")], [J, J2])]) {
    const refsOf = extractMedia(m, k).media.map((i) => i.ref); assert.equal(new Set(refsOf).size, refsOf.length, "refs are unique");
  }
  // through the bridge: the heic is one entry (kind file, served as a download), the jpeg is available and served
  rows.push(u("msg-pair-view1", [gone("image/heic"), gone("image/jpeg")], [H, J]));
  const h = await hist();
  const [a, b] = media(h, "msg-pair-view1").media;
  assert.equal(media(h, "msg-pair-view1").media.length, 2);
  assert.deepEqual([a.kind, a.mime, a.available], ["file", "image/heic", true]);
  assert.deepEqual([b.kind, b.mime, b.available], ["image", "image/jpeg", true]);
  assert.ok((await getMedia("msg-pair-view1", a.ref)).bytes.equals(HEIC));
  assert.ok((await getMedia("msg-pair-view1", b.ref)).bytes.equals(JPEG));
});
