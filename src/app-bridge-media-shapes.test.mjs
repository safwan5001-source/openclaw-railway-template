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
import { APP_SESSION_KEY, createAppBridge } from "./app-bridge.js";
import { IMAGE_ONLY_PLACEHOLDER, MAX_MEDIA_BYTES, extractMedia, inlineImageBytes, splitAttachedMarkers } from "./app-bridge-media.js";

const APP_TOKEN = "synthetic-app-token-0123456789abcdef0123";
const GW_TOKEN = "synthetic-gateway-token-0123456789abcdef";
const PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(60, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 9)]);
const PNG_B64 = PNG.toString("base64");
const JPEG_B64 = JPEG.toString("base64");
const BIG = Buffer.concat([PNG, Buffer.alloc(MAX_MEDIA_BYTES + 1024)]); // just over the cap, still a PNG
const BIG_B64 = BIG.toString("base64");
const HTML_B64 = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");

let dir, ws, stateDir, gateway, server, base;
let rows = []; // what sessions_history / chat.history return for the app session
let chatBodies = []; // chat-completions bodies the fake gateway received
let chatMode = "ok"; // ok | limit | boom
const rpc = [];

const row = (id, role, content, ts, fields = {}) => ({ role, content, timestamp: ts, __openclaw: { id, ...(fields.facts ? { media: fields.facts } : {}) } });

async function fakeGatewayCall(method, params) {
  rpc.push({ method, params });
  if (method === "chat.history") return { sessionKey: params.sessionKey, messages: rows.filter((m) => m.__openclaw.id === params.messageId) };
  if (method === "artifacts.download") {
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
  fs.writeFileSync(path.join(dir, "openclaw.json"), "{}");
  const abs = `${stateDir}/media/inbound/wa-photo---11.jpg`;
  rows = [
    // the engine's own history view of an app photo: inline payload replaced by an artifact id
    row("msg-art-0001", "user", [{ type: "text", text: "انظر" }, { type: "image", mimeType: "image/jpeg", artifactId: "artifact_jpeg", omitted: true, bytes: JPEG.length }], 10),
    // a photo sent with no words: the engine writes its own sentence for it
    row("msg-art-0002", "user", [{ type: "text", text: IMAGE_ONLY_PLACEHOLDER }, { type: "image", mimeType: "image/jpeg", artifactId: "artifact_jpeg", omitted: true, bytes: JPEG.length }], 11),
    // raw transcript shape: the payload inline
    row("msg-inl-0001", "user", [{ type: "text", text: "صورة مضمنة" }, { type: "image", data: PNG_B64, mimeType: "image/png" }], 12),
    row("msg-inl-0002", "user", [{ type: "image", data: PNG_B64, mimeType: "image/png" }], 13), // image only, nothing else: used to vanish
    row("msg-inl-0003", "user", [{ type: "text", text: "شكل المزوّد" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 }, mimeType: "image/png" }], 14),
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
        if (tool === "sessions_history") return res.end(JSON.stringify({ ok: true, result: { details: { sessionKey: APP_SESSION_KEY, hasMore: false, messages: rows } } }));
        if (tool === "sessions_list") return res.end(JSON.stringify({ ok: true, result: { details: { sessions: [{ key: APP_SESSION_KEY }], hasMore: false } } }));
        return res.end(JSON.stringify({ ok: false }));
      }
      chatBodies.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (chatMode === "limit") return res.end(`data: ${JSON.stringify({ error: { message: "429 The usage limit has been reached" } })}\n\n`);
      if (chatMode === "boom") return res.end(`data: ${JSON.stringify({ error: { message: "provider exploded" } })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "تم" } }] })}\n\n`);
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
  assert.equal(extractMedia(rows[4], k).media[0].avail, true, "provider shape: source.data");
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
  assert.ok((await getMedia("msg-inl-0003", media(h, "msg-inl-0003").media[0].ref)).bytes.equals(PNG));
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
