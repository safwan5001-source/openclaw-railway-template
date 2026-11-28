// B4 (P2-B4-1): what the threads flag changes on the ADMIN link, and that nothing changes with it off.
// FAKE WebSocket; approval/plugin shapes from the P2-B4-1 lab (exec rows E5, plugin approval request §3.2 candidate 3).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { APP_SESSION_KEY, LINK_METHODS, LINK_SCOPES, SESSIONS_ACTIVE_PARAMS, SESSIONS_CAP_PARAMS, THREAD_LINK_METHODS, approvalThread, approvalView, createGatewayLink, normalizeEvent } from "./gateway-link.js";

const TOKEN = "synthetic-gateway-token-0123456789abcdef";
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));
const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };
const HEX = "0123456789abcdef0123456789abcdef";
const TKEY = `agent:main:app:owner:${HEX}`;
const K = "9a9f4cbf-3890-428f-ba8d-b5b33713034c";

function fakeGateway({ lists = {} } = {}) {
  const sockets = [];
  class FakeWS {
    constructor() { this.sent = []; this.closed = false; sockets.push(this); setImmediate(() => this.emit({ type: "event", event: "connect.challenge", payload: {} })); }
    emit(f) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(f) }); }
    send(raw) {
      const f = JSON.parse(raw); this.sent.push(f);
      const reply = (ok, payload, error) => setImmediate(() => this.emit({ type: "res", id: f.id, ok, payload, error }));
      if (f.method === "connect") return reply(true, { type: "hello-ok", auth: { scopes: [...LINK_SCOPES] }, policy: { tickIntervalMs: 15000 } });
      if (f.method in lists) return reply(true, lists[f.method]);
      return reply(true, []);
    }
    close() { this.closed = true; setImmediate(() => this.onclose?.({})); }
    event(name, payload) { this.emit({ type: "event", event: name, payload }); }
  }
  return { FakeWS, last: () => sockets.at(-1) };
}
const start = async (threads, lists) => {
  const gw = fakeGateway({ lists });
  const link = createGatewayLink({ url: "ws://x", token: TOKEN, WebSocketImpl: gw.FakeWS, threads });
  link.start(); await until(() => link.isUp());
  return { gw, link };
};
const execReq = (id, sessionKey) => ({ id, createdAtMs: 1, expiresAtMs: Date.now() + 60_000, request: { command: "echo hi", sessionKey, allowedDecisions: ["allow-once", "deny"] } });
// the lab's plugin approval request (requireApproval from before_tool_call): id plugin:<uuid>, request {pluginId, title, description, severity, toolName, toolCallId, sessionKey, runId, …}
const pluginReq = (sessionKey) => ({ id: `plugin:${K}`, createdAtMs: 2, expiresAtMs: Date.now() + 60_000,
  request: { pluginId: "basht-resume-guard", title: "تشغيل مستأنف بعد إعادة التشغيل", description: "RESUMED RUN …", severity: "critical", toolName: "daftra-mcp__execute_tools",
    toolCallId: "call_1", sessionKey, runId: "r2", allowedDecisions: ["allow-once", "deny"] } });

test("flag off: thread reads and the cap read are refused locally; approvals and events keep their exact old shape", async () => {
  const { gw, link } = await start(false);
  const before = gw.last().sent.length;
  await assert.rejects(link.request("chat.history", { sessionKey: TKEY, limit: 5 }), { code: "not_allowed" });
  await assert.rejects(link.request("agent.wait", { runId: K, timeoutMs: 0 }), { code: "not_allowed" });
  await assert.rejects(link.request("sessions.list", { ...SESSIONS_CAP_PARAMS }), { code: "bad_params" });
  assert.equal(gw.last().sent.length, before);
  const v = approvalView(execReq("approval-1", TKEY), "exec");
  assert.ok(!("thread" in v) && !("severity" in v) && !("toolName" in v));
  assert.equal(normalizeEvent("chat", { sessionKey: TKEY, state: "final", runId: K }), null, "other app keys' chats are not reported with the flag off");
  assert.deepEqual(normalizeEvent("chat", { sessionKey: APP_SESSION_KEY, state: "final", runId: "r" }), { type: "chat.final", session: "app", runId: "r" });
  assert.equal(link.approvalThreadOf("x"), null);
  assert.deepEqual([...THREAD_LINK_METHODS].sort(), ["agent.wait", "chat.history"]);
  for (const m of THREAD_LINK_METHODS) assert.ok(!LINK_METHODS.has(m), "the flag-off allowlist is unchanged");
  link.stop();
});

test("flag on: chat.history / agent.wait / the cap read are allowed with CLOSED params only (qualified key, bounds, nothing extra)", async () => {
  const { gw, link } = await start(true, { "chat.history": { messages: [] }, "agent.wait": { status: "ok" }, "sessions.list": { totalCount: 0, sessions: [] } });
  await link.request("chat.history", { sessionKey: TKEY, limit: 200 });
  await link.request("chat.history", { sessionKey: APP_SESSION_KEY, limit: 1, messageId: "abcdef12" });
  await link.request("agent.wait", { runId: K, timeoutMs: 0 });
  await link.request("sessions.list", { ...SESSIONS_CAP_PARAMS });
  await link.request("sessions.list", { ...SESSIONS_ACTIVE_PARAMS });
  const before = gw.last().sent.length;
  const bad = [["chat.history", { sessionKey: `app:owner:${HEX}`, limit: 5 }], ["chat.history", { sessionKey: TKEY.toUpperCase(), limit: 5 }], ["chat.history", { sessionKey: `${TKEY}:x`, limit: 5 }],
    ["chat.history", { sessionKey: "agent:main:whatsapp:direct:+966500000001", limit: 5 }], ["chat.history", { sessionKey: "agent:main:main", limit: 5 }],
    ["chat.history", { sessionKey: TKEY, limit: 201 }], ["chat.history", { sessionKey: TKEY }], ["chat.history", { sessionKey: TKEY, limit: 5, includeTools: true }],
    ["chat.history", { sessionKey: TKEY, limit: 5, messageId: "../x" }], ["agent.wait", { runId: K, timeoutMs: 2001 }], ["agent.wait", { runId: K.toUpperCase(), timeoutMs: 0 }],
    ["agent.wait", { runId: "chatcmpl_x", timeoutMs: 0 }], ["agent.wait", { runId: K }], ["sessions.list", { ...SESSIONS_CAP_PARAMS, limit: 201 }],
    ["sessions.list", { ...SESSIONS_CAP_PARAMS, search: "+9665" }], ["sessions.list", { ...SESSIONS_CAP_PARAMS, activeOnly: false }]];
  for (const [m, p] of bad) await assert.rejects(link.request(m, p), { code: "bad_params" }, `${m} ${JSON.stringify(p)}`);
  assert.equal(gw.last().sent.length, before, "nothing refused reached the gateway");
  await assert.rejects(link.request("chat.send", { sessionKey: `app:owner:${HEX}` }), { code: "not_allowed" }, "chat.send never on the admin link, flag or not");
  link.stop();
});

test("sessions.describe on the link: only the exact qualified app keys (the wrapper-level key check at the link)", async () => {
  for (const threads of [false, true]) {
    const { link } = await start(threads, { "sessions.describe": { session: null } });
    await link.request("sessions.describe", { key: APP_SESSION_KEY });
    await link.request("sessions.describe", { key: TKEY });
    for (const k of [TKEY.toUpperCase(), `app:owner:${HEX}`, "agent:main:main", `${TKEY}\n`, `${TKEY}:extra`, "agent:main:whatsapp:direct:+966500000001"]) {
      await assert.rejects(link.request("sessions.describe", { key: k }), { code: "bad_params" }, k);
    }
    await assert.rejects(link.request("sessions.describe", { key: TKEY, extra: 1 }), { code: "bad_params" });
    link.stop();
  }
});

test("flag on: approvals carry the thread from request.sessionKey WHEN RAISED (exec and plugin kinds); unknown keys are 'unknown', never legacy", async () => {
  assert.equal(approvalThread(TKEY), HEX);
  assert.equal(approvalThread(APP_SESSION_KEY), "legacy");
  assert.equal(approvalThread(undefined), "unknown");
  assert.equal(approvalThread(""), "unknown");
  assert.equal(approvalThread("agent:main:whatsapp:direct:+966500000001"), null, "not an app thread");
  assert.equal(approvalThread(TKEY.toUpperCase()), null);
  const { gw, link } = await start(true);
  gw.last().event("exec.approval.requested", execReq("approval-exec-1", TKEY));
  gw.last().event("plugin.approval.requested", pluginReq(APP_SESSION_KEY));
  await until(() => link.events(0).events.length >= 3);
  const recs = link.events(0).events.filter((e) => e.type === "approval.requested").map((e) => e.approval);
  assert.deepEqual(recs.map((a) => [a.kind, a.thread]), [["exec", HEX], ["plugin", "legacy"]]);
  const plugin = recs[1];
  assert.equal(plugin.id, `plugin:${K}`); assert.equal(plugin.severity, "critical"); assert.equal(plugin.toolName, "daftra-mcp__execute_tools");
  assert.equal(link.pendingKind(`plugin:${K}`), "plugin", "resolved as kind plugin");
  // the resolved event carries no key: the one recorded at request time wins
  gw.last().event("exec.approval.resolved", { id: "approval-exec-1", decision: "deny" });
  await until(() => link.events(0).events.some((e) => e.type === "approval.resolved"));
  assert.equal(link.events(0).events.find((e) => e.type === "approval.resolved").thread, HEX);
  assert.equal(link.approvalThreadOf("approval-exec-1"), HEX, "kept after it is decided (approval.history has no key)");
  assert.equal(link.approvalThreadOf("never-seen-1"), "unknown");
  // the turn waiting on it keeps its deadline (canonical, qualified key)
  gw.last().event("exec.approval.requested", execReq("approval-exec-2", TKEY));
  await until(() => link.approvalDeadline(TKEY) !== null);
  assert.ok(link.approvalDeadline(TKEY) > Date.now());
  assert.equal(link.approvalDeadline(`app:owner:${HEX}`), null, "only the canonical key");
  link.stop();
});

test("flag on: chat final/error events of every app conversation are tagged with their thread; others never", () => {
  const o = { threads: true };
  assert.deepEqual(normalizeEvent("chat", { sessionKey: TKEY, state: "final", runId: K }, o), { type: "chat.final", session: "app", runId: K, thread: HEX });
  assert.deepEqual(normalizeEvent("chat", { sessionKey: APP_SESSION_KEY, state: "error", runId: "r" }, o), { type: "chat.error", session: "app", runId: "r", thread: "legacy" });
  for (const k of ["agent:main:whatsapp:direct:+966500000001", "agent:main:main", TKEY.toUpperCase(), `app:owner:${HEX}`]) assert.equal(normalizeEvent("chat", { sessionKey: k, state: "final", runId: "r" }, o), null, k);
  assert.equal(normalizeEvent("chat", { sessionKey: TKEY, state: "delta", runId: K }, o), null);
});

test("BUG-7: thread approvals are the app's own (session 'app', isApp true) with their thread; flag off keeps the old labels", async () => {
  const v = approvalView(execReq("approval-t-1", TKEY), "exec", { threads: true });
  assert.deepEqual([v.session, v.isApp, v.thread], ["app", true, HEX]);
  const l = approvalView(execReq("approval-l-1", APP_SESSION_KEY), "exec", { threads: true });
  assert.deepEqual([l.session, l.isApp, l.thread], ["app", true, "legacy"]);
  const w = approvalView(execReq("approval-w-1", "agent:main:whatsapp:direct:+966500000001"), "exec", { threads: true });
  assert.deepEqual([w.session, w.isApp, w.thread], ["whatsapp", false, null]);
  const off = approvalView(execReq("approval-t-2", TKEY), "exec");
  assert.deepEqual([off.session, off.isApp], ["other", false], "flag off: unchanged");
  const p = approvalView(pluginReq(TKEY), "plugin", { threads: true });
  assert.deepEqual([p.session, p.isApp, p.thread], ["app", true, HEX]);
  const { gw, link } = await start(true);
  gw.last().event("exec.approval.requested", execReq("approval-t-3", TKEY));
  gw.last().event("exec.approval.resolved", { id: "approval-t-3", decision: "deny", request: { sessionKey: TKEY } });
  await until(() => link.events(0).events.some((e) => e.type === "approval.resolved"));
  const res = link.events(0).events.find((e) => e.type === "approval.resolved");
  assert.deepEqual([res.session, res.thread], ["app", HEX]);
  link.stop();
});

test("BUG-2: /events carries ONE chat.final per run even when the engine sends a second final (a status notice); flag off unchanged", async () => {
  const { gw, link } = await start(true);
  const fin = (n) => gw.last().event("chat", { sessionKey: TKEY, state: "final", runId: K, seq: n, message: { content: [{ type: "text", text: n === 1 ? "reply" : "notice", openclawStatusNotice: n !== 1 }] } });
  fin(1); fin(2);
  gw.last().event("chat", { sessionKey: TKEY, state: "final", runId: "22222222-2222-4222-8222-222222222222", seq: 1 });
  await until(() => link.events(0).events.filter((e) => e.type === "chat.final").length >= 2);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(link.events(0).events.filter((e) => e.type === "chat.final").map((e) => e.runId), [K, "22222222-2222-4222-8222-222222222222"]);
  link.stop();
  const off = await start(false);
  for (const n of [1, 2]) off.gw.last().event("chat", { sessionKey: APP_SESSION_KEY, state: "final", runId: "r", seq: n });
  await until(() => off.link.events(0).events.filter((e) => e.type === "chat.final").length >= 2);
  off.link.stop();
});
