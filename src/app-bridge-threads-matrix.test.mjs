// B4 (P2-B4-1): GET /threads/:tid/runs/:K over the FULL scenario cross-product (coordinator brief, fix round 2), through the real
// route, runOutcome(), the bounded paging and the REAL link validators (validateLinkRequest). The expected outcome of every row
// is the decision table of docs/BASHT_APP_BRIDGE.md "Run outcome", written out below independently of the implementation.
//   cached: a live record (sent through this bridge, one streamed delta, no final event) | uncached (fresh bridge)
//   wait:   agent.wait ok | timeout | error | unavailable (no answer)
//   seg:    K's turn within the newest 50 rows | beyond 50 rows (located by paging) | unreachable (paging cannot tell)
//   conts:  0 | 1 | 2 restart continuations inside K's turn
//   notice: a trailing engine status notice yes | no
//   final:  K's final row present | only a toolUse preamble
//   later:  a later user turn (with its OWN continuation) exists | not
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import express from "express";
import { createAppBridge } from "./app-bridge.js";
import { validateLinkRequest } from "./gateway-link.js";

const APP_TOKEN = "synthetic-app-token-0123456789abcdef0123";
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));
const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY = `agent:main:app:owner:${A}`;
const K = "11111111-1111-4111-8111-111111111111";
const KL = "22222222-2222-4222-8222-222222222222";

function fakeLink() {
  return {
    up: true, epoch: "a1b2c3d4e5f6", sessions: {}, all: [], unreachable: false, wait: undefined, failWait: false, threads: true,
    isUp() { return this.up; }, approvalsSynced: () => true, serverVersion: () => null, setDecorator() {},
    status() { return { state: "up", pendingApprovals: 0 }; }, approvalDeadline: () => null, pendingKind: () => null, forgetApproval() {},
    approvalThreadOf: () => "unknown", events: () => ({ epoch: "a1b2c3d4e5f6", latest: 0, oldest: null, truncated: false, events: [] }), waitForEvents: () => Promise.resolve(),
    async request(method, p) {
      const refused = validateLinkRequest(method, p, { threads: this.threads });
      if (refused) throw Object.assign(new Error(refused), { code: refused });
      if (method === "sessions.list") return { totalCount: 0, sessions: [] };
      if (method === "sessions.describe") return { session: this.sessions[p.key] ?? null };
      if (method === "agent.wait") {
        if (this.failWait) throw Object.assign(new Error("timeout"), { code: "timeout" });
        return { status: this.wait ?? "timeout" };
      }
      if (method === "chat.history") {
        if (!p.messageId) return { messages: this.all.slice(-p.limit), hasMore: this.all.length > p.limit };
        const at = this.all.findIndex((m) => m.__openclaw?.id === p.messageId);
        if (this.unreachable) return { messages: this.all.slice(Math.max(0, at - 19), at + 1) }; // no anchor.hasOlder: cannot tell
        const lo = Math.max(0, at - p.limit + 1);
        return { messages: this.all.slice(lo, at + 1), anchor: { hasOlder: lo > 0 } };
      }
      if (method.endsWith(".approval.list")) return [];
      throw new Error(`unexpected ${method}`);
    },
  };
}
function fakeWriteLink(link) {
  return {
    epoch: "ffffffffffff", listeners: new Set(), isUp: () => true, status: () => ({ state: "up" }),
    onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    emit(name, p) { for (const fn of this.listeners) fn(name, p); },
    async chatSend(p) { const q = `agent:main:${p.sessionKey}`; link.sessions[q] ??= { key: q, sessionId: "sid-1" }; return { runId: p.idempotencyKey, status: "started" }; },
  };
}
async function bridge(link, writeLink) {
  const router = createAppBridge({ token: APP_TOKEN, gatewayUrl: "http://gw.invalid", gatewayToken: "synthetic-gateway-token-0123456789abcdef",
    configPath: "/nonexistent/openclaw.json", fetchImpl: async () => { throw new Error("no http"); }, gatewayCall: async () => { throw new Error("no cli"); },
    link, writeLink, env: { BASHT_THREADS: "on" }, recentAcceptMs: 1 });
  const app = express(); app.use("/app/v1", router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/app/v1`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

let seq = 0;
const id = (p) => `${p}${String(++seq).padStart(6, "0")}`;
const asst = (runId, text, stopReason, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: seq, __openclaw: { id: id("a"), runId, ...extra } });

/** The conversation's rows for one scenario (oldest first). */
function rowsFor(c) {
  const rows = [{ role: "user", content: "older", timestamp: 0, __openclaw: { id: id("o") } }, asst("older-run", "older answer", "stop")];
  rows.push({ role: "user", idempotencyKey: `${K}:user`, content: "the question", timestamp: 1, __openclaw: { id: id("k") } });
  const tools = c.seg === "within" ? 0 : c.seg === "beyond" ? 60 : 230;
  for (let i = 0; i < tools; i++) rows.push({ role: "toolResult", toolCallId: `t${i}`, content: [{ type: "text", text: "x" }], timestamp: 2, __openclaw: { id: id("t") } });
  rows.push({ role: "assistant", content: [{ type: "text", text: "Let me check" }, { type: "toolCall", id: "c1", name: "read" }], stopReason: "toolUse", timestamp: 3, __openclaw: { id: id("p"), runId: K } });
  if (c.final) rows.push(asst(K, "K FINAL", "stop"));
  for (let n = 1; n <= c.conts; n++) {
    rows.push(asst(`R${n}`, `partial ${n}`, "toolUse", { turnBoundary: true, continuation: { source: "restart" } })); // a continuation's partial
    rows.push(asst(`R${n}`, `final ${n}`, "stop"));
  }
  if (c.notice) rows.push({ role: "assistant", content: [{ type: "text", text: "↪️ Model Fallback: x", openclawStatusNotice: true }], timestamp: 9, __openclaw: { id: id("n"), runId: c.conts ? `R${c.conts}` : K } });
  if (c.later) {
    rows.push({ role: "user", idempotencyKey: `${KL}:user`, content: "a later question", timestamp: 10, __openclaw: { id: id("l") } });
    rows.push(asst("RL", "LATER partial", "toolUse", { continuation: { source: "restart" } }));
    rows.push(asst("RL", "LATER FINAL", "stop"));
  }
  return rows;
}

/** The decision table, written out per scenario. */
function expected(c) {
  if (c.seg === "unreachable") return { status: "unknown", text: "", textPending: false, interrupted: false, resumed: null };
  const resumed = c.conts ? { runId: `R${c.conts}`, text: `final ${c.conts}`, textPending: false } : null;
  const w = c.wait === "unavailable" ? "timeout" : c.wait;
  let status; let text = ""; let textPending = false;
  if (c.final) { status = w === "error" ? "error" : "done"; text = "K FINAL"; }
  else if (w === "ok") { status = "done"; textPending = true; }
  else if (w === "error") { status = "error"; textPending = true; }
  else if (c.conts) status = "unknown";
  else if (c.cached) { status = "running"; text = "streamed"; }
  else status = "unknown";
  return { status, text, textPending, interrupted: c.conts > 0, resumed };
}

const cases = [];
for (const cached of [true, false]) for (const wait of ["ok", "timeout", "error", "unavailable"]) for (const seg of ["within", "beyond", "unreachable"])
  for (const conts of [0, 1, 2]) for (const notice of [true, false]) for (const final of [true, false]) for (const later of [true, false])
    cases.push({ cached, wait, seg, conts, notice, final, later });

test(`run outcome matrix: ${cases.length} scenarios (cached × wait × segment × continuations × notice × final × later turn)`, async () => {
  assert.equal(cases.length, 576);
  const failures = [];
  for (const c of cases) {
    const link = fakeLink();
    const w = fakeWriteLink(link);
    const b = await bridge(link, w);
    try {
      if (c.cached) {
        const s = await b.call("POST", `/threads/${A}/send`, { message: "the question", clientMsgId: K });
        assert.equal(s.status, 202, JSON.stringify(s.json));
        w.emit("chat", { runId: K, sessionKey: KEY, seq: 1, state: "delta", deltaText: "streamed" });
      }
      link.all = rowsFor(c);
      link.unreachable = c.seg === "unreachable";
      if (c.wait === "unavailable") link.failWait = true; else link.wait = c.wait;
      const r = await b.call("GET", `/threads/${A}/runs/${K}`);
      const got = { status: r.json.status, text: r.json.text, textPending: r.json.textPending === true, interrupted: r.json.interrupted, resumed: r.json.resumed };
      const want = expected(c);
      try {
        assert.deepEqual(got, want);
        if (c.seg === "unreachable") assert.equal(r.json.located, false);
        assert.ok(!JSON.stringify(got).includes("LATER"), "a later turn is never attributed to K");
        assert.ok(!JSON.stringify(got).includes("Model Fallback") && !JSON.stringify(got).includes("Let me check"), "never a notice or a preamble as text");
      } catch (e) { failures.push(`${JSON.stringify(c)}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); }
    } finally { await b.close(); }
  }
  assert.equal(failures.length, 0, `${failures.length} of ${cases.length} scenarios differ:\n${failures.slice(0, 8).join("\n")}`);
});

test("run outcome: the live-event rows of the decision table (1-5) as a pure function", async () => {
  const { runOutcome } = await import("./app-bridge-threads.js");
  const mt = (m) => m.content[0].text;
  const final = { role: "assistant", content: [{ type: "text", text: "K FINAL" }], stopReason: "stop", __openclaw: { runId: K } };
  const found = { state: "found", rows: [final] };
  const settled = { status: "done", text: "from event", finalText: true };
  const pick = (o) => o.notFound ? "404" : [o.status, o.text, o.textPending];
  // 1 settled: the event wins, whatever the engine says or where the turn is
  for (const seg of [found, { state: "absent" }, { state: "unreachable" }]) for (const wait of ["ok", "error", "timeout", null]) {
    assert.deepEqual(pick(runOutcome({ live: settled, wait, seg, K, messageText: mt })), ["done", "from event", false]);
  }
  // 2 uncached + absent: not found
  assert.equal(pick(runOutcome({ live: null, wait: "ok", seg: { state: "absent" }, K, messageText: mt })), "404");
  // 3 unreachable: unknown; a live terminal (notice-only final) event keeps its status, text pending
  assert.deepEqual(pick(runOutcome({ live: { status: "running", text: "s", finalText: false }, wait: "ok", seg: { state: "unreachable" }, K, messageText: mt })), ["unknown", "", false]);
  assert.deepEqual(pick(runOutcome({ live: { status: "done", text: "", finalText: false }, wait: "timeout", seg: { state: "unreachable" }, K, messageText: mt })), ["done", "", true]);
  // 4/5 cached + absent (just sent): the engine's verdict, else the live stream
  assert.deepEqual(pick(runOutcome({ live: { status: "running", text: "s", finalText: false }, wait: "ok", seg: { state: "absent" }, K, messageText: mt })), ["done", "", true]);
  assert.deepEqual(pick(runOutcome({ live: { status: "running", text: "s", finalText: false }, wait: "error", seg: { state: "absent" }, K, messageText: mt })), ["error", "", true]);
  assert.deepEqual(pick(runOutcome({ live: { status: "running", text: "s", finalText: false }, wait: "timeout", seg: { state: "absent" }, K, messageText: mt })), ["running", "s", false]);
  // 6 with a live terminal event that is not settled: its status, the final row's text
  assert.deepEqual(pick(runOutcome({ live: { status: "stopped", text: "", finalText: false }, wait: "timeout", seg: found, K, messageText: mt })), ["stopped", "K FINAL", false]);
});
