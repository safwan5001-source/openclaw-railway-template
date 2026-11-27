// BASHT app bridge B1 + B2: photos on the turn, media out (containment, MIME, size, refs tied to a message), «محادثة جديدة»,
// earlier rows across a reset, search over readable conversations only, tool steps (names only).
// A FAKE gateway stands in for OpenClaw (loopback only, synthetic tokens, temp dirs).
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { APP_SESSION_KEY, createAppBridge } from "./app-bridge.js";
import { MAX_IMAGES, bytesMatch, extractMedia, mediaRef, openMediaFile, parseImages, resolveSource, splitAttachedMarkers,
  splitMediaLines, turnContent } from "./app-bridge-media.js";
import { cleanSnippet as cleanSnippetForTest, stepsFrom } from "./app-bridge-convo.js";

const APP_TOKEN = "synthetic-app-token-0123456789abcdef0123";
const GW_TOKEN = "synthetic-gateway-token-0123456789abcdef";
const OWNER = "+966500000001";
const OWNER_KEY = `agent:main:whatsapp:direct:${OWNER}`;
const OTHER_KEY = "agent:main:whatsapp:direct:+966511111111";
const PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(40, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const PDF = Buffer.from("%PDF-1.4\n%%EOF\n");

let dir, ws, stateDir, outside, gateway, server, base;
const seen = []; // requests the fake gateway received
const rpc = [];  // gatewayCall(method, params)
let appRows = []; // the app session's current projection (sessions_history)
let archive = []; // every row ever (chat.history anchored reads)
let hasActiveRun = false;
let describeDelay = 0; // ms a sessions.describe takes (holds a reset in flight)
let resets = 0;
let describing = 0, maxDescribing = 0; // concurrent sessions.describe calls (integration: /new joins the settings queue)

const row = (id, role, content, ts, extra = {}) => ({ role, content, timestamp: ts, __openclaw: { id, ...(extra.kind ? { kind: extra.kind } : {}) }, ...extra.fields });

async function fakeGatewayCall(method, params) {
  rpc.push({ method, params });
  if (method === "sessions.describe") {
    describing++; maxDescribing = Math.max(maxDescribing, describing);
    try { if (describeDelay) await new Promise((r) => setTimeout(r, describeDelay)); } finally { describing--; }
    return { session: { key: params.key, hasActiveRun } };
  }
  if (method === "sessions.reset") {
    resets++;
    const reset = row(`reset-row-${resets}`, "system", [{ type: "text", text: "Reset" }], 5000 + resets, { kind: "reset" });
    archive.push(reset); appRows = [reset];
    return { ok: true, key: params.key, entry: { sessionFile: "/data/.openclaw/secret.jsonl" } };
  }
  if (method === "sessions.search") {
    return { results: [
      { sessionKey: APP_SESSION_KEY, messageId: "msg-app-01", role: "assistant", timestamp: 100, snippet: `التقرير جاهز\nMEDIA:${ws}/out/r.pdf`, score: 2 },
      { sessionKey: OTHER_KEY, messageId: "msg-other-1", role: "user", timestamp: 90, snippet: "رسالة شخص آخر" },
      { sessionKey: OWNER_KEY, messageId: "msg-wa-0001", role: "user", timestamp: 80, snippet: "ملف /data/workspace/secret.txt هنا" },
      { sessionKey: APP_SESSION_KEY, messageId: "msg-app-tool", role: "toolResult", timestamp: 70, snippet: "tool output" },
    ] };
  }
  if (method === "chat.history") {
    // anchored read: a window inside the anchor's own reset segment
    const i = archive.findIndex((m) => m.__openclaw.id === params.messageId);
    if (i < 0) return { messages: [] };
    let lo = i; while (lo > 0 && archive[lo - 1].__openclaw.kind !== "reset") lo--;
    let hi = i; while (hi < archive.length - 1 && archive[hi + 1].__openclaw.kind !== "reset") hi++;
    const half = Math.floor((params.limit - 1) / 2);
    return { sessionKey: params.sessionKey, messages: archive.slice(Math.max(lo, i - half), Math.min(hi, i + half) + 1) };
  }
  if (method === "artifacts.download") {
    if (params.artifactId === "artifact_png") return { artifact: { mimeType: "image/png", sizeBytes: PNG.length }, encoding: "base64", data: PNG.toString("base64") };
    if (params.artifactId === "artifact_fake") return { artifact: { mimeType: "image/png" }, encoding: "base64", data: Buffer.from("<html>").toString("base64") };
    const e = new Error("gone"); e.refused = true; throw e;
  }
  throw new Error(`unexpected gateway call ${method}`);
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-bridge-media-"));
  ws = path.join(dir, "workspace"); stateDir = path.join(dir, "state"); outside = path.join(dir, "outside");
  for (const d of [path.join(ws, "out"), path.join(stateDir, "media", "inbound"), outside]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(ws, "out", "chart.png"), PNG);
  fs.writeFileSync(path.join(ws, "out", "report.pdf"), PDF);
  fs.writeFileSync(path.join(ws, "out", "fake.png"), Buffer.from("<script>alert(1)</script>"));
  fs.writeFileSync(path.join(ws, "out", "notes.txt"), "سطر\nline");
  fs.writeFileSync(path.join(ws, "out", "binary.txt"), Buffer.from([1, 0, 2, 0]));
  fs.writeFileSync(path.join(ws, "out", "big.png"), Buffer.concat([PNG, Buffer.alloc(21 * 1024 * 1024)]));
  fs.writeFileSync(path.join(ws, "out", "script.sh"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(stateDir, "media", "inbound", "doc---1.pdf"), PDF);
  fs.writeFileSync(path.join(outside, "secret.png"), PNG);
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}");
  fs.symlinkSync(path.join(outside, "secret.png"), path.join(ws, "out", "link.png"));
  fs.symlinkSync(outside, path.join(ws, "escape"));
  fs.writeFileSync(path.join(dir, "openclaw.json"), JSON.stringify({ commands: { ownerAllowFrom: [`whatsapp:${OWNER}`] } }));

  const media = [
    `MEDIA:${ws}/out/chart.png`, "MEDIA:./out/report.pdf", `MEDIA:"${ws}/out/fake.png"`, "MEDIA:/etc/passwd", "MEDIA:../outside/secret.png",
    "MEDIA:./out/link.png", "MEDIA:./escape/secret.png", "MEDIA:./out/big.png", "MEDIA:./out", "MEDIA:https://example.com/a.png?x=1",
  ].join("\n");
  archive = [
    row("msg-old-001", "user", "رسالة قديمة", 10),
    row("msg-old-002", "assistant", [{ type: "text", text: "رد قديم" }], 11),
    row("msg-app-01", "user", [{ type: "text", text: "صف الصورة" }, { type: "image", mimeType: "image/png", artifactId: "artifact_png", omitted: true, bytes: PNG.length }], 20),
    row("msg-app-02", "assistant", [{ type: "text", text: `هذه النتائج.\n\n${media}\n\n\`\`\`\nMEDIA:./out/chart.png\n\`\`\`\nانتهى.` }], 21, { fields: { provider: "mock", model: "echo" } }),
    row("msg-app-03", "user", "خذ الملف [media attached: media://inbound/doc---1.pdf]", 22),
    row("msg-app-04", "assistant", [{ type: "text", text: "صورة مزيفة" }, { type: "image", mimeType: "image/png", artifactId: "artifact_fake" }], 23),
  ];
  appRows = [...archive];

  gateway = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, body });
      if (req.headers.authorization !== `Bearer ${GW_TOKEN}`) { res.writeHead(401); return res.end(); }
      res.writeHead(200, { "content-type": req.url === "/tools/invoke" ? "application/json" : "text/event-stream" });
      if (req.url === "/tools/invoke") {
        const { tool, args } = JSON.parse(body);
        if (tool === "sessions_list") return res.end(JSON.stringify({ ok: true, result: { details: { sessions: [{ key: APP_SESSION_KEY }, { key: OWNER_KEY }, { key: OTHER_KEY }], hasMore: false } } }));
        if (tool === "sessions_history") {
          const rows = args.sessionKey === APP_SESSION_KEY ? appRows : args.sessionKey === OWNER_KEY ? [row("msg-wa-0001", "user", "مرحبا", 1)] : [];
          return res.end(JSON.stringify({ ok: true, result: { details: { sessionKey: args.sessionKey, hasMore: false, messages: rows.slice(-(args.limit ?? 50)) } } }));
        }
        return res.end(JSON.stringify({ ok: false }));
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "تم" } }] })}\n\n`);
      setTimeout(() => res.end("data: [DONE]\n\n"), 30);
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

const call = (p, { method = "GET", token = APP_TOKEN, body, raw = false } = {}) =>
  fetch(base + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, headers: r.headers, ...(raw ? { bytes: Buffer.from(await r.arrayBuffer()) } : { json: await r.json().catch(() => null) }) }));
const waitRun = async (id) => { for (let i = 0; i < 200; i++) { const r = await call(`/runs/${id}`); if (r.json.status !== "running") return r.json; await new Promise((x) => setTimeout(x, 15)); } throw new Error("run did not finish"); };
const history = async (key = APP_SESSION_KEY, q = "") => (await call(`/history?key=${encodeURIComponent(key)}${q}`)).json;

// ---------------------------------------------------------------- unit: helpers -------------------------------------------------

test("parseImages: count, type, base64, size and magic bytes are enforced before the engine", () => {
  const png = PNG.toString("base64");
  assert.deepEqual(parseImages(undefined), { images: [] });
  assert.equal(parseImages([{ mime: "image/png", data: png }]).images.length, 1);
  assert.equal(parseImages(Array.from({ length: MAX_IMAGES + 1 }, () => ({ mime: "image/png", data: png }))).error, "too_many_images");
  assert.equal(parseImages([{ mime: "image/svg+xml", data: png }]).error, "unsupported_image");
  assert.equal(parseImages([{ mime: "application/pdf", data: PDF.toString("base64") }]).error, "unsupported_image");
  assert.equal(parseImages([{ mime: "image/jpeg", data: png }]).error, "unsupported_image", "bytes must match the declared type");
  assert.equal(parseImages([{ mime: "image/png", data: "not base64!" }]).error, "bad_request");
  assert.equal(parseImages([{ mime: "image/png", data: `data:image/png;base64,${png}` }]).error, "bad_request", "no data: prefix, no URLs");
  const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]).toString("base64");
  assert.equal(parseImages([{ mime: "image/png", data: big }]).error, "image_too_large");
  const nine = Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]).toString("base64");
  assert.equal(parseImages([{ mime: "image/png", data: nine }, { mime: "image/png", data: nine }]).error, "images_too_large");
  assert.equal(parseImages("x").error, "bad_request");
});

test("turnContent: text then image_url data parts; plain string without images", () => {
  assert.equal(turnContent("hi", []), "hi");
  const c = turnContent("hi", [{ mime: "image/jpeg", data: "AAAA" }]);
  assert.deepEqual(c, [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }]);
  assert.deepEqual(turnContent("", [{ mime: "image/png", data: "AAAA" }]).map((p) => p.type), ["image_url"]);
});

test("MEDIA: lines follow the engine rule (standalone, <=3 spaces, not in code); attachment markers are lifted", () => {
  const s = splitMediaLines("a\nMEDIA:/x/a.png\n   MEDIA: \"./b c.pdf\"\n    MEDIA:/code.png\n```\nMEDIA:/fenced.png\n```\nsee MEDIA:/inline.png\n**MEDIA:/bold.png**");
  assert.deepEqual(s.sources, ["/x/a.png", "./b c.pdf"]);
  assert.ok(s.text.includes("MEDIA:/fenced.png") && s.text.includes("MEDIA:/inline.png") && s.text.includes("    MEDIA:/code.png"));
  const a = splitAttachedMarkers("خذ [media attached: media://inbound/a---1.pdf] و [media attached 2/2: media://inbound/b.png (image/png)]");
  assert.deepEqual(a.sources, ["media://inbound/a---1.pdf", "media://inbound/b.png"]);
  assert.equal(a.text, "خذ  و");
});

test("refs are opaque, stable and bound to session + message + position + source", () => {
  const a = mediaRef(APP_SESSION_KEY, "m1", 0, "/x.png");
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, mediaRef(APP_SESSION_KEY, "m1", 0, "/x.png"));
  assert.notEqual(a, mediaRef(APP_SESSION_KEY, "m2", 0, "/x.png"));
  assert.notEqual(a, mediaRef(OWNER_KEY, "m1", 0, "/x.png"));
  const { media } = extractMedia(archive[3], APP_SESSION_KEY);
  assert.ok(media.length >= 9 && media.every((m) => m.kind === "link" || /^[0-9a-f]{32}$/.test(m.ref)));
});

test("bytesMatch: images, PDF, office, text; anything else is refused", () => {
  assert.ok(bytesMatch("image/png", PNG) && bytesMatch("image/jpeg", JPEG) && bytesMatch("application/pdf", PDF));
  assert.ok(!bytesMatch("image/png", JPEG) && !bytesMatch("image/png", Buffer.from("<svg")));
  assert.ok(bytesMatch("text/plain", Buffer.from("hello")) && !bytesMatch("text/plain", Buffer.from([1, 0])));
  assert.ok(bytesMatch("application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from("PK\x03\x04", "latin1")));
  assert.ok(!bytesMatch("application/x-sh", Buffer.from("#!/bin/sh")));
});

test("resolveSource/openMediaFile: only regular, allowlisted, matching files inside the engine roots", async () => {
  const ctx = { workspaceDir: ws, stateDir, roots: [fs.realpathSync(ws), fs.realpathSync(path.join(stateDir, "media"))] };
  assert.equal(resolveSource("media://inbound/../../openclaw.json", ctx), null);
  assert.equal(resolveSource("media://inbound/..%2F..%2Fopenclaw.json", ctx), null);
  assert.equal(resolveSource("file:///etc/passwd", ctx), null);
  assert.equal(resolveSource("a\0b", ctx), null);
  const ok = await openMediaFile("./out/chart.png", ctx); assert.equal(ok.mime, "image/png"); await ok.fh.close();
  const inbound = await openMediaFile("media://inbound/doc---1.pdf", ctx); assert.equal(inbound.mime, "application/pdf"); await inbound.fh.close();
  for (const [src, err] of [["/etc/passwd", "unavailable"], ["../outside/secret.png", "unavailable"], ["./out/link.png", "unavailable"],
    ["./escape/secret.png", "unavailable"], [`${stateDir}/openclaw.json`, "unavailable"], ["./out", "unsupported"], ["./out/fake.png", "unsupported"],
    ["./out/big.png", "too_large"], ["./out/script.sh", "unsupported"], ["./out/binary.txt", "unsupported"], ["./out/missing.png", "unavailable"]]) {
    assert.equal((await openMediaFile(src, ctx)).error, err, src);
  }
});

test("search snippets never carry MEDIA: refs or absolute paths", () => {
  assert.equal(cleanSnippetForTest(`التقرير\nMEDIA:/data/workspace/a.pdf`), "التقرير");
  assert.equal(cleanSnippetForTest("انظر /data/workspace/secret.txt الآن"), "انظر … الآن");
  assert.ok(!cleanSnippetForTest("x [media attached: media://inbound/a.pdf] y").includes("media://"));
});

test("stepsFrom: tool names in order, done once a result or a later reply exists; never arguments", () => {
  const rows = [
    { role: "user", timestamp: 10000, content: "x" },
    { role: "assistant", timestamp: 10001, content: [{ type: "toolCall", id: "c1", name: "web_search", arguments: { query: "secret query" } }] },
    { role: "toolResult", timestamp: 10002, toolCallId: "c1", content: "result text" },
    { role: "assistant", timestamp: 10003, content: [{ type: "toolCall", id: "c2", name: "exec", arguments: { command: "rm -rf /" } }, { type: "toolCall", name: "bad name!" }] },
    { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "old", name: "read" }] }, // before the turn
  ];
  const steps = stepsFrom(rows, 10000);
  assert.deepEqual(steps, [{ tool: "web_search", done: true }, { tool: "exec", done: false }]);
  assert.ok(!JSON.stringify(steps).includes("secret") && !JSON.stringify(steps).includes("rm -rf"));
});

// ---------------------------------------------------------------- routes ---------------------------------------------------------

test("every new route needs the app token", async () => {
  for (const [p, method] of [["/new", "POST"], ["/search?q=x", "GET"], ["/media?key=a&msg=msg-app-02&ref=" + "0".repeat(32), "GET"]]) {
    assert.equal((await call(p, { method, token: null })).status, 401, p);
    assert.equal((await call(p, { method, token: GW_TOKEN })).status, 401, p);
  }
});

test("send: photos reach the engine as image_url parts of the SAME app turn; bad photos never reach it", async () => {
  const before = seen.length;
  const r = await call("/send", { method: "POST", body: { message: "صف", images: [{ mime: "image/png", data: PNG.toString("base64") }], sessionKey: "agent:main:main" } });
  assert.equal(r.status, 202);
  await waitRun(r.json.runId);
  const turn = seen.slice(before).find((s) => s.url === "/v1/chat/completions");
  const content = JSON.parse(turn.body).messages[0].content;
  assert.deepEqual(content.map((p) => p.type), ["text", "image_url"]);
  assert.ok(content[1].image_url.url.startsWith("data:image/png;base64,"));
  // image-only turn is fine; bad image / too many / svg are 400 and never reach the gateway
  const only = await call("/send", { method: "POST", body: { message: "", images: [{ mime: "image/jpeg", data: JPEG.toString("base64") }] } });
  assert.equal(only.status, 202); await waitRun(only.json.runId);
  const n = seen.length;
  for (const images of [[{ mime: "image/svg+xml", data: PNG.toString("base64") }], [{ mime: "image/png", data: JPEG.toString("base64") }],
    Array.from({ length: 9 }, () => ({ mime: "image/png", data: PNG.toString("base64") }))]) {
    assert.equal((await call("/send", { method: "POST", body: { message: "x", images } })).status, 400);
  }
  assert.equal((await call("/send", { method: "POST", body: { message: "" } })).status, 400);
  assert.equal(seen.length, n);
});

test("send: only /send takes a large body; other routes keep 64 kB", async () => {
  const big = { model: "x".repeat(70 * 1024) };
  assert.equal((await call("/model", { method: "POST", body: big })).status, 413);
});

test("history: media refs instead of MEDIA: lines; no server path, artifact id or file name outside the allowlist leaks", async () => {
  const h = await history();
  const text = JSON.stringify(h);
  for (const leak of [ws, dir, "/etc/passwd", "artifact_png", "outside", "media://"]) assert.ok(!text.includes(leak), `leaked ${leak}`);
  const reply = h.messages.find((m) => m.id === "msg-app-02");
  assert.ok(!reply.text.includes("MEDIA:/") && reply.text.includes("هذه النتائج.") && reply.text.includes("```\nMEDIA:./out/chart.png\n```"));
  const by = Object.fromEntries(reply.media.filter((m) => m.kind !== "link").map((m) => [m.name, m]));
  assert.equal(by["chart.png"].kind, "image"); assert.equal(by["chart.png"].available, true); assert.equal(by["chart.png"].size, PNG.length);
  assert.equal(by["report.pdf"].kind, "file"); assert.equal(by["report.pdf"].mime, "application/pdf");
  assert.equal(by.passwd.available, false); assert.equal(by["secret.png"].available, false); assert.equal(by["link.png"].available, false);
  assert.deepEqual(reply.media.find((m) => m.kind === "link"), { kind: "link", name: "a.png", url: "https://example.com/a.png?x=1" });
  const user = h.messages.find((m) => m.id === "msg-app-01");
  assert.deepEqual(user.media.map((m) => [m.kind, m.mime, m.available]), [["image", "image/png", true]]);
  const att = h.messages.find((m) => m.id === "msg-app-03");
  assert.equal(att.text, "خذ الملف"); assert.equal(att.media[0].name, "doc---1.pdf");
});

test("media: serves allowed files and artifacts with fixed headers; refuses everything else", async () => {
  const h = await history();
  const reply = h.messages.find((m) => m.id === "msg-app-02");
  const ref = (name) => reply.media.find((m) => m.name === name).ref;
  const get = (msg, r, key = APP_SESSION_KEY) => call(`/media?key=${encodeURIComponent(key)}&msg=${msg}&ref=${r}`, { raw: true });
  const png = await get("msg-app-02", ref("chart.png"));
  assert.equal(png.status, 200); assert.ok(png.bytes.equals(PNG));
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.equal(png.headers.get("x-content-type-options"), "nosniff");
  assert.match(png.headers.get("content-disposition"), /^attachment; filename\*=UTF-8''chart\.png$/);
  assert.match(png.headers.get("content-security-policy"), /sandbox/);
  assert.equal((await get("msg-app-02", ref("report.pdf"))).headers.get("content-type"), "application/pdf");
  for (const [name, status] of [["passwd", 404], ["secret.png", 404], ["link.png", 404], ["fake.png", 415], ["big.png", 413], ["out", 415]]) {
    assert.equal((await get("msg-app-02", ref(name))).status, status, name);
  }
  // a ref only works for the message (and conversation) it came from
  assert.equal((await get("msg-app-01", ref("chart.png"))).status, 404);
  assert.equal((await get("msg-app-02", ref("chart.png"), OTHER_KEY)).status, 404);
  assert.equal((await get("msg-app-02", "f".repeat(32))).status, 404);
  assert.equal((await call(`/media?key=${encodeURIComponent(APP_SESSION_KEY)}&msg=../x&ref=${ref("chart.png")}`)).status, 400);
  // artifacts: the engine's own download; bytes must match the type
  const user = h.messages.find((m) => m.id === "msg-app-01");
  const art = await get("msg-app-01", user.media[0].ref);
  assert.equal(art.status, 200); assert.ok(art.bytes.equals(PNG));
  assert.deepEqual(rpc.findLast((c) => c.method === "artifacts.download").params, { sessionKey: APP_SESSION_KEY, artifactId: "artifact_png" });
  const fake = h.messages.find((m) => m.id === "msg-app-04");
  assert.equal((await get("msg-app-04", fake.media[0].ref)).status, 415);
  // the inbound store (media://inbound/<id>)
  const att = h.messages.find((m) => m.id === "msg-app-03");
  assert.ok((await get("msg-app-03", att.media[0].ref)).bytes.equals(PDF));
});

test("media: a ref not handed out by this process is re-derived from its own message (anchored read)", async () => {
  const fresh = express();
  fresh.use("/app/v1", createAppBridge({ token: APP_TOKEN, gatewayUrl: "http://127.0.0.1:1", gatewayToken: GW_TOKEN, configPath: path.join(dir, "openclaw.json"),
    gatewayCall: fakeGatewayCall, stateDir, workspaceDir: ws }));
  const s = fresh.listen(0, "127.0.0.1"); await new Promise((r) => s.once("listening", r));
  try {
    const r = mediaRef(APP_SESSION_KEY, "msg-app-02", 0, `${ws}/out/chart.png`);
    const res = await fetch(`http://127.0.0.1:${s.address().port}/app/v1/media?key=${encodeURIComponent(APP_SESSION_KEY)}&msg=msg-app-02&ref=${r}`, { headers: { authorization: `Bearer ${APP_TOKEN}` } });
    assert.equal(res.status, 200);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(PNG));
    assert.deepEqual(rpc.findLast((c) => c.method === "chat.history").params, { sessionKey: APP_SESSION_KEY, messageId: "msg-app-02", limit: 1 });
  } finally { s.close(); }
});

test("search: only readable conversations are searched and returned; snippets are cleaned", async () => {
  const r = await call(`/search?q=${encodeURIComponent("التقرير")}&sessionKeys=${encodeURIComponent(OTHER_KEY)}`);
  assert.equal(r.status, 200);
  const params = rpc.findLast((c) => c.method === "sessions.search").params;
  assert.equal(params.query, "التقرير");
  assert.ok(params.sessionKeys.includes(APP_SESSION_KEY) && params.sessionKeys.includes(OWNER_KEY) && !params.sessionKeys.includes(OTHER_KEY));
  assert.deepEqual(r.json.results.map((x) => [x.key, x.messageId]), [[APP_SESSION_KEY, "msg-app-01"], [OWNER_KEY, "msg-wa-0001"]]);
  assert.ok(!JSON.stringify(r.json).includes("/data/") && !JSON.stringify(r.json).includes(ws));
  assert.equal(r.json.results[0].label, "التطبيق");
  assert.equal((await call("/search?q=")).status, 400);
  assert.equal((await call(`/search?q=${"x".repeat(201)}`)).status, 400);
});

test("search (integration with security L9): main is searched only while it is owner-only", async () => {
  const cfgPath = path.join(dir, "openclaw.json");
  const original = fs.readFileSync(cfgPath, "utf8");
  const keysSearched = async () => {
    assert.equal((await call(`/search?q=${encodeURIComponent("x")}`)).status, 200);
    return rpc.findLast((c) => c.method === "sessions.search").params.sessionKeys;
  };
  try {
    assert.ok((await keysSearched()).includes("agent:main:main"), "no DM channel: main holds only the owner's messages");
    fs.writeFileSync(cfgPath, JSON.stringify({ commands: { ownerAllowFrom: [`whatsapp:${OWNER}`] }, channels: { whatsapp: { dmPolicy: "pairing" } } }));
    const keys = await keysSearched();
    assert.ok(!keys.includes("agent:main:main") && keys.includes(APP_SESSION_KEY), "other senders may land in main: not searched");
  } finally { fs.writeFileSync(cfgPath, original); }
});

test("new conversation: resets ONLY the app session, keeps every row readable, refuses while a turn runs", async () => {
  hasActiveRun = true;
  assert.equal((await call("/new", { method: "POST", body: { key: "agent:main:main" } })).status, 409);
  hasActiveRun = false;
  const r = await call("/new", { method: "POST", body: { key: "agent:main:main", sessionKey: OWNER_KEY } });
  assert.equal(r.status, 200); assert.equal(r.json.earlier, true);
  assert.ok(!JSON.stringify(r.json).includes("secret.jsonl"));
  assert.deepEqual(rpc.filter((c) => c.method === "sessions.reset").map((c) => c.params), [{ key: APP_SESSION_KEY, reason: "new" }]);
  const ledger = JSON.parse(fs.readFileSync(path.join(stateDir, "app-bridge", "resets.json"), "utf8"));
  assert.deepEqual(ledger.map((x) => [x.resetId, x.anchorId]), [["reset-row-1", "msg-app-04"]]);
  assert.equal(fs.statSync(path.join(stateDir, "app-bridge", "resets.json")).mode & 0o777, 0o600);
  // the default view starts at the reset; the earlier conversation is one cursor away
  const h = await history();
  assert.deepEqual(h.messages.map((m) => m.kind ?? m.role), ["reset"]);
  assert.equal(h.earlier, "reset-row-1");
  const older = await history(APP_SESSION_KEY, `&before=${h.earlier}`);
  assert.deepEqual(older.messages.map((m) => m.id), ["msg-old-001", "msg-old-002", "msg-app-01", "msg-app-02", "msg-app-03", "msg-app-04"]);
  assert.equal(older.earlier, null);
  // a second conversation, a second reset: paging walks back through both
  archive.push(row("msg-new-001", "user", "محادثة ثانية", 6000)); appRows.push(archive.at(-1));
  assert.equal((await call("/new", { method: "POST" })).status, 200);
  const h2 = await history();
  assert.equal(h2.earlier, "reset-row-2");
  const p1 = await history(APP_SESSION_KEY, `&before=${h2.earlier}`);
  assert.deepEqual(p1.messages.map((m) => m.kind ?? m.id), ["msg-new-001"]);
  assert.equal(p1.earlier, "reset-row-1");
  const p2 = await history(APP_SESSION_KEY, `&before=${p1.earlier}`);
  assert.equal(p2.messages.at(-1).id, "msg-app-04");
  // around: a window for a search hit; cursors are ids only
  const around = await history(APP_SESSION_KEY, "&around=msg-app-02");
  assert.ok(around.messages.some((m) => m.id === "msg-app-02") && around.found === true);
  assert.equal((await call(`/history?key=${encodeURIComponent(APP_SESSION_KEY)}&before=../../x`)).status, 400);
  assert.equal((await call(`/history?key=${encodeURIComponent(OTHER_KEY)}&around=msg-other-1`)).status, 404);
});

test("run view: steps are tool names only, refreshed from the app session while the turn runs", async () => {
  appRows = [row("msg-run-001", "user", "x", Date.now()),
    { role: "assistant", timestamp: Date.now() + 1, content: [{ type: "toolCall", id: "c9", name: "web_search", arguments: { query: "سر" } }], __openclaw: { id: "msg-run-002" } }];
  const r = await call("/send", { method: "POST", body: { message: "ابحث" } });
  const v = await call(`/runs/${r.json.runId}`);
  assert.ok(Array.isArray(v.json.steps));
  await new Promise((x) => setTimeout(x, 30));
  const done = await waitRun(r.json.runId);
  assert.ok(Array.isArray(done.steps));
  assert.ok(!JSON.stringify(done).includes("سر"));
  const histCall = seen.findLast((s) => s.url === "/tools/invoke" && JSON.parse(s.body).args?.includeTools === true);
  assert.equal(JSON.parse(histCall.body).args.sessionKey, APP_SESSION_KEY);
});

// Review (Codex #1): a turn must never be accepted while «محادثة جديدة» is under way — the reset would wipe its context.
test("send during a reset is refused (409); the reset completes and sending works again", async () => {
  await waitRun((await call("/send", { method: "POST", body: { message: "قبل" } })).json.runId).catch(() => {});
  describeDelay = 150;
  const resets0 = rpc.filter((c) => c.method === "sessions.reset").length;
  const reset = call("/new", { method: "POST" });
  await new Promise((r) => setTimeout(r, 40)); // the reset is awaiting sessions.describe
  const turns0 = seen.filter((s) => s.url === "/v1/chat/completions").length;
  const send = await call("/send", { method: "POST", body: { message: "أثناء إعادة الضبط" } });
  assert.equal(send.status, 409);
  assert.equal(send.json.error, "busy");
  assert.equal((await reset).status, 200);
  describeDelay = 0;
  assert.equal(rpc.filter((c) => c.method === "sessions.reset").length, resets0 + 1);
  assert.equal(seen.filter((s) => s.url === "/v1/chat/completions").length, turns0, "the refused turn never reached the engine");
  const after = await call("/send", { method: "POST", body: { message: "بعد" } });
  assert.equal(after.status, 202);
  await waitRun(after.json.runId);
});

// Review (Codex #2): <stateDir>/media (or the workspace) may not exist when the wrapper starts; files that appear later are served.
test("new conversation (integration with model control): waits for a settings write in flight, never runs beside it", async () => {
  describeDelay = 120; maxDescribing = 0;
  try {
    const write = call("/thinking", { method: "POST", body: { level: "high" } }); // holds the settings queue while it describes
    await new Promise((r) => setTimeout(r, 30));
    const reset = call("/new", { method: "POST" });
    assert.equal((await write).status, 400, "the fake session offers no thinking levels");
    assert.equal((await reset).status, 200);
    assert.equal(maxDescribing, 1, "the reset's describe started only after the settings write had finished");
  } finally { describeDelay = 0; }
});

// Review (Codex, integration PR): a /new whose client gave up while it waited in the settings queue left that queue
// pending for ever (its response had already closed, so neither finish nor close fired again): every later model/thinking
// /fast write and every /send stalled until a restart. An abandoned reset is skipped and the queue moves on.
test("new conversation abandoned while queued: the settings queue is released (later writes and sends still work)", async () => {
  describeDelay = 150;
  const resets0 = rpc.filter((c) => c.method === "sessions.reset").length;
  try {
    const write = call("/thinking", { method: "POST", body: { level: "high" } }); // holds the settings queue
    await new Promise((r) => setTimeout(r, 30));
    const ac = new AbortController();
    const reset = fetch(base + "/new", { method: "POST", headers: { authorization: `Bearer ${APP_TOKEN}` }, signal: ac.signal }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 30));
    ac.abort(); // the owner closed the app while the reset waited
    await reset;
    await write;
  } finally { describeDelay = 0; }
  const next = await Promise.race([call("/thinking", { method: "POST", body: { level: "high" } }), new Promise((r) => setTimeout(() => r("stalled"), 3000))]);
  assert.notEqual(next, "stalled", "a later settings write must not wait behind the abandoned reset");
  assert.equal(next.status, 400);
  assert.equal(rpc.filter((c) => c.method === "sessions.reset").length, resets0, "the abandoned reset never ran");
  const send = await Promise.race([call("/send", { method: "POST", body: { message: "بعد الإلغاء" } }), new Promise((r) => setTimeout(() => r("stalled"), 3000))]);
  assert.notEqual(send, "stalled", "/send must not wait behind the abandoned reset");
  assert.equal(send.status, 202);
  await waitRun(send.json.runId);
});

test("media roots are resolved lazily: a root created after start is honoured", async () => {
  const late = fs.mkdtempSync(path.join(os.tmpdir(), "app-bridge-late-"));
  const lateState = path.join(late, "state"); const lateWs = path.join(late, "workspace");
  fs.mkdirSync(lateState, { recursive: true }); // no media/ and no workspace/ yet
  const app = express();
  app.use("/app/v1", createAppBridge({ token: APP_TOKEN, gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, gatewayToken: GW_TOKEN,
    configPath: path.join(dir, "openclaw.json"), gatewayCall: fakeGatewayCall, stateDir: lateState, workspaceDir: lateWs }));
  const s = app.listen(0, "127.0.0.1"); await new Promise((r) => s.once("listening", r));
  try {
    fs.mkdirSync(path.join(lateState, "media", "inbound"), { recursive: true });
    fs.writeFileSync(path.join(lateState, "media", "inbound", "late---1.pdf"), PDF);
    fs.mkdirSync(path.join(lateWs, "out"), { recursive: true });
    fs.writeFileSync(path.join(lateWs, "out", "late.png"), PNG);
    appRows = [row("msg-late-01", "assistant", [{ type: "text", text: "تم\n\nMEDIA:./out/late.png" }], Date.now()),
      row("msg-late-02", "user", "خذ [media attached: media://inbound/late---1.pdf]", Date.now())];
    const b = `http://127.0.0.1:${s.address().port}/app/v1`;
    const auth = { headers: { authorization: `Bearer ${APP_TOKEN}` } };
    const h = await (await fetch(`${b}/history?key=${encodeURIComponent(APP_SESSION_KEY)}`, auth)).json();
    const items = h.messages.flatMap((m) => m.media.map((x) => ({ ...x, msg: m.id })));
    assert.deepEqual(items.map((x) => [x.name, x.available]), [["late.png", true], ["late---1.pdf", true]]);
    for (const it of items) {
      const r = await fetch(`${b}/media?key=${encodeURIComponent(APP_SESSION_KEY)}&msg=${it.msg}&ref=${it.ref}`, auth);
      assert.equal(r.status, 200, it.name);
    }
  } finally { s.close(); fs.rmSync(late, { recursive: true, force: true }); }
});

// Review (Codex, round 3): two «محادثة جديدة» in a row (nothing said between them) must not make paging return the same
// conversation twice.
test("two resets in a row: one ledger entry, and paging back never repeats a conversation", async () => {
  const saved = { archive, appRows };
  const st = fs.mkdtempSync(path.join(os.tmpdir(), "app-bridge-twice-"));
  archive = [row("conv-a-0001", "user", "أ", 1), row("conv-a-0002", "assistant", [{ type: "text", text: "ب" }], 2)];
  appRows = [...archive];
  const app = express();
  app.use("/app/v1", createAppBridge({ token: APP_TOKEN, gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, gatewayToken: GW_TOKEN,
    configPath: path.join(dir, "openclaw.json"), gatewayCall: fakeGatewayCall, stateDir: st, workspaceDir: ws }));
  const s = app.listen(0, "127.0.0.1"); await new Promise((r) => s.once("listening", r));
  const b = `http://127.0.0.1:${s.address().port}/app/v1`;
  const auth = { authorization: `Bearer ${APP_TOKEN}` };
  const get = async (q = "") => (await fetch(`${b}/history?key=${encodeURIComponent(APP_SESSION_KEY)}${q}`, { headers: auth })).json();
  try {
    for (let i = 0; i < 2; i++) assert.equal((await fetch(`${b}/new`, { method: "POST", headers: auth })).status, 200);
    const ledger = JSON.parse(fs.readFileSync(path.join(st, "app-bridge", "resets.json"), "utf8"));
    assert.equal(ledger.length, 1, "the empty conversation between the two resets leaves no entry");
    let cursor = (await get()).earlier;
    assert.ok(cursor);
    const seenIds = [];
    for (let page = 0; cursor && page < 5; page++) {
      const p = await get(`&before=${cursor}`);
      for (const m of p.messages) { assert.ok(!seenIds.includes(m.id), `repeated ${m.id}`); seenIds.push(m.id); }
      cursor = p.earlier;
    }
    assert.deepEqual(seenIds, ["conv-a-0001", "conv-a-0002"]);
    assert.equal(cursor, null);
    // a ledger written before this fix (two entries with the same anchor) is walked without repeating either
    fs.writeFileSync(path.join(st, "app-bridge", "resets.json"), JSON.stringify([
      { resetId: "old-reset-1", anchorId: "conv-a-0002", at: 1 }, { resetId: ledger[0].resetId, anchorId: "conv-a-0002", at: 2 }]));
    const p1 = await get(`&before=${ledger[0].resetId}`);
    assert.deepEqual(p1.messages.map((m) => m.id), ["conv-a-0001", "conv-a-0002"]);
    assert.equal(p1.earlier, null);
  } finally { s.close(); fs.rmSync(st, { recursive: true, force: true }); archive = saved.archive; appRows = saved.appRows; }
});
