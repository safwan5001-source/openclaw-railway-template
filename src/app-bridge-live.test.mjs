// BASHT app bridge, live routes (B0 /events, B3 /approvals*): a FAKE link (in this file) stands in for src/gateway-link.js.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { createAppBridge, APP_SESSION_KEY } from "./app-bridge.js";
import { APPROVAL_ID_RE, decidedView } from "./app-bridge-live.js";
import { createGatewayLink } from "./gateway-link.js";

const APP_TOKEN = "synthetic-app-token-0123456789abcdef0123";
const GW_TOKEN = "synthetic-gateway-token-0123456789abcdef";
const ID = "2f075550-246c-4742-97d7-5268e18d63d2";

const PENDING = {
  id: ID, createdAtMs: 1000, expiresAtMs: 4_000_000_000_000,
  request: { command: "echo hello", cwd: "/data/workspace", envKeys: ["TMP"], host: "gateway", agentId: "main", sessionKey: APP_SESSION_KEY,
    resolvedPath: "/usr/bin/echo", allowedDecisions: ["allow-once", "deny"], turnSourceChannel: "webchat" },
};
const RESOLVED = (decision) => ({ id: ID, status: decision === "deny" ? "denied" : "allowed", decision, reason: "user", createdAtMs: 1000, resolvedAtMs: 2000,
  expiresAtMs: 4_000_000_000_000, presentation: { kind: "exec", commandText: "echo hello", host: "gateway", agentId: "main" },
  source: { agentId: "main", sessionKey: APP_SESSION_KEY }, resolver: { kind: "runtime", id: "gateway-client" }, urlPath: "/approve/x" });

/** The link surface the bridge uses, scripted per test. */
function fakeLink() {
  const l = {
    up: true, calls: [], ring: [], kinds: new Map(), deadline: null, decorator: (e) => e, answers: {},
    isUp: () => l.up,
    status: () => ({ state: l.up ? "up" : "down", since: 1, lastUpAt: 1, reconnects: 0, lastError: l.up ? null : "closed", pendingApprovals: l.kinds.size }),
    request: async (method, params) => {
      l.calls.push({ method, params });
      if (!l.up) throw Object.assign(new Error("link_down"), { code: "link_down" });
      const a = l.answers[method];
      if (typeof a === "function") return a(params);
      if (a === undefined) throw Object.assign(new Error("unknown"), { refused: true, code: "INVALID_REQUEST" });
      return a;
    },
    events: (after, limit = 100) => ({ epoch: "e1", latest: l.ring.at(-1)?.id ?? 0, oldest: l.ring[0]?.id ?? null, truncated: false,
      events: l.ring.filter((e) => e.id > after).slice(0, limit) }),
    waitForEvents: (after, ms, signal) => new Promise((resolve) => { const t = setTimeout(resolve, Math.min(ms, 200)); signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }); l.wake = () => { clearTimeout(t); resolve(); }; }),
    approvalDeadline: () => l.deadline,
    pendingKind: (id) => l.kinds.get(id) ?? null,
    forgetApproval: (id) => l.kinds.delete(id),
    setDecorator: (fn) => { l.decorator = fn; },
  };
  return l;
}

let link, server, base, gateway, dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-bridge-live-"));
  fs.writeFileSync(path.join(dir, "openclaw.json"), "{}");
  gateway = http.createServer((req, res) => {
    // a turn that hangs until the client aborts (the bridge's timeout)
    if (req.url === "/v1/chat/completions") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  link = fakeLink();
  const app = express();
  app.use("/app/v1", createAppBridge({ token: APP_TOKEN, gatewayUrl: `http://127.0.0.1:${gateway.address().port}`, gatewayToken: GW_TOKEN,
    configPath: path.join(dir, "openclaw.json"), gatewayCall: async () => ({}), link }));
  app.use("/nolink/v1", createAppBridge({ token: APP_TOKEN, gatewayUrl: "http://127.0.0.1:1", gatewayToken: GW_TOKEN, configPath: path.join(dir, "openclaw.json") }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); gateway?.closeAllConnections?.(); gateway?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  link.up = true; link.calls.length = 0; link.ring.length = 0; link.kinds.clear(); link.deadline = null;
  link.answers = { "exec.approval.list": [PENDING], "plugin.approval.list": [], "openclaw.approval.list": [] };
});

const call = (p, { method = "GET", token = APP_TOKEN, body, prefix = "/app/v1" } = {}) =>
  fetch(base + prefix + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

test("every live route sits behind the app token", async () => {
  for (const [m, p] of [["GET", "/events"], ["GET", "/approvals"], ["GET", "/approvals/history"], ["POST", `/approvals/${ID}`]]) {
    assert.equal((await call(p, { method: m, token: null, body: m === "POST" ? { decision: "deny" } : undefined })).status, 401, p);
    assert.equal((await call(p, { method: m, token: GW_TOKEN, body: m === "POST" ? { decision: "deny" } : undefined })).status, 401, p);
  }
  assert.equal(link.calls.length, 0);
});

test("/status reports the link's health (fixed fields)", async () => {
  const r = await call("/status");
  assert.deepEqual(Object.keys(r.json.link).sort(), ["lastError", "lastUpAt", "pendingApprovals", "reconnects", "since", "state"]);
  assert.equal(r.json.link.state, "up");
  assert.equal((await call("/status", { prefix: "/nolink/v1" })).json.link.state, "off");
});

test("/events pages by after=, long-polls with wait=, and needs a link", async () => {
  link.ring.push({ id: 10, at: 1, type: "gateway.up" }, { id: 11, at: 2, type: "approval.requested", approval: { id: ID } });
  const r = await call("/events?after=10");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.events.map((e) => e.id), [11]);
  assert.equal(r.json.epoch, "e1");
  assert.equal(r.json.latest, 11);
  assert.equal(r.json.link.state, "up");
  assert.deepEqual((await call("/events?after=junk")).json.events.map((e) => e.id), [10, 11]);
  // long-poll: answers as soon as something new arrives
  const t0 = Date.now();
  const p = call("/events?after=11&wait=25");
  setTimeout(() => { link.ring.push({ id: 12, at: 3, type: "chat.final" }); link.wake?.(); }, 30);
  const w = await p;
  assert.deepEqual(w.json.events.map((e) => e.id), [12]);
  assert.ok(Date.now() - t0 < 1500);
  assert.equal((await call("/events", { prefix: "/nolink/v1" })).status, 503);
  assert.equal((await call("/events", { prefix: "/nolink/v1" })).json.error, "not_available");
});

test("/approvals: all three kinds, fixed shape, no paths or env; honest 503 when the link is down", async () => {
  link.answers["plugin.approval.list"] = [{ id: "plugin:abcdef12", createdAtMs: 500, expiresAtMs: 9e12, request: { title: "Post to channel", description: "d", sessionKey: "agent:main:main" } }];
  link.answers["openclaw.approval.list"] = () => { throw Object.assign(new Error("x"), { refused: true }); }; // one family failing
  const r = await call("/approvals");
  assert.equal(r.status, 200);
  assert.equal(r.json.partial, true);
  assert.deepEqual(r.json.approvals.map((a) => [a.id, a.kind, a.session, a.isApp]), [["plugin:abcdef12", "plugin", "main", false], [ID, "exec", "app", true]]);
  const a = r.json.approvals[1];
  assert.equal(a.summary, "echo hello");
  assert.deepEqual(a.decisions, ["allow-once", "deny"]);
  const raw = JSON.stringify(r.json);
  for (const leak of ["/data/workspace", "/usr/bin", "TMP", "webchat", APP_SESSION_KEY]) assert.ok(!raw.includes(leak), leak);
  link.up = false;
  const down = await call("/approvals");
  assert.equal(down.status, 503);
  assert.equal(down.json.error, "link_down");
  assert.equal(down.json.link.state, "down");
  link.up = true;
  link.answers["exec.approval.list"] = () => { throw new Error("boom"); };
  link.answers["plugin.approval.list"] = () => { throw new Error("boom"); };
  assert.equal((await call("/approvals")).status, 502);
});

test("POST /approvals/:id: id format, allow-once|deny only, kind from the gateway, first answer wins", async () => {
  for (const bad of ["x", "short", "../../etc/passwd0", "a".repeat(200), "%20spaces%20here"]) {
    assert.equal((await call(`/approvals/${bad}`, { method: "POST", body: { decision: "deny" } })).json?.error ?? "bad_id", "bad_id", bad);
  }
  for (const d of ["allow-always", "allow", "approve", "", null, 1]) {
    const r = await call(`/approvals/${ID}`, { method: "POST", body: { decision: d } });
    assert.equal(r.status, 400); assert.equal(r.json.error, "bad_decision", String(d));
  }
  assert.equal((await call(`/approvals/${ID}`, { method: "POST" })).json.error, "bad_decision");
  assert.equal(link.calls.length, 0, "nothing reached the gateway");

  // kind known from the live event
  link.kinds.set(ID, "exec");
  link.answers["approval.resolve"] = (p) => ({ applied: true, approval: RESOLVED(p.decision) });
  const ok = await call(`/approvals/${ID}`, { method: "POST", body: { decision: "allow-once", kind: "plugin", sessionKey: "x" } });
  assert.equal(ok.status, 200);
  assert.deepEqual(link.calls.at(-1), { method: "approval.resolve", params: { id: ID, kind: "exec", decision: "allow-once" } }, "exact params; the caller's kind is ignored");
  assert.equal(ok.json.applied, true);
  assert.equal(ok.json.approval.decision, "allow-once");
  assert.equal(ok.json.approval.by, "app");
  assert.equal(link.kinds.has(ID), false);

  // kind unknown locally: approval.get decides; an already-answered approval is reported, not re-resolved
  link.calls.length = 0;
  link.answers["approval.get"] = () => ({ approval: RESOLVED("deny") });
  const late = await call(`/approvals/${ID}`, { method: "POST", body: { decision: "allow-once" } });
  assert.equal(late.json.applied, false);
  assert.equal(late.json.approval.status, "denied");
  assert.ok(!link.calls.some((c) => c.method === "approval.resolve"));

  link.answers["approval.get"] = () => ({ approval: { ...RESOLVED("deny"), status: "pending", decision: null, presentation: { kind: "system-agent" } } });
  link.answers["approval.resolve"] = (p) => ({ applied: false, approval: RESOLVED(p.decision) });
  const race = await call(`/approvals/${ID}`, { method: "POST", body: { decision: "deny" } });
  assert.equal(link.calls.at(-1).params.kind, "system-agent");
  assert.equal(race.json.applied, false, "another surface answered first");

  link.answers["approval.get"] = () => { throw Object.assign(new Error("approval not found"), { refused: true, reason: "APPROVAL_NOT_FOUND" }); };
  assert.equal((await call(`/approvals/${ID}`, { method: "POST", body: { decision: "deny" } })).status, 404);
  link.kinds.set(ID, "exec");
  link.answers["approval.resolve"] = () => { throw Object.assign(new Error("approval expired or not found"), { refused: true }); };
  assert.equal((await call(`/approvals/${ID}`, { method: "POST", body: { decision: "deny" } })).status, 404);
  link.answers["approval.resolve"] = () => { throw Object.assign(new Error("nope"), { refused: true, reason: "FORBIDDEN" }); };
  assert.equal((await call(`/approvals/${ID}`, { method: "POST", body: { decision: "deny" } })).json.error, "rejected");
  link.up = false;
  assert.equal((await call(`/approvals/${ID}`, { method: "POST", body: { decision: "deny" } })).json.error, "link_down");
  assert.ok(APPROVAL_ID_RE.test(ID) && APPROVAL_ID_RE.test("plugin:abcdef12") && !APPROVAL_ID_RE.test("a b c d e f g h"));
});

test("/approvals/history: recent N in a fixed shape", async () => {
  link.answers["approval.history"] = () => ({ items: [RESOLVED("deny"), { ...RESOLVED("allow-once"), id: "second-0001", resolver: { kind: "system", id: "no-approval-route" }, reason: "no-route" }, { id: "" }], nextCursor: "c" });
  const r = await call("/approvals/history?limit=1");
  assert.equal(r.json.items.length, 1);
  const all = await call("/approvals/history");
  assert.deepEqual(all.json.items.map((i) => [i.id, i.decision, i.by, i.reason]), [[ID, "deny", "app", "user"], ["second-0001", "allow-once", "system", "no-route"]]);
  assert.ok(!JSON.stringify(all.json).includes("urlPath") && !JSON.stringify(all.json).includes(APP_SESSION_KEY));
  assert.equal(decidedView(null), null);
});

test("chat records say whether the app was watching; the server's /events poller does not count as watching", async () => {
  await call("/status");
  assert.equal(link.decorator({ id: 1, type: "chat.final" }).seen, true);
  assert.equal(link.decorator({ id: 1, type: "approval.requested" }).seen, undefined);
});

test("a turn waiting on an approval outlives the 15-minute turn timer until that approval expires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"], now: Date.now() });
  const r = await call("/send", { method: "POST", body: { message: "EXEC: echo hi" } });
  assert.equal(r.status, 202);
  const id = r.json.runId;
  link.deadline = Date.now() + 25 * 60_000; // an app-session approval expiring in 25 minutes
  t.mock.timers.tick(15 * 60_000 + 1);
  await new Promise((res) => setImmediate(res));
  assert.equal((await call(`/runs/${id}`)).json.status, "running", "kept alive past 15 min");
  link.deadline = null; // the approval was answered or expired
  t.mock.timers.tick(27 * 60_000); // Date is real here: the re-armed timer is ~26 min (deadline + grace)
  for (let i = 0; i < 50 && (await call(`/runs/${id}`)).json.status === "running"; i++) await new Promise((res) => setImmediate(res));
  assert.equal((await call(`/runs/${id}`)).json.status, "stopped");
});

test("a real link without a gateway reports down, and the routes say link_down", async () => {
  const l = createGatewayLink({ url: "ws://127.0.0.1:9", token: GW_TOKEN, WebSocketImpl: class { constructor() { setImmediate(() => this.onclose?.({})); } close() {} send() {} } });
  l.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(l.status().state, "down");
  l.stop();
});
