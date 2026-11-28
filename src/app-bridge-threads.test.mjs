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
const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await sleep(5); } };
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
    if (method === "sessions.reset") return { ok: true, key: params.key };
    if (method === "sessions.search") return { results: params.sessionKeys.map((k, i) => ({ sessionKey: k, messageId: `msg00${i}x`, role: "user", timestamp: 5, snippet: "hello there" })) };
    throw new Error(`unexpected ${method}`);
  });
  // like the engine: an accepted chat.send creates the conversation's session (seen by describe shortly after the ack)
  const rawSend = writeLink.chatSend.bind(writeLink);
  writeLink.chatSend = async (p) => {
    const ack = await rawSend(p);
    const q = `agent:main:${p.sessionKey}`;
    if (link.autoSession !== false && !link.sessions[q]) link.sessions[q] = { key: q, sessionId: `sid-${p.sessionKey}` };
    return ack;
  };
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
    assert.deepEqual(r.json, { ok: true, runId: K1, thread: A, ack: "started", boot: EPOCH, sessionSha256: await sha(`sid-app:owner:${A}`) },
      "a new conversation's session hash is captured after the ack (BUG-5)");
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

// ---------------------------------------------------------------- fix round (review P2-B4-1-CODE-REVIEW + Codex) ---------------------
const rowsOf = (n, t0, prefix = "r") => Array.from({ length: n }, (_, i) => ({ role: "assistant", content: [{ type: "text", text: `t${i}` }], timestamp: t0 + i,
  __openclaw: { id: `${prefix}${String(i).padStart(5, "0")}` } }));

test("I1: history paging at the advertised maximum (limit=100 with before=) passes the REAL link validator; no 502", async () => {
  const b = await bridge();
  try {
    const key = `agent:main:app:owner:${A}`;
    const all = rowsOf(300, 1000);
    b.link.history[key] = (p) => {
      if (!p.messageId) return { messages: all.slice(-p.limit), hasMore: true };
      const at = all.findIndex((m) => m.__openclaw.id === p.messageId);
      const lo = Math.max(0, at - Math.floor(p.limit / 2));
      return { messages: all.slice(lo, lo + p.limit), anchor: { hasOlder: lo > 0 } };
    };
    for (const q of ["limit=100", "limit=100&before=r00250", "limit=500&before=r00250", "limit=1&before=r00250", "before=r00250"]) {
      const r = await b.call("GET", `/threads/${A}/history?${q}`);
      assert.equal(r.status, 200, `${q}: ${r.text}`);
    }
    const r = await b.call("GET", `/threads/${A}/history?limit=100&before=r00250`);
    assert.ok(r.json.messages.length >= 99 && r.json.messages.length <= 100, String(r.json.messages.length));
    assert.equal(r.json.messages.at(-1).id, "r00249", "the rows right before the anchor");
    assert.ok(r.json.earlier, "a cursor for the page before");
    assert.ok(b.link.requests.filter((q) => q.method === "chat.history").every((q) => q.params.limit <= 200));
  } finally { await b.close(); }
});

test("I2: a run whose terminal event was missed (write link dropped/reconnected) is reconciled from the engine: final status and text", async () => {
  const b = await bridge();
  try {
    const key = `agent:main:app:owner:${A}`;
    assert.equal((await send(b, A, K1)).status, 202);
    b.writeLink.emit("chat", { runId: K1, sessionKey: key, seq: 1, state: "delta", deltaText: "par" });
    b.writeLink.isUp = () => false; // the link dropped: final/error/aborted never arrive on it
    b.link.history[key] = { messages: [{ role: "user", idempotencyKey: `${K1}:user`, content: "hello", timestamp: 1, __openclaw: { id: "row0001" } },
      { role: "assistant", content: [{ type: "text", text: "partial and then the full reply" }], stopReason: "stop", timestamp: 2, __openclaw: { id: "row0002", runId: K1 } }] };
    b.link.waits[K1] = "ok";
    let r = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r.json.status, "done"); assert.equal(r.json.text, "partial and then the full reply");
    assert.ok(b.link.requests.some((q) => q.method === "agent.wait" && q.params.runId === K1 && q.params.timeoutMs === 0), "agent.wait, bounded");
    b.writeLink.isUp = () => true; // reconnected later: the record stays final
    r = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r.json.status, "done");
    // an engine error is reconciled the same way
    await sleep(W + 20);
    assert.equal((await send(b, A, K2)).status, 202);
    b.link.waits[K2] = "error";
    assert.equal((await b.call("GET", `/threads/${A}/runs/${K2}`)).json.status, "error");
  } finally { await b.close(); }
});

test("I2: terminal events that arrive while the ack is awaited (then ack_timeout) are kept: polling shows the final text", async () => {
  const b = await bridge();
  try {
    const key = `agent:main:app:owner:${A}`;
    b.writeLink.behave = (p) => {
      b.writeLink.emit("chat", { runId: p.idempotencyKey, sessionKey: key, seq: 1, state: "delta", deltaText: "fast" });
      b.writeLink.emit("chat", { runId: p.idempotencyKey, sessionKey: key, seq: 2, state: "final", message: { role: "assistant", content: [{ type: "text", text: "fast reply" }] } });
      throw Object.assign(new Error("ack_timeout"), { code: "ack_timeout" });
    };
    const s = await send(b, A, K1);
    assert.equal(s.json.error, "outcome_unknown");
    const r = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r.json.status, "done"); assert.equal(r.json.text, "fast reply");
    // a DEFINITE refusal leaves no live record behind
    await sleep(W + 20);
    b.writeLink.behave = () => { throw Object.assign(new Error("not_written"), { code: "not_written" }); };
    assert.equal((await send(b, A, K2)).json.error, "not_written");
    assert.equal((await b.call("GET", `/threads/${A}/runs/${K2}`)).status, 404);
  } finally { await b.close(); }
});

test("Codex: a resumed reply is bound to ITS turn: polling an earlier turn never reports a later turn's interruption or text", async () => {
  const link = fakeLink();
  const key = `agent:main:app:owner:${A}`;
  link.history[key] = { messages: [
    { role: "user", idempotencyKey: `${K1}:user`, content: "first", timestamp: 1, __openclaw: { id: "row0001" } },
    { role: "assistant", content: [{ type: "text", text: "first reply" }], timestamp: 2, __openclaw: { id: "row0002", runId: K1 } },
    { role: "user", idempotencyKey: `${K2}:user`, content: "second", timestamp: 3, __openclaw: { id: "row0003" } },
    { role: "assistant", content: [{ type: "text", text: "second, cut" }], timestamp: 4, __openclaw: { id: "row0004", runId: K2 } },
    { role: "assistant", content: [{ type: "text", text: "second continued" }], timestamp: 6, __openclaw: { id: "row0006", runId: "run-r2", continuation: { source: "restart" } } },
    { role: "assistant", content: [{ type: "text", text: "someone else's run" }], timestamp: 7, __openclaw: { id: "row0007", runId: "run-other" } }] };
  link.waits[K1] = "ok";
  const b = await bridge({ link });
  try {
    const r1 = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r1.json.interrupted, false); assert.equal(r1.json.resumed, null); assert.equal(r1.json.text, "first reply"); assert.equal(r1.json.status, "done");
    const r2 = await b.call("GET", `/threads/${A}/runs/${K2}`);
    assert.equal(r2.json.interrupted, true);
    assert.deepEqual(r2.json.resumed, { runId: "run-r2", text: "second continued" }, "only the continuation run's own rows");
  } finally { await b.close(); }
});

test("I3: after a bridge restart, an API clock AHEAD of the engine cannot end reconciliation early: the earlier K row is still found", async () => {
  const T = Date.now() - 10 * 60_000; // the engine wrote "<K>:user" at T, then a tool-heavy turn of 200 rows within 60 s
  const key = `agent:main:app:owner:${A}`;
  const kRow = { role: "user", idempotencyKey: `${K1}:user`, content: "hello", timestamp: T, __openclaw: { id: "krow00001" } };
  const older = rowsOf(10, T - 5000, "o");
  const newer = rowsOf(200, T + 1, "n").map((m, i) => ({ ...m, timestamp: T + 1 + i * 300 }));
  const all = [...older, kRow, ...newer];
  const link = fakeLink();
  link.sessions[key] = { key, sessionId: "sid-1" };
  link.history[key] = (p) => {
    if (!p.messageId) return { messages: all.slice(-p.limit), hasMore: true };
    const at = all.findIndex((m) => m.__openclaw.id === p.messageId);
    return { messages: all.slice(Math.max(0, at - p.limit + 1), at + 1), anchor: { hasOlder: at - p.limit + 1 > 0 } };
  };
  const b = await bridge({ link }); // a fresh bridge: no in-memory record of K
  try {
    const r = await b.call("POST", `/threads/${A}/sends/${K1}/resend`, { message: "hello", originalAt: T + 2 * 60_000, sessionSha256: await sha("sid-1") });
    assert.deepEqual(r.json, { ok: false, error: "resend_not_allowed", reason: "already_received" });
    assert.equal(b.writeLink.sends.length, 0);
  } finally { await b.close(); }
});

test("I4: an outcome_unknown send counts for the one-run cap (a second send right after is busy)", async () => {
  const b = await bridge();
  try {
    b.writeLink.behave = () => { throw Object.assign(new Error("ack_lost"), { code: "ack_lost" }); };
    assert.equal((await send(b, A, K1)).json.error, "outcome_unknown");
    b.writeLink.behave = null;
    assert.deepEqual((await send(b, B, K2)).json, { ok: false, error: "busy", busyThread: A });
    assert.equal(b.writeLink.sends.length, 1);
  } finally { await b.close(); }
});

test("I4: reconciliation whose agent.wait gives no answer (timeout) fails closed: resend_not_allowed", async () => {
  const link = fakeLink();
  const key = `agent:main:app:owner:${A}`;
  link.sessions[key] = { key, sessionId: "sid-1" };
  const orig = link.request.bind(link);
  link.request = async (method, params, o) => { if (method === "agent.wait") throw Object.assign(new Error("timeout"), { code: "timeout" }); return orig(method, params, o); };
  const b = await bridge({ link });
  try {
    const r = await b.call("POST", `/threads/${A}/sends/${K1}/resend`, { message: "hello", originalAt: Date.now() - 1000, sessionSha256: await sha("sid-1") });
    assert.deepEqual(r.json, { ok: false, error: "resend_not_allowed", reason: "reconcile_incomplete" });
    assert.equal(b.writeLink.sends.length, 0);
  } finally { await b.close(); }
});

test("I4: an id sent in thread A cannot be resent through thread B (other_thread), nothing written", async () => {
  const b = await bridge();
  try {
    assert.equal((await send(b, A, K1)).status, 202);
    await sleep(W + 20);
    const r = await b.call("POST", `/threads/${B}/sends/${K1}/resend`, { message: "hello", originalAt: Date.now() - 1000, sessionSha256: null });
    assert.deepEqual(r.json, { ok: false, error: "resend_not_allowed", reason: "other_thread" });
    assert.equal(b.writeLink.sends.length, 1);
  } finally { await b.close(); }
});

test("I4: thread media is served for a hex tid (an inline image of that conversation's own message), and only through that tid", async () => {
  const b = await bridge();
  try {
    const key = `agent:main:app:owner:${A}`;
    const png = Buffer.alloc(80); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    const row = { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }], timestamp: 1, __openclaw: { id: "imgrow001" } };
    b.link.history[key] = (p) => ({ messages: [row] });
    const h = await b.call("GET", `/threads/${A}/history`);
    const ref = h.json.messages[0].media[0].ref;
    assert.match(ref, /^[0-9a-f]{32}$/);
    const m = await b.call("GET", `/threads/${A}/media?msg=imgrow001&ref=${ref}`);
    assert.equal(m.status, 200, m.text);
    assert.equal(m.text.length > 0, true);
    assert.equal((await b.call("GET", `/threads/${B}/media?msg=imgrow001&ref=${ref}`)).status, 404, "B's key is not A's: another conversation's media is never served");
  } finally { await b.close(); }
});

test("m3/m2: after a bridge restart the ENGINE says whether an id ran (any thread): a reused id is already_sent; another thread's run is 404", async () => {
  const link = fakeLink();
  link.waits[K1] = "ok"; // K1 ran in thread A before the bridge restarted
  const b = await bridge({ link });
  try {
    assert.deepEqual((await send(b, B, K1)).json, { ok: false, error: "already_sent" });
    assert.equal(b.writeLink.sends.length, 0);
    assert.equal((await b.call("GET", `/threads/${B}/runs/${K1}`)).status, 404, "agent.wait is global: B never reports A's run");
    assert.equal((await b.call("GET", `/threads/${B}/sends/${K1}?since=1`)).json.wait, null);
    link.request = ((orig) => async (m, p, o) => { if (m === "agent.wait") throw Object.assign(new Error("x"), { code: "link_down" }); return orig(m, p, o); })(link.request.bind(link));
    assert.deepEqual((await send(b, B, K2)).json, { ok: false, error: "not_written", reason: "precheck_failed" }, "no answer: definite, nothing sent");
  } finally { await b.close(); }
});

test("I5: POST /threads/legacy/reset resets the legacy conversation (sessions.reset, as /new) under the cap; flag off = 404", async () => {
  const b = await bridge();
  const off = await bridge({ threads: false });
  try {
    b.link.active = [`agent:main:app:owner:${A}`];
    assert.deepEqual((await b.call("POST", "/threads/legacy/reset", {})).json, { ok: false, error: "busy", busyThread: A });
    assert.ok(!b.calls.some((c) => c.method === "sessions.reset"));
    b.link.active = [];
    const r = await b.call("POST", "/threads/legacy/reset", {});
    assert.equal(r.status, 200, r.text); assert.equal(r.json.ok, true);
    assert.deepEqual(b.calls.find((c) => c.method === "sessions.reset").params, { key: "agent:main:app:owner", reason: "new" });
    assert.equal((await b.call("POST", `/threads/${A}/reset`, {})).status, 404, "only the legacy conversation is reset here");
    assert.equal((await off.call("POST", "/threads/legacy/reset", {})).status, 404);
  } finally { await b.close(); await off.close(); }
});

test("m5: a legacy reset under way makes a thread send to 'legacy' busy; legacy settings share ONE queue whichever route is used", async () => {
  const timeline = [];
  let resetGate;
  const link = fakeLink();
  link.sessions["agent:main:app:owner"] = { key: "agent:main:app:owner", sessionId: "s", thinkingLevels: [{ id: "low" }, { id: "high" }] };
  const gc = async (method, params) => {
    if (method === "sessions.describe") return { session: link.sessions[params.key] ?? null };
    if (method === "sessions.reset") { await new Promise((r) => { resetGate = r; }); return { ok: true, key: params.key }; }
    if (method === "sessions.patch") { timeline.push(`start:${params.thinkingLevel}`); await sleep(80); timeline.push(`end:${params.thinkingLevel}`); return { ok: true }; }
    throw new Error(`unexpected ${method}`);
  };
  const b = await bridge({ link, gatewayCall: gc });
  try {
    const reset = b.call("POST", "/new", {});
    await until(() => !!resetGate);
    assert.deepEqual((await send(b, "legacy", K1)).json, { ok: false, error: "busy", busyThread: "legacy" });
    resetGate(); await reset;
    await Promise.all([b.call("POST", "/thinking", { level: "low" }), b.call("POST", "/threads/legacy/thinking", { level: "high" })]);
    assert.deepEqual(timeline, ["start:low", "end:low", "start:high", "end:high"], "never interleaved");
  } finally { await b.close(); }
});

test("m1/m6/m8: the settings queue map is pruned; an unavailable model is refused; a percent-encoded tid is refused", async () => {
  const { createKeyedSerial } = await import("./app-bridge-threads.js");
  const q = createKeyedSerial();
  await Promise.all([q("a", () => sleep(5)), q("b", () => sleep(5)), q("a", () => sleep(5))]);
  await sleep(5);
  assert.equal(q.size(), 0);
  const b = await bridge({ gatewayCall: async (m, p) => {
    if (m === "models.list") return { models: [{ id: "down", provider: "mock", available: false }] };
    if (m === "sessions.patch") throw new Error("must not patch");
    throw new Error(m);
  } });
  try {
    const key = `agent:main:app:owner:${A}`;
    b.link.sessions[key] = { key, sessionId: "s", modelProvider: "mock", model: "echo" };
    assert.equal((await b.call("POST", `/threads/${A}/model`, { model: "mock/down" })).json.reason, "model_unavailable");
    const enc = [...A].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("");
    const r = await b.call("GET", `/threads/${enc}/model`);
    assert.equal(r.status, 400); assert.equal(r.json.reason, "bad_tid");
    assert.equal((await b.call("GET", `/threads/%6c%65%67%61%63%79/model`)).json.reason, "bad_tid", "'legacy' encoded too");
  } finally { await b.close(); }
});

test("Codex: an OLDER turn behind a tool-heavy later turn is located by bounded paging (no false 404); unreachable = honest unknown", async () => {
  const key = `agent:main:app:owner:${A}`;
  const tools = (n, t0) => Array.from({ length: n }, (_, i) => (i % 2
    ? { role: "toolResult", toolCallId: `c${i}`, content: [], timestamp: t0 + i, __openclaw: { id: `tool${String(i).padStart(5, "0")}` } }
    : { role: "assistant", content: [{ type: "toolCall", id: `c${i + 1}`, name: "read" }], timestamp: t0 + i, __openclaw: { id: `tool${String(i).padStart(5, "0")}`, runId: K2 } }));
  const all = [
    { role: "user", idempotencyKey: `${K1}:user`, content: "old question", timestamp: 1, __openclaw: { id: "old00001" } },
    { role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: 2, __openclaw: { id: "old00002", runId: K1 } },
    { role: "user", idempotencyKey: `${K2}:user`, content: "new question", timestamp: 3, __openclaw: { id: "new00003" } },
    ...tools(300, 4)];
  const pager = (hasOlderKnown = true, win = Infinity) => (p) => {
    if (!p.messageId) return { messages: all.slice(-p.limit), hasMore: all.length > p.limit };
    const at = all.findIndex((m) => m.__openclaw.id === p.messageId);
    const lo = Math.max(0, at - Math.min(p.limit, win) + 1);
    return { messages: all.slice(lo, at + 1), ...(hasOlderKnown ? { anchor: { hasOlder: lo > 0 } } : {}) };
  };
  const link = fakeLink();
  link.history[key] = pager();
  link.waits[K1] = "ok";
  const b = await bridge({ link }); // fresh bridge: no live record (restart / eviction)
  try {
    const r = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, "done"); assert.equal(r.json.text, "old answer"); assert.equal(r.json.interrupted, false);
    assert.ok(b.link.requests.filter((q) => q.method === "chat.history").every((q) => q.params.limit <= 200), "bounded pages, real validator");
    // the membership check still holds: thread B does not have K1
    link.history[`agent:main:app:owner:${B}`] = { messages: [] };
    assert.equal((await b.call("GET", `/threads/${B}/runs/${K1}`)).status, 404);
  } finally { await b.close(); }
  // paging cannot tell (the engine does not say whether older rows exist): unknown, not not_found
  link.history[key] = pager(false, 20);
  const b2 = await bridge({ link });
  try {
    const u = await b2.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(u.status, 200); assert.equal(u.json.status, "unknown"); assert.equal(u.json.located, false); assert.equal(u.json.text, "");
  } finally { await b2.close(); }
});

// ---------------------------------------------------------------- fix round 2: integration repro shapes (P2-B4-1-INTEGRATION) ----------
const userRow = (K, id, t = 1) => ({ role: "user", idempotencyKey: `${K}:user`, content: "hello", timestamp: t, __openclaw: { id } });
const replyRow = (K, id, text, t = 2, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: t, __openclaw: { id, runId: K }, ...extra });

test("BUG-1 (repro 1): a repeat send answered ack:\"ok\" after a restart (agent.wait times out) ends 'done' with the reply text, never 'running'", async () => {
  const link = fakeLink();
  const key = `agent:main:app:owner:${A}`;
  link.sessions[key] = { key, sessionId: "sid-1" };
  link.history[key] = { messages: [userRow(K1, "row0001"), replyRow(K1, "row0002", "the earlier reply")] };
  const b = await bridge({ link }); // a fresh bridge, gateway restarted too: agent.wait K -> "timeout" (integration s3 full-restart)
  try {
    b.writeLink.behave = (p) => ({ runId: p.idempotencyKey, status: "ok" });
    const s = await send(b, A, K1);
    assert.equal(s.status, 202); assert.equal(s.json.ack, "ok");
    const r = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r.json.status, "done"); assert.equal(r.json.text, "the earlier reply");
  } finally { await b.close(); }
  // gateway still up (bridge-only restart): the engine already knows K -> refused before any write (m3), not a stuck "running"
  link.waits[K1] = "ok";
  const b2 = await bridge({ link });
  try {
    assert.deepEqual((await send(b2, A, K1)).json, { ok: false, error: "already_sent" });
    assert.equal(b2.writeLink.sends.length, 0);
    const r = await b2.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r.json.status, "done"); assert.equal(r.json.text, "the earlier reply");
  } finally { await b2.close(); }
});

test("BUG-1 (repro 2): after ack_lost / ack_timeout the run that did execute ends 'done' from history even when agent.wait times out", async () => {
  for (const code of ["ack_lost", "ack_timeout"]) {
    const link = fakeLink();
    const key = `agent:main:app:owner:${A}`;
    const b = await bridge({ link });
    try {
      b.writeLink.behave = () => { throw Object.assign(new Error(code), { code }); };
      assert.equal((await send(b, A, K1)).json.reason, code);
      let r = await b.call("GET", `/threads/${A}/runs/${K1}`);
      assert.equal(r.json.status, "running", "nothing known yet");
      link.history[key] = { messages: [userRow(K1, "row0001"), replyRow(K1, "row0002", `ack ${code}`)] }; // the engine ran it
      await sleep(1600); // the next engine check (at most every 1.5 s while running)
      r = await b.call("GET", `/threads/${A}/runs/${K1}`);
      assert.equal(r.json.status, "done", code); assert.equal(r.json.text, `ack ${code}`);
    } finally { await b.close(); }
  }
});

test("BUG-1 (repro 3): a gateway crash while the bridge stays up: the resumed turn makes K 'unknown' + interrupted, not 'running' forever", async () => {
  const link = fakeLink();
  const key = `agent:main:app:owner:${A}`;
  const b = await bridge({ link });
  try {
    assert.equal((await send(b, A, K1)).status, 202);
    // SIGKILL lost the partial reply under K; the engine resumed the turn in a new run (integration s7c)
    link.history[key] = { messages: [userRow(K1, "row0001"),
      { role: "assistant", content: [{ type: "text", text: "RESUMED ack s7c" }], stopReason: "stop", timestamp: 5, __openclaw: { id: "row0005", runId: "1d963dd6-run", continuation: { source: "restart" } } }] };
    await sleep(1600);
    const r = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r.json.status, "unknown"); assert.equal(r.json.interrupted, true);
    assert.deepEqual(r.json.resumed, { runId: "1d963dd6-run", text: "RESUMED ack s7c" });
    assert.equal(b.writeLink.sends.length, 1, "nothing re-sent");
  } finally { await b.close(); }
});

test("F1/item 8: 'unavailable during gateway startup' (UNAVAILABLE, reason startup-sidecars) is the definite 503 engine_starting; no stuck record", async () => {
  const b = await bridge();
  try {
    for (const message of ["chat.send unavailable during gateway startup", "Agent main has not completed startup inspection and preparation. Inspection and writable admission continue after the Gateway listener binds."]) {
      b.writeLink.behave = () => { throw Object.assign(new Error(message), { code: "UNAVAILABLE", refused: true, reason: "startup-sidecars", retryAfterMs: 500 }); };
      const K = (await import("node:crypto")).randomUUID();
      const r = await send(b, A, K);
      assert.equal(r.status, 503); assert.deepEqual(r.json, { ok: false, error: "engine_starting", retryAfterMs: 500 });
      assert.ok(DEFINITE_REFUSALS.includes("engine_starting"));
      assert.equal((await b.call("GET", `/threads/${A}/runs/${K}`)).status, 404, "no live record left behind");
      await sleep(W + 10);
    }
    // another UNAVAILABLE (not the startup admission) stays unknown
    assert.equal(classifySendError(Object.assign(new Error("x"), { code: "UNAVAILABLE", refused: true, reason: "other" })).error, "outcome_unknown");
  } finally { await b.close(); }
});

test("BUG-2: a second final carrying an engine status notice never replaces the reply (either order); history agrees", async () => {
  const b = await bridge();
  try {
    const key = `agent:main:app:owner:${A}`;
    const notice = { role: "assistant", content: [{ type: "text", text: "↪️ Model Fallback: xai/grok-3-fast (selected xai/grok-3; selected model unavailable)", openclawStatusNotice: true }] };
    assert.equal((await send(b, A, K1)).status, 202);
    b.writeLink.emit("chat", { runId: K1, sessionKey: key, seq: 1, state: "delta", deltaText: "ack s2b4" });
    b.writeLink.emit("chat", { runId: K1, sessionKey: key, seq: 2, state: "final", message: { role: "assistant", content: [{ type: "text", text: "ack s2b4" }] } });
    b.writeLink.emit("chat", { runId: K1, sessionKey: key, seq: 3, state: "final", message: notice });
    let r = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r.json.status, "done"); assert.equal(r.json.text, "ack s2b4");
    await sleep(W + 20);
    assert.equal((await send(b, A, K2)).status, 202);
    b.writeLink.emit("chat", { runId: K2, sessionKey: key, seq: 1, state: "final", message: { role: "assistant", content: [{ type: "text", text: "⚠️ Exec failed", openclawStatusNotice: true }] } });
    b.writeLink.emit("chat", { runId: K2, sessionKey: key, seq: 2, state: "final", message: { role: "assistant", content: [{ type: "text", text: "the reply" }] } });
    r = await b.call("GET", `/threads/${A}/runs/${K2}`);
    assert.equal(r.json.text, "the reply");
  } finally { await b.close(); }
});

test("BUG-5: a new conversation's session hash is captured after the ack (bounded retries); resend of that message is already_received", async () => {
  const link = fakeLink(); link.autoSession = false;
  const key = `agent:main:app:owner:${A}`;
  let describesAfterSend = 0;
  const orig = link.request.bind(link);
  link.request = async (m, p, o) => {
    if (m === "sessions.describe" && b.writeLink.sends.length > 0 && ++describesAfterSend === 2) link.sessions[key] = { key, sessionId: "sid-new" };
    return orig(m, p, o);
  };
  const b = await bridge({ link });
  try {
    const s = await send(b, A, K1);
    assert.equal(s.status, 202);
    assert.equal(s.json.sessionSha256, await sha("sid-new"), "the engine showed the session only on the 2nd describe after the ack");
    link.history[key] = { messages: [userRow(K1, "row0001", Date.now())] };
    await sleep(W + 20);
    // the API had stored null at reservation (integration s3r a/b): reconcile decides, not a blanket session_changed
    const r = await b.call("POST", `/threads/${A}/sends/${K1}/resend`, { message: "hello", originalAt: Date.now() - 1000, sessionSha256: null });
    assert.deepEqual(r.json, { ok: false, error: "resend_not_allowed", reason: "already_received" });
  } finally { await b.close(); }
  // a fresh bridge, null at reservation, a session now exists that does NOT hold K: still refused (cannot tell it from a replaced one)
  const link2 = fakeLink();
  link2.sessions[key] = { key, sessionId: "sid-other" };
  link2.history[key] = { messages: [] };
  const b2 = await bridge({ link: link2 });
  try {
    const r = await b2.call("POST", `/threads/${A}/sends/${K2}/resend`, { message: "hello", originalAt: Date.now() - 1000, sessionSha256: null });
    assert.deepEqual(r.json, { ok: false, error: "resend_not_allowed", reason: "session_changed" });
    assert.equal(b2.writeLink.sends.length, 0);
  } finally { await b2.close(); }
});

test("round-2 edges: two real finals keep the FIRST; ack 'ok' is done even with history unreadable; a non-final own row keeps 'running'; null-hash resend after a restart is already_received", async () => {
  const key = `agent:main:app:owner:${A}`;
  const b = await bridge();
  try {
    assert.equal((await send(b, A, K1)).status, 202);
    b.writeLink.emit("chat", { runId: K1, sessionKey: key, seq: 1, state: "final", message: { role: "assistant", content: [{ type: "text", text: "first" }] } });
    b.writeLink.emit("chat", { runId: K1, sessionKey: key, seq: 2, state: "final", message: { role: "assistant", content: [{ type: "text", text: "second" }] } });
    assert.equal((await b.call("GET", `/threads/${A}/runs/${K1}`)).json.text, "first");
    // a reply row of K that is NOT final (mid-turn text before a tool step, no stop reason): still running
    await sleep(W + 20);
    assert.equal((await send(b, A, K2)).status, 202);
    b.link.history[key] = { messages: [userRow(K2, "row0010"), { role: "assistant", content: [{ type: "text", text: "let me check" }], stopReason: "toolUse", timestamp: 3, __openclaw: { id: "row0011", runId: K2 } }] };
    await sleep(1600);
    assert.equal((await b.call("GET", `/threads/${A}/runs/${K2}`)).json.status, "running");
    // ack "ok" with history unreadable and agent.wait timing out: done (no final will ever come)
    await sleep(W + 20);
    b.writeLink.behave = (p) => ({ runId: p.idempotencyKey, status: "ok" });
    assert.equal((await send(b, A, K3)).json.ack, "ok");
    b.link.failHistory = true;
    assert.equal((await b.call("GET", `/threads/${A}/runs/${K3}`)).json.status, "done");
  } finally { await b.close(); }
  // after a bridge restart (no record), the API stored null at reservation, the session the original created holds "<K>:user"
  const link = fakeLink();
  link.sessions[key] = { key, sessionId: "sid-created" };
  link.history[key] = { messages: [userRow(K1, "row0001", Date.now())] };
  const b2 = await bridge({ link });
  try {
    const r = await b2.call("POST", `/threads/${A}/sends/${K1}/resend`, { message: "hello", originalAt: Date.now() - 1000, sessionSha256: null });
    assert.deepEqual(r.json, { ok: false, error: "resend_not_allowed", reason: "already_received" });
  } finally { await b2.close(); }
});


// ---------------------------------------------------------------- fix round 2, review N1-N6 and Codex (9555422) --------------------------
const toolRowsN = (n, ts) => Array.from({ length: n }, (_, i) => ({ role: "toolResult", toolName: "exec", content: [{ type: "text", text: "x" }], timestamp: ts + i, __openclaw: { id: `tool${String(i).padStart(5, "0")}` } }));

test("N1 (R2-A): a missed final in a tool-heavy turn (>50 rows) finalises with the engine's text, found by bounded paging", async () => {
  const link = fakeLink(); const key = `agent:main:app:owner:${A}`;
  const b = await bridge({ link });
  try {
    assert.equal((await send(b, A, K1)).status, 202);
    const all = [userRow(K1, "row0001"), ...toolRowsN(60, 10), { role: "assistant", content: [{ type: "text", text: "FINAL ANSWER" }], stopReason: "stop", timestamp: 100, __openclaw: { id: "row9999", runId: K1 } }];
    link.history[key] = (p) => {
      if (!p.messageId) return { messages: all.slice(-p.limit), hasMore: all.length > p.limit };
      const at = all.findIndex((m) => m.__openclaw.id === p.messageId);
      const lo = Math.max(0, at - p.limit + 1);
      return { messages: all.slice(lo, at + 1), anchor: { hasOlder: lo > 0 } };
    };
    link.waits[K1] = "ok";
    await sleep(1600);
    const r = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r.json.status, "done"); assert.equal(r.json.text, "FINAL ANSWER"); assert.equal(r.json.textPending, undefined);
    const r2 = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r2.json.text, "FINAL ANSWER");
  } finally { await b.close(); }
});

test("N1 (R2-B): the run ends between reads: agent.wait is read FIRST; text never freezes empty — pending, then filled on a later poll", async () => {
  const link = fakeLink(); const key = `agent:main:app:owner:${A}`;
  const b = await bridge({ link });
  try {
    assert.equal((await send(b, A, K1)).status, 202);
    let reads = 0;
    const order = [];
    const orig = link.request.bind(link);
    link.request = async (m, p, o) => { if (m === "agent.wait" || m === "chat.history") order.push(m); return orig(m, p, o); };
    link.history[key] = () => (++reads === 1 ? { messages: [userRow(K1, "row0001")] }
      : { messages: [userRow(K1, "row0001"), { role: "assistant", content: [{ type: "text", text: "FINAL" }], stopReason: "stop", timestamp: 2, __openclaw: { id: "row0002", runId: K1 } }] });
    link.waits[K1] = "ok"; // terminal, but the first history page does not have the reply row yet
    await sleep(1600);
    const r = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(order[0], "agent.wait", "agent.wait before history");
    assert.equal(r.json.status, "done"); assert.equal(r.json.text, ""); assert.equal(r.json.textPending, true, "pending, not frozen");
    const r2 = await b.call("GET", `/threads/${A}/runs/${K1}`); // the very next poll re-reads (no 1.5 s throttle while pending)
    assert.equal(r2.json.text, "FINAL"); assert.equal(r2.json.textPending, undefined);
  } finally { await b.close(); }
});

test("N1: a notice-only final (no reply text in the event) is pending and filled from the engine's reply row", async () => {
  const link = fakeLink(); const key = `agent:main:app:owner:${A}`;
  const b = await bridge({ link });
  try {
    assert.equal((await send(b, A, K1)).status, 202);
    b.writeLink.emit("chat", { runId: K1, sessionKey: key, seq: 1, state: "final", message: { role: "assistant", content: [{ type: "text", text: "⚠️ Exec failed", openclawStatusNotice: true }] } });
    link.history[key] = { messages: [userRow(K1, "row0001"), replyRow(K1, "row0002", "the real reply")] };
    const r = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r.json.status, "done"); assert.equal(r.json.text, "the real reply");
  } finally { await b.close(); }
});

test("Codex: the resumed reply text is the continuation's answer, never a trailing engine status notice", async () => {
  const link = fakeLink(); const key = `agent:main:app:owner:${A}`;
  link.history[key] = { messages: [userRow(K1, "row0001"),
    { role: "assistant", content: [{ type: "text", text: "continued answer" }], stopReason: "stop", timestamp: 5, __openclaw: { id: "row0005", runId: "run-r2", continuation: { source: "restart" } } },
    { role: "assistant", content: [{ type: "text", text: "↪️ Model Fallback: x", openclawStatusNotice: true }], timestamp: 6, __openclaw: { id: "row0006", runId: "run-r2" } }] };
  const b = await bridge({ link });
  try {
    const r = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.deepEqual(r.json.resumed, { runId: "run-r2", text: "continued answer" });
  } finally { await b.close(); }
});

test("Codex: an UNCACHED run whose turn holds K's final reply (stopReason stop) is 'done' even when agent.wait times out (gateway + wrapper restart)", async () => {
  const link = fakeLink(); const key = `agent:main:app:owner:${A}`;
  link.history[key] = { messages: [userRow(K1, "row0001"), replyRow(K1, "row0002", "finished before the restart")] }; // agent.wait K -> "timeout"
  const b = await bridge({ link });
  try {
    const r = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r.json.status, "done"); assert.equal(r.json.text, "finished before the restart");
    link.history[key] = { messages: [userRow(K1, "row0001"), { role: "assistant", content: [{ type: "text", text: "let me check" }], stopReason: "toolUse", timestamp: 2, __openclaw: { id: "row0002", runId: K1 } }] };
    assert.equal((await b.call("GET", `/threads/${A}/runs/${K1}`)).json.status, "unknown", "a non-final row is not completion");
  } finally { await b.close(); }
});

test("N2: an engine REFUSAL of the already-used-id check is reported distinctly (precheck_refused), bounded; nothing is sent", async () => {
  const link = fakeLink();
  const timeouts = [];
  const orig = link.request.bind(link);
  link.request = async (m, p, o) => {
    if (m === "agent.wait") { timeouts.push(o?.timeoutMs); throw Object.assign(new Error("missing scope: operator.read"), { code: "INVALID_REQUEST", refused: true }); }
    return orig(m, p, o);
  };
  const b = await bridge({ link });
  try {
    assert.deepEqual((await send(b, A, K1)).json, { ok: false, error: "not_written", reason: "precheck_refused" });
    assert.ok(timeouts[0] <= 3000, "a short timeout inside the send mutex");
    assert.equal(b.writeLink.sends.length, 0);
  } finally { await b.close(); }
});

test("N3: polling an unknown id in a long conversation pages back once; repeated polls within 5 s reuse it (2 link reads each)", async () => {
  const link = fakeLink(); const key = `agent:main:app:owner:${A}`;
  const rows = []; for (let i = 0; i < 3000; i++) rows.push({ role: i % 2 ? "assistant" : "user", content: "x", timestamp: i, __openclaw: { id: `r${String(i).padStart(6, "0")}` } });
  link.history[key] = (p) => {
    if (!p.messageId) return { messages: rows.slice(-p.limit), hasMore: true };
    const at = rows.findIndex((m) => m.__openclaw.id === p.messageId);
    return { messages: rows.slice(Math.max(0, at - p.limit + 1), at + 1), anchor: { hasOlder: at - p.limit + 1 > 0 } };
  };
  const b = await bridge({ link });
  try {
    let before = link.requests.length;
    const r = await b.call("GET", `/threads/${A}/runs/${K2}`);
    assert.equal(r.json.status, "unknown"); assert.equal(r.json.located, false);
    assert.ok(link.requests.length - before <= 12, String(link.requests.length - before));
    before = link.requests.length;
    await b.call("GET", `/threads/${A}/runs/${K2}`);
    assert.equal(link.requests.length - before, 2, "agent.wait + one history page");
  } finally { await b.close(); }
});

test("N6 (#24): /threads/legacy/reset holds the SEND MUTEX: a thread send arriving during the reset is not written until it ends", async () => {
  let release;
  const link = fakeLink();
  link.sessions["agent:main:app:owner"] = { key: "agent:main:app:owner", sessionId: "s" };
  const gc = async (method, params) => {
    if (method === "sessions.describe") return { session: link.sessions[params.key] ?? null };
    if (method === "sessions.reset") { await new Promise((r) => { release = r; }); return { ok: true, key: params.key }; }
    throw new Error(`unexpected ${method}`);
  };
  const b = await bridge({ link, gatewayCall: gc });
  try {
    const reset = b.call("POST", "/threads/legacy/reset", {});
    await until(() => !!release);
    const s = send(b, B, K1);
    await sleep(100);
    assert.equal(b.writeLink.sends.length, 0, "no write while the reset runs");
    release();
    assert.equal((await reset).status, 200);
    assert.equal((await s).status, 202);
    assert.equal(b.writeLink.sends.length, 1);
  } finally { await b.close(); }
});

test("N6 (#38): a RESEND to 'legacy' during legacy /new is busy (legacy), nothing written", async () => {
  let release;
  const link = fakeLink();
  const lkey = "agent:main:app:owner";
  link.sessions[lkey] = { key: lkey, sessionId: "s" };
  const gc = async (method, params) => {
    if (method === "sessions.describe") return { session: link.sessions[params.key] ?? null };
    if (method === "sessions.reset") { await new Promise((r) => { release = r; }); return { ok: true, key: params.key }; }
    throw new Error(`unexpected ${method}`);
  };
  const b = await bridge({ link, gatewayCall: gc });
  try {
    const reset = b.call("POST", "/new", {});
    await until(() => !!release);
    const r = await b.call("POST", `/threads/legacy/sends/${K1}/resend`, { message: "hello", originalAt: Date.now() - 1000, sessionSha256: await sha("s") });
    assert.deepEqual(r.json, { ok: false, error: "busy", busyThread: "legacy" });
    assert.equal(b.writeLink.sends.length, 0);
    release(); await reset;
  } finally { await b.close(); }
});


test("Codex (7f6843e): agent.wait ok before the final row is readable: a toolUse preamble never becomes the answer; pending until the final row", async () => {
  const link = fakeLink(); const key = `agent:main:app:owner:${A}`;
  const b = await bridge({ link });
  try {
    assert.equal((await send(b, A, K1)).status, 202);
    const preamble = { role: "assistant", content: [{ type: "text", text: "let me look that up" }, { type: "toolCall", id: "c1", name: "read" }], stopReason: "toolUse", timestamp: 2, __openclaw: { id: "row0002", runId: K1 } };
    const textOnlyPreamble = { role: "assistant", content: [{ type: "text", text: "one moment" }], stopReason: "toolUse", timestamp: 3, __openclaw: { id: "row0003", runId: K1 } };
    link.history[key] = { messages: [userRow(K1, "row0001"), preamble, textOnlyPreamble] };
    link.waits[K1] = "ok";
    await sleep(1600);
    let r = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r.json.status, "done"); assert.equal(r.json.text, ""); assert.equal(r.json.textPending, true);
    link.history[key] = { messages: [userRow(K1, "row0001"), preamble, textOnlyPreamble, replyRow(K1, "row0009", "the final answer", 9)] };
    r = await b.call("GET", `/threads/${A}/runs/${K1}`);
    assert.equal(r.json.text, "the final answer"); assert.equal(r.json.textPending, undefined);
  } finally { await b.close(); }
  // the terminal stop reasons count as final; toolUse / restart / none do not
  const { isFinalReply } = await import("./app-bridge-threads.js");
  const row = (stopReason) => ({ role: "assistant", content: [{ type: "text", text: "x" }], stopReason });
  for (const r of ["stop", "end_turn", "length", "error", "aborted", "timeout", "cancelled"]) assert.equal(isFinalReply(row(r)), true, r);
  for (const r of ["toolUse", "restart", undefined, "rpc", "STOP"]) assert.equal(isFinalReply(row(r)), false, String(r));
});
