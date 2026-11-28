// B4 (P2-B4-1): the separate write link. A FAKE WebSocket stands in for the gateway (shapes from the P2-B4-1 lab, alt-link/l1x/l2).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DEFAULT_LIMITS, WRITE_LINK_CONFIG, WRITE_METHODS, attachmentsTooLarge, createGatewayWriteLink, limitsFromHello, validChatAbortParams, validChatSendParams } from "./gateway-write-link.js";
import { LINK_METHODS, LINK_SCOPES } from "./gateway-link.js";

const TOKEN = "synthetic-gateway-token-0123456789abcdef";
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));
const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };
const K = "9a9f4cbf-3890-428f-ba8d-b5b33713034c";
const HEX = "0123456789abcdef0123456789abcdef";
const KEY = `app:owner:${HEX}`;
const png = (bytes) => { const b = Buffer.alloc(bytes); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); return b.toString("base64"); };

/** onReq(frame, reply, sock): return true when handled. `hello` overrides the hello-ok payload. */
function fakeGateway({ scopes = [...WRITE_LINK_CONFIG.scopes], hello = {}, onReq, silent = () => false } = {}) {
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; this.closed = false; this.readyState = 0; sockets.push(this);
      setImmediate(() => { this.readyState = 1; if (!silent(sockets.length)) this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }); }); }
    emit(f) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(f) }); }
    send(raw) {
      if (this.readyState === 0) throw new Error("InvalidStateError"); // WHATWG: only CONNECTING throws …
      if (this.readyState !== 1) { this.dropped = (this.dropped ?? 0) + 1; return undefined; } // … CLOSING/CLOSED silently drop the frame
      const f = JSON.parse(raw); this.sent.push(f);
      const reply = (ok, payload, error) => setImmediate(() => this.emit({ type: "res", id: f.id, ok, payload, error }));
      if (f.method === "connect") return reply(true, { type: "hello-ok", protocol: 4, auth: { role: "operator", scopes }, policy: { tickIntervalMs: 15000, maxPayload: 26214400, attachments: { maxBytes: 19464192, maxImageBytes: 6291456 } }, ...hello });
      if (onReq?.(f, reply, this)) return undefined;
      return reply(true, { runId: f.params?.idempotencyKey, status: "started" });
    }
    close() { if (this.closed) return; this.closed = true; this.readyState = 3; setImmediate(() => this.onclose?.({ code: 1000 })); }
    event(name, payload) { this.emit({ type: "event", event: name, payload }); }
  }
  return { FakeWS, sockets, last: () => sockets.at(-1) };
}
const up = async (o = {}, linkOpts = {}) => {
  const gw = fakeGateway(o);
  const link = createGatewayWriteLink({ url: "ws://127.0.0.1:1", token: TOKEN, WebSocketImpl: gw.FakeWS, ...linkOpts });
  link.start(); await until(() => link.isUp());
  return { gw, link };
};

test("D-B4-10 default: ONE named config — write+admin+approvals, gateway-client/backend, no caps, suppress flag always on", async () => {
  assert.equal(WRITE_LINK_CONFIG.decisionStatus, "PENDING OWNER DECISION");
  assert.equal(WRITE_LINK_CONFIG.decision, "D-B4-10");
  assert.deepEqual([...WRITE_LINK_CONFIG.scopes], ["operator.write", "operator.admin", "operator.approvals"]);
  assert.deepEqual([...WRITE_LINK_CONFIG.caps], []);
  assert.equal(WRITE_LINK_CONFIG.suppressCommandInterpretation, true);
  assert.ok(Object.isFrozen(WRITE_LINK_CONFIG) && Object.isFrozen(WRITE_LINK_CONFIG.scopes));
  const { gw, link } = await up();
  const c = gw.last().sent.find((f) => f.method === "connect").params;
  assert.deepEqual(c.client, { id: "gateway-client", version: "basht-bridge-write/1", platform: process.platform, mode: "backend" });
  assert.notEqual(c.client.id, "webchat"); assert.notEqual(c.client.id, "openclaw-control-ui");
  assert.deepEqual(c.scopes, [...WRITE_LINK_CONFIG.scopes]);
  assert.deepEqual(c.caps, []);
  assert.deepEqual(c.auth, { token: TOKEN });
  await link.chatSend({ sessionKey: KEY, message: "hello", idempotencyKey: K });
  const f = gw.last().sent.find((x) => x.method === "chat.send");
  assert.deepEqual(f.params, { sessionKey: KEY, message: "hello", idempotencyKey: K, suppressCommandInterpretation: true }, "the closed, lab-verified frame");
  link.stop();
});

test("chat.send and chat.abort are the only methods; chat.send never rides on the admin link", async () => {
  assert.deepEqual([...WRITE_METHODS].sort(), ["chat.abort", "chat.send"]);
  assert.ok(!LINK_METHODS.has("chat.send") && !LINK_METHODS.has("chat.abort"), "the admin link allowlist is unchanged");
  assert.ok(!LINK_SCOPES.includes("operator.write"), "the admin link never gets write scope");
  const { gw, link } = await up();
  const before = gw.last().sent.length;
  for (const m of ["chat.send", "sessions.patch", "config.get", "sessions.reset", "chat.inject"]) await assert.rejects(link.request(m, {}), (e) => e.code !== undefined);
  assert.equal(gw.last().sent.length, before, "nothing written");
  link.stop();
});

test("a link granted fewer scopes is never used (e.g. no admin => suppress flag would be refused)", async () => {
  const gw = fakeGateway({ scopes: ["operator.write", "operator.approvals"] });
  const link = createGatewayWriteLink({ url: "ws://x", token: TOKEN, WebSocketImpl: gw.FakeWS });
  link.start();
  await until(() => link.status().lastError === "scopes_not_granted");
  assert.equal(link.isUp(), false);
  await assert.rejects(link.chatSend({ sessionKey: KEY, message: "x", idempotencyKey: K }), { code: "not_written" });
  link.stop();
});

test("closed params: keys, key form (unqualified only), id form, attachment shape; nothing written on refusal", async () => {
  const good = { sessionKey: KEY, message: "hi", idempotencyKey: K, suppressCommandInterpretation: true };
  assert.equal(validChatSendParams(good), true);
  assert.equal(validChatSendParams({ ...good, sessionKey: "app:owner" }), true);
  for (const bad of [{ ...good, sessionKey: `agent:main:${KEY}` }, { ...good, sessionKey: KEY.toUpperCase() }, { ...good, sessionKey: `${KEY}:x` }, { ...good, sessionKey: "agent:main:main" },
    { ...good, sessionKey: "main" }, { ...good, sessionKey: "agent:main:whatsapp:direct:+966500000001" }, { ...good, idempotencyKey: K.toUpperCase() }, { ...good, idempotencyKey: "x" },
    { ...good, suppressCommandInterpretation: false }, (({ suppressCommandInterpretation, ...r }) => r)(good), { ...good, deliver: true }, { ...good, thinking: "high" },
    { ...good, queueMode: "steer" }, { ...good, originatingChannel: "whatsapp" }, { ...good, toolBindings: {} }, { ...good, sessionId: "s" }, { ...good, message: "x".repeat(8001) },
    { ...good, message: "  " }, { ...good, attachments: [] }, { ...good, attachments: [{ type: "file", mimeType: "image/png", fileName: "a.png", content: "AAAA" }] },
    { ...good, attachments: [{ type: "image", mimeType: "image/png", fileName: "../a.png", content: "AAAA" }] },
    { ...good, attachments: [{ type: "image", mimeType: "image/png", fileName: "a.png", content: "AAAA", extra: 1 }] }, null, [], "x"]) {
    assert.equal(validChatSendParams(bad), false, JSON.stringify(bad)?.slice(0, 120));
  }
  assert.equal(validChatAbortParams({ sessionKey: KEY, runId: K }), true);
  for (const bad of [{ sessionKey: `agent:main:${KEY}`, runId: K }, { sessionKey: KEY }, { sessionKey: KEY, runId: K, discardPendingInput: true }, { sessionKey: KEY, runId: "chatcmpl_x" }]) {
    assert.equal(validChatAbortParams(bad), false, JSON.stringify(bad));
  }
  const { gw, link } = await up();
  const before = gw.last().sent.length;
  await assert.rejects(link.chatSend({ sessionKey: `agent:main:${KEY}`, message: "x", idempotencyKey: K }), { code: "bad_params" });
  await assert.rejects(link.chatSend({ sessionKey: KEY, message: "x", idempotencyKey: "nope" }), { code: "bad_params" });
  await assert.rejects(link.chatAbort({ sessionKey: `agent:main:${KEY}`, runId: K }), { code: "bad_params" });
  assert.equal(gw.last().sent.length, before);
  link.stop();
});

test("failure codes: not_written (definite) before the write; ack_lost and ack_timeout (unknown) after it; never link_down; never retried", async () => {
  // link down / not started: nothing written
  const idle = createGatewayWriteLink({ url: "ws://x", token: TOKEN, WebSocketImpl: fakeGateway().FakeWS });
  await assert.rejects(idle.chatSend({ sessionKey: KEY, message: "x", idempotencyKey: K }), { code: "not_written" });
  // send() throws: not written
  const a = await up({ onReq: (f) => { if (f.method === "chat.send") throw new Error("boom"); return false; } });
  await assert.rejects(a.link.chatSend({ sessionKey: KEY, message: "x", idempotencyKey: K }), { code: "not_written" });
  a.link.stop();
  // socket not OPEN (closing): a WHATWG send would silently drop -> refuse as not_written instead of "written"
  const b = await up();
  b.gw.last().readyState = 2;
  await assert.rejects(b.link.chatSend({ sessionKey: KEY, message: "x", idempotencyKey: K }), { code: "not_written" });
  assert.equal(b.gw.last().dropped ?? 0, 0, "not even handed to a closing socket");
  b.link.stop();
  // written, then the socket closes before the answer: ack_lost (the engine may have it: lab l1-acklost, the run completed)
  let writes = 0;
  const c = await up({ onReq: (f, _r, sock) => { if (f.method === "chat.send") { writes++; setImmediate(() => sock.close()); return true; } return false; } });
  await assert.rejects(c.link.chatSend({ sessionKey: KEY, message: "x", idempotencyKey: K }), (e) => e.code === "ack_lost" && e.code !== "link_down");
  await until(() => c.link.isUp() || c.link.status().state === "down");
  assert.equal(writes, 1, "not re-sent on reconnect");
  c.link.stop();
  // written, never answered: ack_timeout
  const d = await up({ onReq: (f) => f.method === "chat.send" }, { ackTimeoutMs: 30 });
  await assert.rejects(d.link.chatSend({ sessionKey: KEY, message: "x", idempotencyKey: K }), { code: "ack_timeout" });
  assert.equal(d.gw.last().sent.filter((f) => f.method === "chat.send").length, 1, "no retry");
  d.link.stop();
  // a gateway refusal is an answer, with its code/reason
  const e = await up({ onReq: (f, reply) => { if (f.method === "chat.send") { reply(false, undefined, { code: "INVALID_REQUEST", message: "chat-request-conflict", details: { reason: "chat-request-conflict" } }); return true; } return false; } });
  await assert.rejects(e.link.chatSend({ sessionKey: KEY, message: "x", idempotencyKey: K }), (er) => er.refused === true && er.code === "INVALID_REQUEST" && er.reason === "chat-request-conflict");
  e.link.stop();
});

test("sizes are checked against hello-ok limits BEFORE writing: too_large is definite, an oversize frame is never written (L2: 1009)", async () => {
  assert.deepEqual(limitsFromHello({ policy: { maxPayload: 26214400, attachments: { maxBytes: 19464192, maxImageBytes: 6291456 } } }), { maxPayload: 26214400, maxBytes: 19464192, maxImageBytes: 6291456 });
  assert.deepEqual(limitsFromHello({}), { ...DEFAULT_LIMITS });
  assert.equal(limitsFromHello({ policy: { attachments: { maxBytes: 1000, maxImageBytes: 5000 } } }).maxImageBytes, 1000, "image limit never above maxBytes");
  const img = (n) => ({ type: "image", mimeType: "image/png", fileName: "a.png", content: png(n) });
  const L = { maxPayload: 26214400, maxBytes: 19464192, maxImageBytes: 6291456 };
  assert.equal(attachmentsTooLarge([img(6291456)], L), null);
  assert.equal(attachmentsTooLarge([img(6291457)], L), "image_too_large");
  assert.equal(attachmentsTooLarge([img(5_000_000), img(5_000_000), img(5_000_000), img(5_000_000)], L), "images_too_large");
  const { gw, link } = await up({ hello: { policy: { tickIntervalMs: 15000, maxPayload: 300_000, attachments: { maxBytes: 1_000_000, maxImageBytes: 150_000 } } } });
  const before = gw.last().sent.length;
  await assert.rejects(link.chatSend({ sessionKey: KEY, message: "x", idempotencyKey: K, attachments: [img(160_000)] }), { code: "too_large", reason: "image_too_large" });
  await assert.rejects(link.chatSend({ sessionKey: KEY, message: "x", idempotencyKey: K, attachments: [img(140_000), img(140_000)] }), { code: "too_large", reason: "frame_too_large" });
  assert.equal(gw.last().sent.length, before, "nothing written");
  assert.equal(gw.last().closed, false, "the link stays up");
  await link.chatSend({ sessionKey: KEY, message: "x", idempotencyKey: K, attachments: [img(100_000)] });
  link.stop();
});

test("events reach listeners (chat deltas of every session are broadcast to every operator link, L3)", async () => {
  const { gw, link } = await up();
  const seen = [];
  const off = link.onEvent((n, p) => seen.push([n, p.state]));
  gw.last().event("chat", { runId: K, sessionKey: `agent:main:${KEY}`, seq: 1, state: "delta", deltaText: "a" });
  await until(() => seen.length === 1);
  off();
  gw.last().event("chat", { runId: K, state: "final" });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, [["chat", "delta"]]);
  link.stop();
});

test("m11: a socket that opens but never sends connect.challenge is dropped after the connect timeout, and the link reconnects", async () => {
  const gw = fakeGateway({ silent: (n) => n === 1 }); // the first socket stays silent, the second one behaves
  const link = createGatewayWriteLink({ url: "ws://x", token: TOKEN, WebSocketImpl: gw.FakeWS, connectTimeoutMs: 40, random: () => 0 });
  link.start();
  await until(() => link.status().state === "down", 1500);
  assert.equal(link.status().lastError, "connect_timeout");
  assert.equal(gw.sockets[0].closed, true);
  await until(() => link.isUp(), 3000); // backoff 1 s * 0.8, then a normal handshake
  assert.equal(gw.sockets.length, 2);
  link.stop();
});
