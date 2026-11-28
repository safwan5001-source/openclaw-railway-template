// B4 (P2-B4-1): the engine contract for independent conversations, end to end through the bridge router. FAKE admin link, FAKE write
// link, FAKE gateway HTTP (legacy /send and the /tools/invoke reads); no OpenClaw. Shapes are the ones the P2-B4-1 lab recorded.
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import express from "express";
import { createAppBridge } from "./app-bridge.js";
import { RECENT_ACCEPT_MS, RESEND_WINDOW_MS, classifySendError } from "./app-bridge-threads.js";
import { SESSIONS_CAP_PARAMS, validateLinkRequest } from "./gateway-link.js";
import { DEFINITE_REFUSALS, THREAD_FEATURES } from "./thread-keys.js";
import { BAD_TIDS } from "./fixtures/thread-key-negatives.mjs";

const APP_TOKEN = "synthetic-app-token-0123456789abcdef0123";
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));
const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const K1 = "11111111-1111-4111-8111-111111111111";
const K2 = "22222222-2222-4222-8222-222222222222";
const K3 = "33333333-3333-4333-8333-333333333333";
const OWNER = "+966500000001";
const EPOCH = "a1b2c3d4e5f6";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = async (s) => (await import("node:crypto")).createHash("sha256").update(s).digest("hex");

function fakeLink(o = {}) {
  const link = {
    up: true, epoch: EPOCH, requests: [], active: [], sessions: {}, history: {}, waits: {}, failCap: false, threads: true,
    isUp() { return this.up; }, approvalsSynced() { return true; }, serverVersion: () => null, setDecorator() {},
    status() { return { state: this.up ? "up" : "down", pendingApprovals: 0 }; },
    approvalDeadline: () => null, pendingKind: () => null, forgetApproval() {}, approvalThreadOf: () => "unknown",
    events: () => ({ epoch: EPOCH, latest: 0, oldest: null, truncated: false, events: [] }), waitForEvents: () => Promise.resolve(),
    async request(method, params) {
      // the REAL link allowlist and closed validators: a fake must never accept what the real link refuses (review I1/I4)
      const refused = validateLinkRequest(method, params, { threads: this.threads });
      if (refused) throw Object.assign(new Error(refused), { code: refused });
      this.requests.push({ method, params });
      if (method === "sessions.list") {
        if (JSON.stringify(params) === JSON.stringify(SESSIONS_CAP_PARAMS)) {
          if (this.failCap) throw Object.assign(new Error("timeout"), { code: "timeout" });
          if (this.capShape !== undefined) return this.capShape;
          return { totalCount: this.active.length, sessions: this.active.map((key) => ({ key, hasActiveRun: true })) };
        }
        return { totalCount: 0, sessions: [] };
      }
      if (method === "cron.list") return { jobs: [], hasMore: false };
      if (method === "sessions.describe") { if (this.failDescribe) throw new Error("boom"); return { session: this.sessions[params.key] ?? null }; }
      if (method === "chat.history") { if (this.failHistory) throw Object.assign(new Error("x"), { code: "timeout" }); const h = this.history[params.sessionKey]; return typeof h === "function" ? h(params) : h ?? { messages: [] }; }
      if (method === "agent.wait") return { status: this.waits[params.runId] ?? "timeout" };
      if (method.endsWith(".approval.list")) return [];
      throw new Error(`unexpected link ${method}`);
    },
    ...o,
  };
  return link;
}

function fakeWriteLink() {
  const w = {
    epoch: "ffffffffffff", sends: [], aborts: [], listeners: new Set(), behave: null, ackDelay: 0,
    isUp: () => true, status: () => ({ state: "up" }), limits: () => ({ maxPayload: 26214400, maxBytes: 19464192, maxImageBytes: 6291456 }),
    onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    emit(name, p) { for (const fn of this.listeners) fn(name, p); },
    async chatSend(p) {
      this.sends.push(p);
      if (this.ackDelay) await sleep(this.ackDelay);
      if (this.behave) return this.behave(p);
      return { runId: p.idempotencyKey, status: "started" };
    },
    async chatAbort(p) { this.aborts.push(p); return { ok: true, aborted: true, runIds: [p.runId] }; },
  };
  return w;
}

/** The gateway's HTTP side for legacy routes: sessions_list rows, chat completions (gated), and the requests it got. */
function fakeHttp() {
  const g = { rows: [], chats: [], gate: null, invokes: [] };
  g.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (url.endsWith("/tools/invoke")) {
      g.invokes.push(body);
      if (body.tool === "sessions_list") return Response.json({ ok: true, result: { details: { sessions: g.rows, hasMore: false } } });
      if (body.tool === "sessions_history") return Response.json({ ok: true, result: { details: { messages: [] } } });
      return Response.json({ ok: false, error: { type: "not_found" } }, { status: 404 });
    }
    g.chats.push({ headers: opts.headers, body });
    const enc = new TextEncoder();
    const gate = g.gate;
    const stream = new ReadableStream({ async start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "chatcmpl_00000000-0000-4000-8000-000000000000", choices: [{ delta: { content: "hi" } }] })}\n\n`));
      if (gate) await gate;
      if (g.archived) c.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: "Session is archived. Restore it in the Control UI before retrying.", type: "invalid_request_error" } })}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n")); c.close();
    } });
    return new Response(stream, { status: 200 });
  };
  return g;
}

const W = 40; // the accept window in these tests (the real default, RECENT_ACCEPT_MS = 3 s, is tested on its own)
async function bridge({ threads = true, link = fakeLink(), writeLink = fakeWriteLink(), httpGw = fakeHttp(), gatewayCall, now, recentAcceptMs = W } = {}) {
  const calls = [];
  const gc = gatewayCall ?? (async (method, params) => {
    calls.push({ method, params });
    if (method === "sessions.describe") return { session: link.sessions[params.key] ?? null };
    if (method === "models.list") return { models: [{ id: "echo", provider: "mock", available: true }, { id: "echo2", provider: "mock", available: true }] };
    if (method === "sessions.patch") return { ok: true };
    if (method === "sessions.search") return { results: params.sessionKeys.map((k, i) => ({ sessionKey: k, messageId: `msg00${i}x`, role: "user", timestamp: 5, snippet: "hello there" })) };
    throw new Error(`unexpected ${method}`);
  });
  const router = createAppBridge({ token: APP_TOKEN, gatewayUrl: "http://gw.invalid", gatewayToken: "synthetic-gateway-token-0123456789abcdef",
    configPath: "/nonexistent/openclaw.json", fetchImpl: httpGw.fetch, gatewayCall: gc, link, writeLink, env: threads ? { BASHT_THREADS: "on" } : {}, ...(recentAcceptMs === null ? {} : { recentAcceptMs }), ...(now ? { now } : {}) });
  const app = express(); app.use("/app/v1", router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/app/v1`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* raw */ }
    return { status: res.status, json, text };
  };
  return { call, link, writeLink, httpGw, calls, close: () => new Promise((r) => server.close(r)) };
}
const send = (b, tid, K, message = "hello", extra = {}) => b.call("POST", `/threads/${tid}/send`, { message, clientMsgId: K, ...extra });

// ---------------------------------------------------------------- the flag ----------------------------------------------------------

test("flag off: no capability ids, no threads field, /threads/* is 404 like an old engine, the write link is never used", async () => {
  const b = await bridge({ threads: false });
  try {
    const s = await b.call("GET", "/status");
    for (const f of THREAD_FEATURES) assert.ok(!s.json.features.includes(f), f);
    assert.equal(s.json.threads, undefined);
    for (const [m, p, body] of [["POST", `/threads/${A}/send`, { message: "x", clientMsgId: K1 }], ["GET", `/threads/${A}/history`], ["GET", `/threads/legacy/runs/${K1}`],
      ["POST", "/threads/search", { q: "x", tids: [A] }], ["POST", `/threads/${A}/restore`, {}], ["GET", `/threads/${A}/model`]]) {
      const r = await b.call(m, p, body);
      assert.equal(r.status, 404, p); assert.deepEqual(r.json, { ok: false, error: "not_found" });
    }
    assert.equal(b.writeLink.sends.length, 0);
    // the body limit of /threads/* is the old 64 kB JSON limit too (the photo-sized parser exists only with the flag on)
    const big = await b.call("POST", `/threads/${A}/send`, { message: "x".repeat(100_000), clientMsgId: K1 });
    assert.equal(big.status, 413); assert.deepEqual(big.json, { ok: false, error: "too_large" });
  } finally { await b.close(); }
});

test("flag on: /status advertises exactly the plan's capability ids and the closed list of definite refusals", async () => {
  const b = await bridge();
  try {
    const s = await b.call("GET", "/status");
    assert.deepEqual(s.json.features.slice(-3), [...THREAD_FEATURES]);
    assert.deepEqual(s.json.threads.definiteRefusals, [...DEFINITE_REFUSALS]);
    assert.equal(s.json.threads.writeLink, "up");
  } finally { await b.close(); }
});

test("flag off: legacy /send is byte-for-byte the old path (no cap read, no busyThread), app:owner over HTTP", async () => {
  const b = await bridge({ threads: false });
  try {
    b.link.active = [`agent:main:app:owner:${A}`]; // would be busy with the flag on
    const r = await b.call("POST", "/send", { message: "hi" });
    assert.equal(r.status, 202);
    assert.deepEqual(Object.keys(r.json), ["ok", "runId"]);
    assert.ok(!b.link.requests.some((q) => q.method === "sessions.list"), "no cap read with the flag off");
    assert.equal(b.httpGw.chats[0].headers["x-openclaw-session-key"], "app:owner");
  } finally { await b.close(); }
});

// ---------------------------------------------------------------- keys -------------------------------------------------------------

test("thread send: the bridge builds the UNQUALIFIED key from the tid, idempotencyKey = clientMsgId, over the WRITE link only", async () => {
  const b = await bridge();
  try {
    const r = await send(b, A, K1);
    assert.equal(r.status, 202, r.text);
    assert.deepEqual(r.json, { ok: true, runId: K1, thread: A, ack: "started", boot: EPOCH, sessionSha256: null });
    assert.deepEqual(b.writeLink.sends, [{ sessionKey: `app:owner:${A}`, message: "hello", idempotencyKey: K1, attachments: [] }]);
    assert.ok(!b.link.requests.some((q) => q.method === "chat.send"), "never on the admin link");
    assert.deepEqual(b.link.requests.find((q) => q.method === "sessions.describe").params, { key: `agent:main:app:owner:${A}` }, "the pre-check uses the qualified key");
    await sleep(W + 30);
    const l = await send(b, "legacy", K2);
    assert.equal(l.status, 202);
    assert.equal(b.writeLink.sends[1].sessionKey, "app:owner", "legacy tid -> app:owner, never APP_SESSION_KEY of the request");
  } finally { await b.close(); }
});

test("every lab negative tid and clientMsgId is refused at the bridge with 400, before anything is sent", async () => {
  const b = await bridge();
  try {
    for (const t of BAD_TIDS) {
      if (typeof t !== "string" || !t || /[/?#%\s]/.test(t) || t === "." || t === "..") continue; // not representable as one path segment
      const r = await send(b, encodeURIComponent(t), K1);
      assert.ok([400, 404].includes(r.status), `${JSON.stringify(t)} ${r.status}`);
      assert.notEqual(r.status, 202);
    }
    for (const t of [A.toUpperCase(), `${A}x`, A.slice(1), `agent:main:app:owner:${A}`, `app:owner:${A}`, "main", "LEGACY"]) {
      const r = await send(b, t, K1);
      assert.equal(r.status, 400, t); assert.equal(r.json.reason, "bad_tid");
    }
    for (const k of ["9a9f4cbf-3890-428f-ba8d-b5b33713034c".toUpperCase(), `{${K1}}`, `urn:uuid:${K1}`, K1.replaceAll("-", ""), "", null, 5]) {
      const r = await send(b, A, k);
      assert.equal(r.status, 400, JSON.stringify(k)); assert.equal(r.json.reason, "bad_client_msg_id");
    }
    assert.equal(b.writeLink.sends.length, 0);
  } finally { await b.close(); }
});

test("command filter: '/', format/bidi marks then '/', and '!' + anything are refused with command_not_allowed (no write)", async () => {
  const b = await bridge();
  try {
    for (const m of ["/status", "\u200f/config", "\ufeff /x", "! ls", "!مهم", "\u200b/model fake/m2", " /compact", "\u00a0!x"]) {
      const r = await send(b, A, K1, m);
      assert.equal(r.status, 400, JSON.stringify(m)); assert.deepEqual(r.json, { ok: false, error: "command_not_allowed" });
    }
    assert.equal(b.writeLink.sends.length, 0);
    assert.equal((await send(b, A, K1, "مرحبا /status")).status, 202, "a slash later in the text is text");
  } finally { await b.close(); }
});

// ---------------------------------------------------------------- the global one-run cap (N1) ----------------------------------------

test("cap: a resumed run active in A (activeOnly shows A) -> a send to B is 409 busy with busyThread A, nothing written", async () => {
  const b = await bridge();
  try {
    b.link.active = [`agent:main:app:owner:${A}`, "agent:main:whatsapp:direct:+966500000001", "agent:main:cron:job1"];
    const r = await send(b, B, K1);
    assert.equal(r.status, 409); assert.deepEqual(r.json, { ok: false, error: "busy", busyThread: A });
    assert.equal(b.writeLink.sends.length, 0);
    assert.deepEqual(b.link.requests.find((q) => q.method === "sessions.list").params, SESSIONS_CAP_PARAMS);
    b.link.active = ["agent:main:whatsapp:direct:+966500000001", "agent:main:cron:job1"]; // cron and WhatsApp never count
    assert.equal((await send(b, B, K1)).status, 202);
  } finally { await b.close(); }
});

test("cap: a legacy HTTP turn running -> thread send busy (legacy); a thread run active -> legacy /send busy; both through one check", async () => {
  const b = await bridge();
  try {
    let open; b.httpGw.gate = new Promise((r) => { open = r; });
    const l = await b.call("POST", "/send", { message: "hi" });
    assert.equal(l.status, 202);
    await sleep(W + 30); // past the accept window: only the RUNNING legacy turn can make this busy
    const r = await send(b, B, K1);
    assert.deepEqual(r.json, { ok: false, error: "busy", busyThread: "legacy" });
    open(); await sleep(50); await sleep(W + 20);
    b.link.active = [`agent:main:app:owner:${B}`]; // another device's chat.send run in B
    const l2 = await b.call("POST", "/send", { message: "again" });
    assert.equal(l2.status, 409); assert.deepEqual(l2.json, { ok: false, error: "busy", busyThread: B });
    assert.equal(b.httpGw.chats.length, 1, "the second legacy turn was not started");
    assert.equal(b.httpGw.chats[0].headers["x-openclaw-session-key"], "app:owner", "legacy /send stays on app:owner over HTTP");
  } finally { await b.close(); }
});

test("cap: an accepted send < 3 s ago is busy (the ack -> activeOnly window); two concurrent sends: one 202, one busy (the mutex)", async () => {
  assert.equal(RECENT_ACCEPT_MS, 3000);
  const d = await bridge({ recentAcceptMs: null }); // the bridge's own default
  try {
    assert.equal((await send(d, A, K1)).status, 202);
    await sleep(2000);
    assert.equal((await send(d, B, K2)).json.error, "busy", "still inside 3 s");
    await sleep(1100);
    assert.equal((await send(d, B, K2)).status, 202, "after 3 s");
  } finally { await d.close(); }
  const b = await bridge();
  try {
    assert.equal((await send(b, A, K1)).status, 202);
    const r = await send(b, B, K2);
    assert.deepEqual(r.json, { ok: false, error: "busy", busyThread: A });
    await sleep(W + 30);
    b.writeLink.ackDelay = 150; // the first check-then-send is still in flight when the second arrives
    const [x, y] = await Promise.all([send(b, A, K3), send(b, B, "44444444-4444-4444-8444-444444444444")]);
    assert.deepEqual([x.status, y.status].sort(), [202, 409]);
    assert.equal(b.writeLink.sends.length, 2, "exactly one more write");
  } finally { await b.close(); }
});

test("cap: the activeOnly read failing or incomplete is 503 busy_unknown (fail closed), with no write", async () => {
  const b = await bridge();
  try {
    b.link.failCap = true;
    assert.deepEqual((await send(b, A, K1)).json, { ok: false, error: "busy_unknown" });
    assert.equal((await send(b, A, K1)).status, 503);
    assert.equal((await b.call("POST", "/send", { message: "hi" })).status, 503, "legacy /send too");
    b.link.failCap = false;
    for (const shape of [{ totalCount: 3, sessions: [] }, { totalCount: 1, sessions: [{ key: "x" }], hasMore: true }, { sessions: [] }, { totalCount: 0 }, null]) {
      b.link.capShape = shape;
      assert.equal((await send(b, A, K1)).json.error, "busy_unknown", JSON.stringify(shape));
    }
    delete b.link.capShape; b.link.up = false;
    assert.equal((await send(b, A, K1)).json.error, "busy_unknown");
    assert.equal(b.writeLink.sends.length, 0);
    assert.equal(b.httpGw.chats.length, 0);
  } finally { await b.close(); }
});

// ---------------------------------------------------------------- failure semantics ------------------------------------------------------

const err = (code, extra = {}) => Object.assign(new Error(extra.message ?? code), { code, ...extra });
const CASES = [
  [err("not_written"), 503, "not_written"],
  [err("ack_lost"), 502, "outcome_unknown", "ack_lost"],
  [err("ack_timeout"), 502, "outcome_unknown", "ack_timeout"],
  [err("too_large", { reason: "frame_too_large" }), 413, "too_large"],
  [err("bad_params"), 400, "bad_request"],
  [err("INVALID_REQUEST", { refused: true, reason: "chat-request-conflict" }), 409, "conflict"],
  [err("INVALID_REQUEST", { refused: true, message: 'Session "agent:main:app:owner:x" is archived. Restore it before starting new work.' }), 409, "archived"],
  [err("UNAVAILABLE", { refused: true, message: "SessionTranscriptColdError: transcript is cold code=TRANSCRIPT_COLD" }), 409, "cold"],
  [err("INVALID_REQUEST", { refused: true, message: "Error: attachment big.png: image exceeds size limit (6752083 > 6291456 bytes)" }), 413, "too_large"],
  [err("INVALID_REQUEST", { refused: true, message: "changed while starting work" }), 502, "outcome_unknown", "engine_refused"],
  [err("UNAVAILABLE", { refused: true, message: "gateway starting" }), 502, "outcome_unknown", "engine_refused"],
  [new Error("socket hang up"), 502, "outcome_unknown", "exception"],
  [new TypeError("x is not a function"), 502, "outcome_unknown", "exception"],
];

test("failure mapping: definite codes only from the closed list; ack_lost/ack_timeout/any exception after the write are outcome_unknown, never engine_unavailable", async () => {
  for (const [e, status, error, reason] of CASES) {
    const c = classifySendError(e);
    assert.equal(c.status, status, e.message); assert.equal(c.error, error, e.message);
    if (reason) assert.equal(c.reason, reason);
    assert.ok(DEFINITE_REFUSALS.includes(c.error) || (c.error === "outcome_unknown" && c.status === 502), `${c.error} must be definite or unknown`);
  }
  const b = await bridge();
  try {
    for (const [e, status, error] of CASES) {
      b.writeLink.behave = () => { throw e; };
      const K = (await import("node:crypto")).randomUUID();
      await sleep(W + 20); // an unknown outcome counts as "just accepted" for the cap
      const r = await send(b, A, K);
      assert.equal(r.status, status, `${e.message} -> ${r.text}`); assert.equal(r.json.error, error);
      assert.notEqual(r.json.error, "engine_unavailable");
    }
    // an ack with an unexpected shape is unknown, not accepted
    b.writeLink.behave = () => ({ status: "weird" });
    await sleep(W + 20);
    const r = await send(b, A, "55555555-5555-4555-8555-555555555555");
    assert.equal(r.status, 502); assert.equal(r.json.error, "outcome_unknown");
  } finally { await b.close(); }
});

test("no retry and no CLI fallback: one failed write is exactly one chat.send and zero gateway CLI calls of chat.send", async () => {
  const b = await bridge();
  try {
    b.writeLink.behave = () => { throw err("ack_timeout"); };
    await send(b, A, K1);
    await sleep(50);
    assert.equal(b.writeLink.sends.length, 1);
    assert.ok(!b.calls.some((c) => c.method === "chat.send"));
    // the normal send path never calls the engine again for an id it has seen
    await sleep(W + 20);
    const again = await send(b, A, K1);
    assert.equal(again.status, 409); assert.deepEqual(again.json, { ok: false, error: "already_sent" });
    assert.ok(!DEFINITE_REFUSALS.includes("already_sent"), "an id used before is NOT a definite refusal: it may have been sent (m4)");
    assert.equal(b.writeLink.sends.length, 1);
  } finally { await b.close(); }
});

test("archived: the pre-check refuses with 409 archived (no write); the engine's archived refusal is typed too; restore is explicit", async () => {
  const b = await bridge();
  try {
    const key = `agent:main:app:owner:${A}`;
    b.link.sessions[key] = { key, sessionId: "sid-1", archived: true, archiveReason: "age-retention" };
    assert.deepEqual((await send(b, A, K1)).json, { ok: false, error: "archived" });
    assert.equal(b.writeLink.sends.length, 0);
    const r = await b.call("POST", `/threads/${A}/restore`, {});
    assert.deepEqual(r.json, { ok: true, thread: A, restored: true });
    assert.deepEqual(b.calls.find((c) => c.method === "sessions.patch").params, { key, archived: false, expectedSessionId: "sid-1" });
    b.link.sessions[key] = { key, sessionId: "sid-1" };
    assert.deepEqual((await b.call("POST", `/threads/${A}/restore`, {})).json, { ok: true, thread: A, restored: false });
    assert.equal((await b.call("POST", `/threads/${B}/restore`, {})).status, 404, "a conversation the engine never saw");
  } finally { await b.close(); }
});

test("flag on: the legacy stream's in-stream 'Session is archived' becomes errorCode archived on the run", async () => {
  const b = await bridge();
  try {
    b.httpGw.archived = true;
    const r = await b.call("POST", "/send", { message: "hi" });
    await sleep(80);
    const run = await b.call("GET", `/runs/${r.json.runId}`);
    assert.equal(run.json.status, "error"); assert.equal(run.json.errorCode, "archived");
  } finally { await b.close(); }
});

test("images: an image above the link's maxImageBytes or a body above the parser's caps is 413 too_large, definite, no write", async () => {
  const b = await bridge();
  try {
    b.writeLink.chatSend = async function (p) { this.sends.push(p); throw err("too_large", { reason: "image_too_large" }); };
    const png = Buffer.alloc(64); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    const r = await send(b, A, K1, "look", { images: [{ mime: "image/png", data: png.toString("base64") }] });
    assert.equal(r.status, 413); assert.equal(r.json.error, "too_large");
    assert.deepEqual(Object.keys(b.writeLink.sends[0].attachments[0]).sort(), ["content", "fileName", "mimeType", "type"]);
    const big = Buffer.alloc(10 * 1024 * 1024 + 8); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);
    const r2 = await send(b, A, K2, "look", { images: [{ mime: "image/png", data: big.toString("base64") }] });
    assert.equal(r2.status, 413); assert.equal(r2.json.error, "too_large");
    const r3 = await send(b, A, K2, "look", { images: [{ mime: "image/bmp", data: "AAAA" }] });
    assert.equal(r3.status, 400); assert.equal(r3.json.error, "bad_request");
  } finally { await b.close(); }
});

// ---------------------------------------------------------------- resend ------------------------------------------------------------------

test("resend: allowed once, with the SAME id, only inside 24 h, same engine session, after a complete reconciliation that found nothing", async () => {
  const t0 = Date.now();
  let clock = t0;
  const b = await bridge({ now: () => clock });
  try {
    const key = `agent:main:app:owner:${A}`;
    b.link.sessions[key] = { key, sessionId: "sid-1" };
    const s1 = await sha("sid-1");
    b.link.history[key] = { messages: [{ role: "user", idempotencyKey: "99999999-9999-4999-8999-999999999999:user", timestamp: t0 - 10, __openclaw: { id: "row0001" } }] };
    const body = { message: "hello", originalAt: t0 - 1000, sessionSha256: s1 };
    const ok = await b.call("POST", `/threads/${A}/sends/${K1}/resend`, body);
    assert.equal(ok.status, 202, ok.text); assert.equal(ok.json.resent, true); assert.equal(ok.json.runId, K1);
    assert.deepEqual(b.writeLink.sends.map((s) => s.idempotencyKey), [K1], "same id, one call");
    assert.ok(b.link.requests.some((q) => q.method === "agent.wait" && q.params.runId === K1 && q.params.timeoutMs === 0));
    clock += W + 1;
    const refuse = async (path, bd, reason) => {
      const r = await b.call("POST", path, bd);
      assert.equal(r.status, 409, `${reason}: ${r.text}`); assert.deepEqual(r.json, { ok: false, error: "resend_not_allowed", reason });
    };
    // past 24 h
    assert.equal(RESEND_WINDOW_MS, 24 * 60 * 60_000);
    await refuse(`/threads/${A}/sends/${K2}/resend`, { ...body, originalAt: clock - 24 * 60 * 60_000 - 1 }, "window");
    // the engine session changed (delete-and-recreate): the bridge's own describe comparison, not chat.send.sessionId
    await refuse(`/threads/${A}/sends/${K2}/resend`, { ...body, sessionSha256: await sha("sid-other") }, "session_changed");
    // "<K>:user" is already in the transcript
    b.link.history[key] = { messages: [{ role: "user", idempotencyKey: `${K2}:user`, timestamp: clock - 10, __openclaw: { id: "row0002" } }] };
    await refuse(`/threads/${A}/sends/${K2}/resend`, body, "already_received");
    // agent.wait knows the run
    b.link.history[key] = { messages: [] }; b.link.waits[K2] = "ok";
    await refuse(`/threads/${A}/sends/${K2}/resend`, body, "already_received");
    delete b.link.waits[K2];
    // reconciliation cannot read, or cannot page back far enough
    b.link.failHistory = true;
    await refuse(`/threads/${A}/sends/${K2}/resend`, body, "reconcile_incomplete");
    b.link.failHistory = false;
    b.link.history[key] = () => ({ hasMore: true, messages: Array.from({ length: 200 }, (_, i) => ({ role: "assistant", timestamp: clock, __openclaw: { id: `same${String(i).padStart(4, "0")}` } })) });
    await refuse(`/threads/${A}/sends/${K2}/resend`, body, "reconcile_incomplete");
    b.link.history[key] = { messages: [] };
    // a final refusal is never resent
    for (const p of ["conflict", "command_not_allowed", "bad_request", "too_large"]) await refuse(`/threads/${A}/sends/${K2}/resend`, { ...body, previousRefusal: p }, "refusal_final");
    assert.equal(b.writeLink.sends.length, 1, "no refused resend wrote anything");
    // the resend route is the only way back for a seen id: the normal send path refuses it
    assert.equal((await send(b, A, K1)).json.error, "already_sent");
    // resend of the SAME id with a different body is a conflict
    assert.deepEqual((await b.call("POST", `/threads/${A}/sends/${K1}/resend`, { ...body, message: "other" })).json, { ok: false, error: "conflict" });
  } finally { await b.close(); }
});

test("resend: the bridge's stored sessionId for the original send wins over the caller's", async () => {
  const b = await bridge();
  try {
    const key = `agent:main:app:owner:${A}`;
    b.link.sessions[key] = { key, sessionId: "sid-1" };
    b.writeLink.behave = () => { throw err("ack_lost"); };
    assert.equal((await send(b, A, K1)).json.error, "outcome_unknown");
    b.writeLink.behave = null;
    b.link.sessions[key] = { key, sessionId: "sid-2" }; // replaced after the original send
    await sleep(W + 20);
    const r = await b.call("POST", `/threads/${A}/sends/${K1}/resend`, { message: "hello", originalAt: Date.now() - 1000, sessionSha256: await sha("sid-2") });
    assert.deepEqual(r.json, { ok: false, error: "resend_not_allowed", reason: "session_changed" });
    assert.equal(b.writeLink.sends.length, 1);
  } finally { await b.close(); }
});

test("reconciliation read: GET /threads/:tid/sends/:K reports the '<K>:user' row and agent.wait, read-only", async () => {
  const b = await bridge();
  try {
    const key = `agent:main:app:owner:${A}`;
    b.link.history[key] = { messages: [{ role: "user", idempotencyKey: `${K1}:user`, timestamp: 5, __openclaw: { id: "row0001" } }] };
    b.link.waits[K1] = "ok";
    const r = await b.call("GET", `/threads/${A}/sends/${K1}?since=1`);
    assert.deepEqual(r.json, { ok: true, thread: A, runId: K1, found: true, complete: true, wait: "ok", boot: EPOCH });
    assert.equal(b.writeLink.sends.length, 0);
  } finally { await b.close(); }
});

// ---------------------------------------------------------------- runs, history, resumed replies -----------------------------------------

test("runs: live text from the write link's chat events (filtered by qualified key and runId); state survives a NEW bridge from the engine", async () => {
  const link = fakeLink();
  const key = `agent:main:app:owner:${A}`;
  const b = await bridge({ link });
  try {
    assert.equal((await send(b, A, K1)).status, 202);
    b.writeLink.emit("chat", { runId: K1, sessionKey: key, seq: 1, state: "status", phase: "starting_model" });
    b.writeLink.emit("chat", { runId: K1, sessionKey: key, seq: 2, state: "delta", deltaText: "ack" });
    b.writeLink.emit("chat", { runId: K1, sessionKey: `agent:main:app:owner:${B}`, seq: 3, state: "delta", deltaText: "LEAK" }); // another thread
    b.writeLink.emit("chat", { runId: K1, sessionKey: key, seq: 4, state: "delta", deltaText: " l3" });
    let r = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r.json.status, "running"); assert.equal(r.json.text, "ack l3"); assert.equal(r.json.phase, "starting_model");
    assert.equal((await b.call("GET", `/threads/${B}/runs/${K1}`)).status, 404, "a run of A is not readable through B");
    b.writeLink.emit("chat", { runId: K1, sessionKey: key, seq: 5, state: "final", message: { role: "assistant", content: [{ type: "text", text: "ack l3 done" }] } });
    r = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r.json.status, "done"); assert.equal(r.json.text, "ack l3 done");
  } finally { await b.close(); }
  // the bridge restarted: nothing in memory; the engine still knows (history rows tagged with K, agent.wait)
  link.history[key] = { messages: [
    { role: "user", idempotencyKey: `${K1}:user`, content: "hello", timestamp: 1, __openclaw: { id: "row0001" } },
    { role: "assistant", content: [{ type: "text", text: "ack l3 done" }], timestamp: 2, __openclaw: { id: "row0002", runId: K1 } }] };
  link.waits[K1] = "ok";
  const b2 = await bridge({ link });
  try {
    const r = await b2.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r.json.status, "done"); assert.equal(r.json.text, "ack l3 done"); assert.equal(r.json.interrupted, false); assert.equal(r.json.resumed, null);
    assert.equal((await b2.call("GET", `/threads/${A}/runs/${K2}`)).status, 404);
  } finally { await b2.close(); }
});

test("resumed reply: a restart-continued run (continuation.source 'restart', another runId) is flagged interrupted + resumed, never re-executed", async () => {
  const link = fakeLink();
  const key = `agent:main:app:owner:${A}`;
  link.history[key] = { messages: [
    { role: "user", idempotencyKey: `${K1}:user`, content: "make the invoice", timestamp: 1, __openclaw: { id: "row0001" } },
    { role: "assistant", content: [{ type: "text", text: "starting" }], timestamp: 2, __openclaw: { id: "row0002", runId: K1 } },
    // seq 3 = the hidden resume input (absent from chat.history, lab L5)
    { role: "assistant", content: [{ type: "text", text: "continuing after restart" }], timestamp: 4, __openclaw: { id: "row0004", runId: "run-r2-event", turnBoundary: true, continuation: { source: "restart" } } }] };
  const b = await bridge({ link });
  try {
    const r = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r.json.interrupted, true);
    assert.deepEqual(r.json.resumed, { runId: "run-r2-event", text: "continuing after restart" });
    assert.equal(r.json.status, "unknown", "agent.wait K times out after a restart: not 'done'");
    const h = await b.call("GET", `/threads/${A}/history`);
    assert.deepEqual(h.json.messages.map((m) => [m.role, m.runId ?? null, m.resumed ?? false]), [["user", K1, false], ["assistant", K1, false], ["assistant", null, true]]);
    assert.deepEqual(link.requests.find((q) => q.method === "chat.history").params.sessionKey, key, "history reads use the qualified key");
    assert.equal(b.writeLink.sends.length, 0, "nothing re-sent");
  } finally { await b.close(); }
});

test("abort: chat.abort over the write link with the unqualified key and the runId", async () => {
  const b = await bridge();
  try {
    const r = await b.call("POST", `/threads/${A}/runs/${K1}/abort`, {});
    assert.deepEqual(r.json, { ok: true, aborted: true });
    assert.deepEqual(b.writeLink.aborts, [{ sessionKey: `app:owner:${A}`, runId: K1 }]);
    assert.equal((await b.call("POST", `/threads/${A}/runs/chatcmpl_x/abort`, {})).status, 400);
  } finally { await b.close(); }
});

// ---------------------------------------------------------------- legacy surfaces stay legacy ---------------------------------------------

test("/sessions output is byte-identical after threads exist; legacy /history and /media never open a thread key (isReadable not widened)", async () => {
  const off = await bridge({ threads: false });
  const on = await bridge();
  try {
    const legacyRows = [{ key: "agent:main:app:owner", channel: "unknown", updatedAt: 3 }, { key: `agent:main:whatsapp:direct:${OWNER}`, channel: "whatsapp", updatedAt: 5 }];
    off.httpGw.rows = legacyRows; on.httpGw.rows = legacyRows;
    const before = await on.call("GET", "/sessions");
    const ref = await off.call("GET", "/sessions");
    assert.equal(await send(on, A, K1).then((r) => r.status), 202);
    on.httpGw.rows = [...legacyRows, { key: `agent:main:app:owner:${A}`, channel: "webchat", updatedAt: 99 }, { key: `agent:main:app:owner:${B}`, channel: "webchat", updatedAt: 98 }];
    const afterR = await on.call("GET", "/sessions");
    assert.equal(afterR.text, before.text, "byte-identical");
    assert.equal(afterR.text, ref.text, "and identical to the flag-off engine");
    for (const k of [`agent:main:app:owner:${A}`, `app:owner:${A}`]) {
      assert.equal((await on.call("GET", `/history?key=${encodeURIComponent(k)}`)).status, 404, k);
      assert.equal((await on.call("GET", `/media?key=${encodeURIComponent(k)}&msg=abcdef12&ref=${"c".repeat(32)}`)).status, 404, k);
    }
  } finally { await off.close(); await on.close(); }
});

// ---------------------------------------------------------------- settings, search ------------------------------------------------------

test("model/thinking per conversation: reads/writes the thread's own key, never the legacy one; a never-used thread is 'not_started'", async () => {
  const b = await bridge();
  try {
    const key = `agent:main:app:owner:${A}`;
    let r = await b.call("GET", `/threads/${A}/model`);
    assert.equal(r.json.started, false); assert.deepEqual(r.json.model, { id: null, source: "default" });
    assert.equal((await b.call("POST", `/threads/${A}/model`, { model: "mock/echo2" })).json.error, "not_started");
    b.link.sessions[key] = { key, sessionId: "s", modelProvider: "mock", model: "echo", thinkingLevels: [{ id: "low" }, { id: "high" }] };
    r = await b.call("POST", `/threads/${A}/model`, { model: "mock/echo2" });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(b.calls.filter((c) => c.method === "sessions.patch").map((c) => c.params), [{ key, model: "mock/echo2" }]);
    assert.equal(b.calls.find((c) => c.method === "models.list").params.sessionKey, key, "models.list with the conversation's key (M1)");
    assert.equal((await b.call("POST", `/threads/${A}/model`, { model: "mock/nope" })).json.reason, "unknown_model");
    assert.equal((await b.call("POST", `/threads/${A}/thinking`, { level: "high" })).status, 200);
    assert.equal((await b.call("POST", `/threads/${A}/thinking`, { level: "ultra" })).json.reason, "unsupported_level");
    b.link.sessions[key].hasActiveRun = true;
    assert.equal((await b.call("POST", `/threads/${A}/thinking`, { level: "low" })).json.error, "busy");
    assert.ok(b.calls.filter((c) => c.method === "sessions.patch").every((c) => c.params.key === key), "the legacy key was never patched");
  } finally { await b.close(); }
});

test("search: keys built from the given tids (batches of 100), results carry the tid and never a session key", async () => {
  const b = await bridge();
  try {
    const tids = Array.from({ length: 150 }, (_, i) => i.toString(16).padStart(32, "0"));
    const r = await b.call("POST", "/threads/search", { q: "hello", tids });
    assert.equal(r.status, 200);
    assert.equal(r.json.results.length, 20); assert.equal(r.json.truncated, true);
    assert.ok(!r.text.includes("agent:main"), "no key leaves the bridge");
    const sent = b.calls.find((c) => c.method === "sessions.search").params;
    assert.equal(sent.sessionKeys.length, 100);
    assert.equal(sent.sessionKeys[0], `agent:main:app:owner:${tids[0]}`);
    assert.equal((await b.call("POST", "/threads/search", { q: "x", tids: [A, "BAD"] })).status, 400);
  } finally { await b.close(); }
});

test("approvals (flag on): /approvals rows carry their thread; history rows use the key recorded when raised, else 'unknown' (never legacy)", async () => {
  const link = fakeLink();
  const orig = link.request.bind(link);
  link.request = async (method, params) => {
    if (method === "exec.approval.list") return [{ id: "approval-exec-1", createdAtMs: 1, expiresAtMs: Date.now() + 60_000, request: { command: "ls", sessionKey: `agent:main:app:owner:${A}` } }];
    if (method === "plugin.approval.list") return [{ id: `plugin:${K1}`, createdAtMs: 2, expiresAtMs: Date.now() + 60_000, request: { title: "t", severity: "critical", toolName: "execute_tools", sessionKey: "agent:main:app:owner" } }];
    if (method === "approval.history") return { items: [{ id: "approval-exec-1", status: "resolved" }, { id: "approval-old-9", status: "resolved" }] };
    return orig(method, params);
  };
  link.approvalThreadOf = (id) => (id === "approval-exec-1" ? A : "unknown");
  const b = await bridge({ link });
  const off = await bridge({ link, threads: false });
  try {
    const r = await b.call("GET", "/approvals");
    assert.deepEqual(r.json.approvals.map((a) => [a.kind, a.thread]), [["exec", A], ["plugin", "legacy"]]);
    const h = await b.call("GET", "/approvals/history");
    assert.deepEqual(h.json.items.map((i) => [i.id, i.thread]), [["approval-exec-1", A], ["approval-old-9", "unknown"]]);
    const r0 = await off.call("GET", "/approvals");
    assert.ok(r0.json.approvals.every((a) => !("thread" in a)), "flag off: unchanged shape");
    assert.ok((await off.call("GET", "/approvals/history")).json.items.every((i) => !("thread" in i)));
  } finally { await b.close(); await off.close(); }
});

test("fast mode per conversation, and /threads/state: describe per tid, archived/active/lastActivity, unreadable = unknown (never 'not archived')", async () => {
  const b = await bridge();
  try {
    const key = `agent:main:app:owner:${A}`;
    b.link.sessions[key] = { key, sessionId: "s", modelProvider: "mock", model: "echo", archived: true, archiveReason: "age-retention", lastActivityAt: 7, hasActiveRun: false };
    assert.equal((await b.call("POST", `/threads/${A}/fast`, { mode: "on" })).json.reason, "fast_mode_unsupported");
    assert.equal((await b.call("POST", `/threads/${A}/fast`, { mode: "off" })).status, 200);
    assert.deepEqual(b.calls.filter((c) => c.method === "sessions.patch").map((c) => c.params), [{ key, fastMode: false }]);
    assert.equal((await b.call("POST", `/threads/${B}/fast`, { mode: "off" })).json.error, "not_started");
    const s = await b.call("GET", `/threads/state?tids=${A},${B},legacy`);
    assert.deepEqual(s.json.threads[A], { exists: true, archived: true, archiveReason: "age-retention", lastActivityAt: 7, hasActiveRun: false });
    assert.deepEqual(s.json.threads[B], { exists: false });
    b.link.failDescribe = true;
    assert.deepEqual((await b.call("GET", `/threads/state?tids=${A}`)).json.threads[A], { unknown: true });
    assert.equal((await b.call("GET", `/threads/state?tids=${A},BAD`)).status, 400);
    assert.equal((await b.call("GET", `/threads/state?tids=${Array.from({ length: 101 }, () => A).join(",")}`)).status, 400);
  } finally { await b.close(); }
});

test("/status (flag on): writeLinkProfile 'A' and whether the D-B4-9 guard is configured (a boolean, nothing else)", async () => {
  const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b4-guard-"));
  const cfg = path.join(dir, "openclaw.json");
  const { resumeGuardConfigured } = await import("./app-bridge-status.js");
  try {
    assert.equal(resumeGuardConfigured(cfg), null, "unreadable");
    fs.writeFileSync(cfg, JSON.stringify({ plugins: { load: { paths: ["/app/src/plugins/basht-resume-guard.mjs"] }, entries: { "basht-resume-guard": { enabled: true, hooks: { allowConversationAccess: true } } } } }));
    assert.equal(resumeGuardConfigured(cfg), true);
    for (const p of [{ load: { paths: [] }, entries: { "basht-resume-guard": { enabled: true, hooks: { allowConversationAccess: true } } } },
      { load: { paths: ["/app/src/plugins/basht-resume-guard.mjs"] }, entries: { "basht-resume-guard": { enabled: false, hooks: { allowConversationAccess: true } } } },
      { load: { paths: ["/app/src/plugins/basht-resume-guard.mjs"] }, entries: { "basht-resume-guard": { enabled: true } } },
      { enabled: false, load: { paths: ["/app/src/plugins/basht-resume-guard.mjs"] }, entries: { "basht-resume-guard": { enabled: true, hooks: { allowConversationAccess: true } } } }]) {
      fs.writeFileSync(cfg, JSON.stringify({ plugins: p }));
      assert.equal(resumeGuardConfigured(cfg), false, JSON.stringify(p));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const wl = fakeWriteLink(); wl.config = { profile: "A" };
  const b = await bridge({ writeLink: wl });
  try {
    const s = await b.call("GET", "/status");
    assert.equal(s.json.writeLinkProfile, "A");
    assert.deepEqual(s.json.threads.resumeGuard, { configured: null });
  } finally { await b.close(); }
  const off = await bridge({ threads: false, writeLink: wl });
  try { const s = await off.call("GET", "/status"); assert.equal(s.json.writeLinkProfile, undefined); } finally { await off.close(); }
});
