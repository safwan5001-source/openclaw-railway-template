// BASHT gateway link (B0): handshake, scopes, event ring, approvals tracking, reconnection. A FAKE WebSocket (in this file)
// stands in for the OpenClaw gateway; shapes are the ones the real 2026.11.10 gateway sent in the lab (docs/BASHT_APP_BRIDGE.md).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { APP_SESSION_KEY, LINK_CAPS, LINK_METHODS, LINK_SCOPES, TTS_SPEAK_MAX_CHARS, approvalView, createGatewayLink, normalizeEvent, sessionKind } from "./gateway-link.js";

const TOKEN = "synthetic-gateway-token-0123456789abcdef";
// The link's own timers are unref'd by design (they must never keep the wrapper alive), so a test awaiting one of them needs
// something else holding the event loop open — otherwise it passes or is cancelled depending on what ran before it.
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));
const tick = () => new Promise((r) => setImmediate(r));
const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };

/** A scripted gateway: answers connect (hello-ok with `scopes`), list methods from `lists`, and records every frame. */
function fakeGateway({ scopes = [...LINK_SCOPES], lists = {}, tickIntervalMs = 15000, onReq, server } = {}) {
  const sockets = [];
  class FakeWS {
    constructor(url) {
      this.url = url; this.sent = []; this.closed = false;
      sockets.push(this);
      setImmediate(() => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n", ts: 1 } }));
    }
    emit(frame) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(frame) }); }
    send(raw) {
      if (this.closed) throw new Error("closed");
      const f = JSON.parse(raw);
      this.sent.push(f);
      const reply = (ok, payload, error) => setImmediate(() => this.emit({ type: "res", id: f.id, ok, payload, error }));
      if (f.method === "connect") return reply(true, { type: "hello-ok", protocol: 4, ...(server ? { server } : {}), auth: { role: "operator", scopes }, policy: { tickIntervalMs } });
      if (onReq) { const r = onReq(f, reply); if (r !== undefined) return; }
      if (f.method in lists) return reply(true, lists[f.method]);
      reply(false, undefined, { code: "INVALID_REQUEST", message: "unknown" });
    }
    close() { if (this.closed) return; this.closed = true; setImmediate(() => this.onclose?.({ code: 1000 })); }
    event(name, payload) { this.emit({ type: "event", event: name, payload, seq: 1 }); }
  }
  return { FakeWS, sockets, last: () => sockets.at(-1) };
}

const execRequested = (id, sessionKey = APP_SESSION_KEY, extra = {}) => ({
  id, approvalKind: "exec", createdAtMs: 1000, expiresAtMs: Date.now() + 60_000,
  request: { command: "echo hi\n&& rm -rf /tmp/x", cwd: "/data/workspace", envKeys: ["SECRET_ENV"], host: "gateway", agentId: "main",
    sessionKey, resolvedPath: "/usr/bin/echo", allowedDecisions: ["allow-once", "allow-always", "deny"], ...extra },
});

test("connects as the loopback backend client with the shared token, the exact scopes and the approvals cap", async () => {
  const gw = fakeGateway();
  const link = createGatewayLink({ url: "ws://127.0.0.1:1", token: TOKEN, WebSocketImpl: gw.FakeWS });
  link.start();
  await until(() => link.isUp());
  const c = gw.last().sent.find((f) => f.method === "connect").params;
  assert.deepEqual(c.client, { id: "gateway-client", version: "basht-bridge/1", platform: process.platform, mode: "backend" });
  assert.equal(c.role, "operator");
  assert.deepEqual(c.scopes, [...LINK_SCOPES]);
  assert.deepEqual(c.caps, [...LINK_CAPS]);
  assert.deepEqual(c.auth, { token: TOKEN });
  assert.equal(c.device, undefined, "no device identity: no pairing record");
  assert.equal(c.minProtocol, 4);
  const s = link.status();
  assert.equal(s.state, "up");
  assert.equal(s.lastError, null);
  assert.deepEqual(link.events(0).events.map((e) => e.type), ["gateway.up"]);
  link.stop();
  assert.equal(link.status().state, "off");
});

test("a gateway that grants fewer scopes (e.g. pairing required) is never used half-authorized", async () => {
  const gw = fakeGateway({ scopes: ["operator.read"] });
  const link = createGatewayLink({ url: "ws://x", token: TOKEN, WebSocketImpl: gw.FakeWS });
  link.start();
  await until(() => link.status().lastError === "scopes_not_granted");
  assert.equal(link.isUp(), false);
  await assert.rejects(link.request("models.list", {}), { code: "link_down" });
  link.stop();
});

test("request() refuses methods outside the allowlist, before anything is sent", async () => {
  const gw = fakeGateway({ lists: { "models.list": { models: [] } } });
  const link = createGatewayLink({ url: "ws://x", token: TOKEN, WebSocketImpl: gw.FakeWS });
  await assert.rejects(link.request("models.list", {}), { code: "link_down" }, "not started");
  link.start();
  await until(() => link.isUp());
  for (const m of ["config.patch", "chat.send", "sessions.patch", "exec.approvals.set", "cron.run", "approval.resolve "]) {
    await assert.rejects(link.request(m, {}), { code: "not_allowed" }, m);
  }
  assert.ok(!gw.last().sent.some((f) => f.method === "config.patch"));
  assert.deepEqual(await link.request("models.list", { view: "default" }), { models: [] });
  for (const m of ["approval.resolve", "approval.history", "exec.approval.list", "models.list", "sessions.describe"]) assert.ok(LINK_METHODS.has(m));
  // a gateway refusal is an answer (refused), with its code and reason
  await assert.rejects(link.request("approval.get", { id: "x" }), (e) => e.refused === true && e.code === "INVALID_REQUEST");
  link.stop();
});

test("events are normalized to fixed fields; raw commands, paths, env and other sessions' chats never enter the ring", () => {
  const r = normalizeEvent("exec.approval.requested", execRequested("a1"));
  assert.equal(r.type, "approval.requested");
  assert.deepEqual(Object.keys(r.approval).sort(), ["agentId", "createdAt", "decisions", "expiresAt", "host", "id", "isApp", "kind", "session", "summary", "title", "warning"]);
  assert.equal(r.approval.summary, "echo hi && rm -rf /tmp/x", "control characters folded");
  assert.deepEqual(r.approval.decisions, ["allow-once", "deny"], "allow-always is never offered");
  assert.equal(r.approval.isApp, true);
  assert.ok(!JSON.stringify(r).includes("/data/workspace") && !JSON.stringify(r).includes("SECRET_ENV") && !JSON.stringify(r).includes("/usr/bin"));
  const long = normalizeEvent("exec.approval.requested", execRequested("a2", APP_SESSION_KEY, { command: "x".repeat(1000) }));
  assert.equal(long.approval.summary.length, 300);
  const wa = normalizeEvent("plugin.approval.requested", { id: "p1", request: { title: "Send email", sessionKey: "agent:main:whatsapp:direct:+966500000001" } });
  assert.equal(wa.approval.kind, "plugin");
  assert.equal(wa.approval.summary, "Send email");
  assert.equal(wa.approval.session, "whatsapp");
  assert.ok(!JSON.stringify(wa).includes("+9665"), "no phone numbers");
  assert.equal(normalizeEvent("openclaw.approval.requested", { id: "s1", request: {} }).approval.kind, "system-agent");
  assert.deepEqual(normalizeEvent("exec.approval.resolved", { id: "a1", decision: "deny", request: { sessionKey: APP_SESSION_KEY } }),
    { type: "approval.resolved", approvalId: "a1", kind: "exec", decision: "deny", session: "app" });
  assert.deepEqual(normalizeEvent("chat", { sessionKey: APP_SESSION_KEY, state: "final", runId: "r1", message: { content: "secret" } }),
    { type: "chat.final", session: "app", runId: "r1" });
  assert.equal(normalizeEvent("chat", { sessionKey: APP_SESSION_KEY, state: "error", runId: "r1" }).type, "chat.error");
  assert.equal(normalizeEvent("chat", { sessionKey: APP_SESSION_KEY, state: "delta", runId: "r1" }), null);
  assert.equal(normalizeEvent("chat", { sessionKey: "agent:main:whatsapp:direct:+1", state: "final" }), null, "only the app session");
  assert.deepEqual(normalizeEvent("cron", { action: "finished", jobId: "j1", status: "error", error: "boom /data/x", job: { id: "j1", name: "Daily" } }),
    { type: "cron.failed", jobId: "j1", name: "Daily", status: "error" });
  assert.equal(normalizeEvent("cron", { action: "finished", jobId: "j1", status: "ok", job: { name: "Daily" } }).type, "cron.finished");
  assert.equal(normalizeEvent("cron", { action: "finished", jobId: "j1", job: { name: "D", state: { lastRunStatus: "error" } } }).type, "cron.failed");
  assert.equal(normalizeEvent("cron", { action: "started", jobId: "j1" }), null);
  for (const n of ["agent", "tick", "health", "presence", "sessions.changed"]) assert.equal(normalizeEvent(n, { sessionKey: APP_SESSION_KEY }), null);
  assert.equal(approvalView({ id: "" }, "exec"), null);
  assert.equal(approvalView({ id: "abcdefgh" }, "weird"), null);
  assert.equal(sessionKind("agent:main:cron:abc"), "cron");
});

test("the ring is bounded, ids only grow, and after= pages with a truncation flag", async () => {
  const gw = fakeGateway();
  const link = createGatewayLink({ url: "ws://x", token: TOKEN, WebSocketImpl: gw.FakeWS, ringSize: 5 });
  link.start();
  await until(() => link.isUp());
  const ws = gw.last();
  for (let i = 0; i < 8; i++) ws.event("chat", { sessionKey: APP_SESSION_KEY, state: "final", runId: `r${i}` });
  ws.event("agent", { stream: "lifecycle" }); // ignored
  await tick();
  const all = link.events(0);
  assert.equal(all.events.length, 5);
  assert.deepEqual(all.events.map((e) => e.runId), ["r3", "r4", "r5", "r6", "r7"]);
  const ids = all.events.map((e) => e.id);
  assert.ok(ids.every((id, i) => i === 0 || id === ids[i - 1] + 1), "monotonic, consecutive");
  assert.equal(all.latest, ids.at(-1));
  assert.equal(all.truncated, false, "after=0 is a fresh read, not a gap");
  const page = link.events(ids[1]);
  assert.deepEqual(page.events.map((e) => e.runId), ["r5", "r6", "r7"]);
  assert.equal(page.truncated, false);
  assert.equal(link.events(ids[0] - 3).truncated, true, "records after the cursor already left the ring");
  assert.deepEqual(link.events(ids.at(-1)).events, []);
  assert.equal(link.events(0, 2).events.length, 2, "limit");
  assert.match(all.epoch, /^[0-9a-f]{12}$/);
  assert.ok(ids[0] > 1_700_000_000_000, "seeded with the boot time, so ids keep growing across restarts");
  link.stop();
});

test("approvals: tracked from events, deduplicated, resynced after a reconnect, and give the app turn its deadline", async () => {
  const pendingOnGateway = [];
  const gw = fakeGateway({ lists: { "exec.approval.list": pendingOnGateway, "plugin.approval.list": [], "openclaw.approval.list": [] } });
  const link = createGatewayLink({ url: "ws://x", token: TOKEN, WebSocketImpl: gw.FakeWS });
  link.start();
  await until(() => link.isUp());
  const a1 = execRequested("appr-0001");
  gw.last().event("exec.approval.requested", a1);
  gw.last().event("exec.approval.requested", a1); // the gateway may repeat it; one record only
  gw.last().event("exec.approval.requested", execRequested("appr-0002", "agent:main:whatsapp:direct:+1"));
  await tick();
  assert.equal(link.events(0).events.filter((e) => e.type === "approval.requested").length, 2);
  assert.equal(link.pendingKind("appr-0001"), "exec");
  assert.equal(link.approvalDeadline(APP_SESSION_KEY), a1.expiresAtMs);
  assert.equal(link.status().pendingApprovals, 2);

  gw.last().event("exec.approval.resolved", { id: "appr-0001", decision: "allow-once", request: { sessionKey: APP_SESSION_KEY } });
  await tick();
  assert.equal(link.pendingKind("appr-0001"), null);
  assert.equal(link.approvalDeadline(APP_SESSION_KEY), null);

  // the gateway restarts; while the link is down a new approval appears: after reconnecting it is read from the lists
  const before = link.events(0).latest;
  gw.last().close();
  await until(() => link.status().state === "down");
  assert.ok(link.events(before).events.some((e) => e.type === "gateway.down"));
  pendingOnGateway.push(execRequested("appr-0003"), execRequested("appr-0002", "agent:main:whatsapp:direct:+1"));
  link.kick();
  await until(() => link.isUp() && link.pendingKind("appr-0003") === "exec");
  const after = link.events(before).events.map((e) => e.type);
  assert.deepEqual(after, ["gateway.down", "gateway.up", "approval.requested"], "appr-0002 was already announced; appr-0003 is new");
  assert.equal(typeof link.events(before).events[1].downForMs, "number");
  assert.equal(link.status().reconnects, 1);
  // a pending approval that is gone from the gateway's lists is forgotten
  pendingOnGateway.length = 0;
  gw.last().close();
  await until(() => link.status().state === "down");
  link.kick();
  await until(() => link.isUp());
  await until(() => link.status().pendingApprovals === 0);
  link.stop();
});

test("resync never forgets an approval that arrived as a live event while the lists were being read", async () => {
  let releasePlugin;
  const gw = fakeGateway({
    lists: { "exec.approval.list": [], "openclaw.approval.list": [] },
    onReq: (f, reply) => { if (f.method === "plugin.approval.list") { releasePlugin = () => reply(true, []); return true; } },
  });
  const link = createGatewayLink({ url: "ws://x", token: TOKEN, WebSocketImpl: gw.FakeWS });
  link.start();
  await until(() => link.isUp() && typeof releasePlugin === "function");
  const live = execRequested("appr-live-1");
  gw.last().event("exec.approval.requested", live); // exec.approval.list has already answered (empty)
  await tick();
  releasePlugin();
  await tick(); await tick();
  assert.equal(link.pendingKind("appr-live-1"), "exec", "still pending after the resync finished");
  assert.equal(link.approvalDeadline(APP_SESSION_KEY), live.expiresAtMs);
  link.stop();
});

test("requests in flight fail fast with link_down when the socket drops; a stale socket (no tick) is replaced", async () => {
  const gw = fakeGateway({ tickIntervalMs: 20, onReq: (f) => (f.method === "approval.history" ? null : undefined) }); // history never answers
  const link = createGatewayLink({ url: "ws://x", token: TOKEN, WebSocketImpl: gw.FakeWS });
  link.start();
  await until(() => link.isUp());
  const first = gw.last();
  const p = link.request("approval.history", {});
  // no frames for 2.5 ticks: the watchdog drops the socket and the pending request with it
  await assert.rejects(p, { code: "link_down" });
  assert.equal(first.closed, true);
  await until(() => link.status().state === "down");
  assert.equal(link.status().lastError, "stale");
  link.stop();
});

test("waitForEvents resolves on a new record, on timeout, and on abort", async () => {
  const gw = fakeGateway();
  const link = createGatewayLink({ url: "ws://x", token: TOKEN, WebSocketImpl: gw.FakeWS });
  link.start();
  await until(() => link.isUp());
  const latest = link.events(0).latest;
  const t0 = Date.now();
  const w = link.waitForEvents(latest, 5000);
  setTimeout(() => gw.last().event("cron", { action: "finished", jobId: "j", status: "error", job: { name: "n" } }), 20);
  await w;
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(link.events(latest).events[0].type, "cron.failed");
  const t1 = Date.now();
  await link.waitForEvents(link.events(0).latest, 30);
  assert.ok(Date.now() - t1 >= 25);
  const ctl = new AbortController();
  const w2 = link.waitForEvents(link.events(0).latest, 5000, ctl.signal);
  ctl.abort();
  await w2;
  link.stop();
});

test("decorator adds bridge-only facts to records", async () => {
  const gw = fakeGateway();
  const link = createGatewayLink({ url: "ws://x", token: TOKEN, WebSocketImpl: gw.FakeWS });
  link.setDecorator((e) => (e.type === "chat.final" ? { ...e, seen: false } : e));
  link.start();
  await until(() => link.isUp());
  gw.last().event("chat", { sessionKey: APP_SESSION_KEY, state: "final", runId: "r" });
  await tick();
  assert.equal(link.events(0).events.at(-1).seen, false);
  link.stop();
});

// ---------------------------------------------------------------- tts.speak on the link ----------------------------------------------

test("the allowlist is exactly the reads, the approval write and tts.speak: everything else stays refused", async () => {
  assert.deepEqual([...LINK_METHODS].sort(), ["approval.get", "approval.history", "approval.resolve", "exec.approval.list", "models.list",
    "openclaw.approval.list", "plugin.approval.list", "sessions.describe", "tts.speak"]);
  const gw = fakeGateway({ lists: { "tts.speak": { audioBase64: "AA==", mimeType: "audio/mpeg" } } });
  const link = createGatewayLink({ url: "ws://x", token: TOKEN, WebSocketImpl: gw.FakeWS });
  link.start();
  await until(() => link.isUp());
  const before = gw.last().sent.length;
  for (const m of ["chat.send", "tts.convert", "tts.status", "tts.setProvider", "tts.enable", "config.get", "config.set", "TTS.speak", "tts.speak ", " tts.speak", "tts", "tts.speak.stream", "talk.speak", "sessions.send", ""]) {
    await assert.rejects(link.request(m, { text: "x" }), { code: "not_allowed" }, JSON.stringify(m));
  }
  assert.equal(gw.last().sent.length, before, "nothing refused locally reached the gateway");
  link.stop();
});

test("tts.speak: params are closed to {text: 1..1500 chars}; anything else is refused locally with bad_params", async () => {
  const gw = fakeGateway({ lists: { "tts.speak": { audioBase64: "AA==", mimeType: "audio/mpeg" } } });
  const link = createGatewayLink({ url: "ws://x", token: TOKEN, WebSocketImpl: gw.FakeWS });
  // a bad shape is bad_params even before the link is up; a good one then needs the link
  await assert.rejects(link.request("tts.speak", { text: "" }), { code: "bad_params" });
  await assert.rejects(link.request("tts.speak", { text: "مرحبا" }), { code: "link_down" });
  link.start();
  await until(() => link.isUp());
  const sentBefore = gw.last().sent.length;
  const bad = [undefined, null, "مرحبا", ["x"], 5, {}, { text: "" }, { text: 5 }, { text: null }, { text: ["x"] }, { text: "ا".repeat(TTS_SPEAK_MAX_CHARS + 1) },
    { text: "x", voice: "alloy" }, { text: "x", provider: "elevenlabs" }, { text: "x", model: "m" }, { text: "x", sessionKey: APP_SESSION_KEY }, { text: "x", agentId: "main" },
    { text: "x", instructions: "speak fast" }, { text: "x", channel: "whatsapp" }, { Text: "x" }, { txt: "x" }, Object.assign(Object.create({ text: "x" }), {}),
    Object.assign(Object.create(null), { text: "x" })];
  for (const p of bad) await assert.rejects(link.request("tts.speak", p), { code: "bad_params" }, JSON.stringify(p)?.slice(0, 40));
  assert.equal(gw.last().sent.length, sentBefore, "nothing reached the gateway");
  assert.equal(TTS_SPEAK_MAX_CHARS, 1500);
  const ok = await link.request("tts.speak", { text: "ا".repeat(1500) });
  assert.equal(ok.mimeType, "audio/mpeg");
  const frame = gw.last().sent.at(-1);
  assert.equal(frame.method, "tts.speak");
  assert.deepEqual(frame.params, { text: "ا".repeat(1500) }, "{text} and nothing else goes out");
  link.stop();
});

test("request() honours the timeout it is given (tts.speak: 60 s), caps it, and never retries on its own", async () => {
  const delays = [];
  const timers = [];
  const setTimer = (fn, ms) => { delays.push(ms); const t = setTimeout(fn, ms); timers.push({ fn, ms, t }); return t; };
  const gw = fakeGateway({ onReq: (f) => (f.method === "tts.speak" ? true : undefined) }); // the gateway never answers tts.speak
  const link = createGatewayLink({ url: "ws://x", token: TOKEN, WebSocketImpl: gw.FakeWS, setTimer });
  link.start();
  await until(() => link.isUp());
  const mark = delays.length;
  const p = link.request("tts.speak", { text: "x" }, { timeoutMs: 60_000 });
  const timer = timers.slice(mark).find((t) => t.ms === 60_000);
  assert.ok(timer, `a 60 s timer was armed (${delays.slice(mark)})`);
  timer.fn(); // the 60 s pass
  await assert.rejects(p, { code: "timeout" });
  assert.equal(gw.last().sent.filter((f) => f.method === "tts.speak").length, 1, "one request, no retry");
  // default and cap
  const m2 = delays.length;
  const q1 = link.request("tts.speak", { text: "x" }); q1.catch(() => {});
  const q2 = link.request("tts.speak", { text: "x" }, { timeoutMs: 10 * 60_000 }); q2.catch(() => {});
  const q3 = link.request("tts.speak", { text: "x" }, { timeoutMs: -5 }); q3.catch(() => {});
  assert.deepEqual(delays.slice(m2).filter((d) => d >= 15_000 && d <= 120_000), [15_000, 120_000, 15_000]);
  link.stop();
  await Promise.allSettled([q1, q2, q3]);
});

test("tts.speak: a gateway refusal is an answer (refused, with its code); a drop mid-request is link_down", async () => {
  const gw = fakeGateway({ onReq: (f, reply) => (f.method === "tts.speak" ? (reply(false, undefined, { code: "UNAVAILABLE", message: "provider failed" }), true) : undefined) });
  const link = createGatewayLink({ url: "ws://x", token: TOKEN, WebSocketImpl: gw.FakeWS });
  link.start();
  await until(() => link.isUp());
  await assert.rejects(link.request("tts.speak", { text: "x" }), (e) => e.refused === true && e.code === "UNAVAILABLE");
  link.stop();
  const gw2 = fakeGateway({ onReq: (f) => (f.method === "tts.speak" ? true : undefined) });
  const link2 = createGatewayLink({ url: "ws://x", token: TOKEN, WebSocketImpl: gw2.FakeWS });
  link2.start();
  await until(() => link2.isUp());
  const p = link2.request("tts.speak", { text: "x" });
  await tick();
  gw2.last().close();
  await assert.rejects(p, { code: "link_down" });
  link2.stop();
});

test("the engine version is the hello-ok server.version (label shape only), else null", async () => {
  const withVersion = fakeGateway({ server: { version: "2026.11.10", connId: "c1" } });
  const a = createGatewayLink({ url: "ws://x", token: TOKEN, WebSocketImpl: withVersion.FakeWS });
  assert.equal(a.serverVersion(), null, "unknown before the link was ever up");
  a.start(); await until(() => a.isUp());
  assert.equal(a.serverVersion(), "2026.11.10");
  assert.ok(!JSON.stringify(a.status()).includes("connId"));
  a.stop();
  for (const server of [undefined, { version: "x".repeat(60) }, { version: "<script>" }, { version: 5 }, { version: "a b" }]) {
    const gw = fakeGateway({ server });
    const l = createGatewayLink({ url: "ws://x", token: TOKEN, WebSocketImpl: gw.FakeWS });
    l.start(); await until(() => l.isUp());
    assert.equal(l.serverVersion(), null, JSON.stringify(server)?.slice(0, 30));
    l.stop();
  }
});
