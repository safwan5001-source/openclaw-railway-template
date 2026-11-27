// BASHT app bridge: GET /status `runs` — the work that is running right now, across ALL sessions, as counts only.
// A FAKE link answers the two read-only counting reads; nothing here talks to a gateway.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { createAppBridge } from "./app-bridge.js";
import { RUNS_CACHE_MS, createRunsProbe, cronCount, engineCount } from "./app-bridge-runs.js";
import { CRON_RUNNING_PARAMS, LINK_METHODS, SESSIONS_ACTIVE_PARAMS } from "./gateway-link.js";

const APP_TOKEN = "synthetic-app-token-0123456789abcdef0123";
const GW_TOKEN = "synthetic-gateway-token-0123456789abcdef";
// identifiers that must never appear in a runs answer: a phone number, session keys, job ids, a path
const SECRETS = ["+966500000001", "agent:main:whatsapp:direct:+966500000001", "job-secret-id-1", "/data/workspace/private", "customer name"];

/** A link whose two counting reads answer from `answers`; every request is recorded. */
function fakeLink({ up = true, pending = 0, answers = {} } = {}) {
  const requests = [];
  const link = {
    up, pending, requests, answers,
    isUp() { return this.up; },
    status() { return { state: this.up ? "up" : "down", since: 0, lastUpAt: null, reconnects: 0, lastError: null, pendingApprovals: this.pending }; },
    serverVersion: () => null,
    setDecorator() {},
    request(method, params, opts) {
      requests.push({ method, params, opts });
      const a = this.answers[method];
      if (a instanceof Error) return Promise.reject(a);
      return Promise.resolve(typeof a === "function" ? a() : a);
    },
  };
  return link;
}
const sessionsAnswer = (n) => ({ ts: 1, path: "/data/state/x.sqlite", count: Math.min(n, 1), totalCount: n, hasMore: n > 1,
  sessions: n ? [{ key: "agent:main:whatsapp:direct:+966500000001", sessionId: "s1", label: "customer name", hasActiveRun: true, workspaceDir: "/data/workspace/private" }] : [] });
const cronAnswer = (running, extra = {}) => ({ hasMore: false, jobs: [
  ...Array.from({ length: running }, (_, i) => ({ id: `job-secret-id-${i + 1}`, name: "customer name", runningAtMs: 1000 + i })),
  { id: "idle", name: "idle", runningAtMs: undefined, nextRunAtMs: 5 }, { id: "legacy-shape", state: { runningAtMs: undefined } }], ...extra });

// ---------------------------------------------------------------- the parsers and the probe ------------------------------------------------

test("engineCount / cronCount: counts from the answers, null when the shape is not the one asked for", () => {
  assert.equal(engineCount(sessionsAnswer(3)), 3);
  assert.equal(engineCount(sessionsAnswer(0)), 0);
  for (const bad of [undefined, null, "x", [], {}, { totalCount: -1 }, { totalCount: 1.5 }, { totalCount: "2" }, { count: 2 }]) assert.equal(engineCount(bad), null, JSON.stringify(bad));
  assert.equal(cronCount(cronAnswer(2)), 2);
  assert.equal(cronCount(cronAnswer(0)), 0);
  assert.equal(cronCount({ jobs: [{ state: { runningAtMs: 5 } }, { runningAtMs: 6 }, { runningAtMs: null }, null, "x"] }), 2, "both the compact and the nested shape");
  for (const bad of [undefined, null, {}, { jobs: "x" }, cronAnswer(1, { hasMore: true })]) assert.equal(cronCount(bad), null, "more than one page, or not a list: unknown, never a guess");
});

test("probe: every source answered — counts add up, complete is true, nothing identifying is in the answer", async () => {
  const link = fakeLink({ pending: 2, answers: { "sessions.list": sessionsAnswer(3), "cron.list": cronAnswer(1) } });
  const probe = createRunsProbe({ link });
  const r = await probe.read(1);
  assert.deepEqual(r, { active: 1, engine: 3, cron: 1, approvalsPending: 2, total: 5, complete: true });
  const blob = JSON.stringify(r);
  for (const s of SECRETS) assert.ok(!blob.includes(s), s);
  assert.deepEqual(Object.keys(r), ["active", "engine", "cron", "approvalsPending", "total", "complete"]);
  // exactly the two read-only reads, with their fixed params and a bounded timeout
  assert.deepEqual(link.requests.map((q) => [q.method, q.params]), [["sessions.list", SESSIONS_ACTIVE_PARAMS], ["cron.list", CRON_RUNNING_PARAMS]]);
  assert.ok(link.requests.every((q) => q.opts.timeoutMs <= 5000));
  assert.ok(LINK_METHODS.has("sessions.list") && LINK_METHODS.has("cron.list"));
});

test("probe: idle everywhere is total 0 and complete; approvals are reported but are not part of total", async () => {
  const link = fakeLink({ pending: 0, answers: { "sessions.list": sessionsAnswer(0), "cron.list": cronAnswer(0) } });
  assert.deepEqual(await createRunsProbe({ link }).read(0), { active: 0, engine: 0, cron: 0, approvalsPending: 0, total: 0, complete: true });
  const withApproval = fakeLink({ pending: 1, answers: { "sessions.list": sessionsAnswer(0), "cron.list": cronAnswer(0) } });
  const r = await createRunsProbe({ link: withApproval }).read(0);
  assert.deepEqual([r.total, r.approvalsPending, r.complete], [0, 1, true]);
});

test("probe: one source unavailable => null and complete:false (never a guess); the known parts still add up", async () => {
  for (const [answers, want] of [
    [{ "sessions.list": new Error("boom"), "cron.list": cronAnswer(2) }, { engine: null, cron: 2, total: 3, complete: false }],
    [{ "sessions.list": sessionsAnswer(4), "cron.list": Object.assign(new Error("timeout"), { code: "timeout" }) }, { engine: 4, cron: null, total: 5, complete: false }],
    [{ "sessions.list": { nonsense: true }, "cron.list": cronAnswer(0) }, { engine: null, cron: 0, total: 1, complete: false }],
    [{ "sessions.list": sessionsAnswer(0), "cron.list": cronAnswer(5, { hasMore: true }) }, { engine: 0, cron: null, total: 1, complete: false }],
    [{ "sessions.list": Object.assign(new Error("x"), { code: "INVALID_REQUEST", refused: true }), "cron.list": Object.assign(new Error("y"), { code: "bad_params" }) }, { engine: null, cron: null, total: 1, complete: false }],
  ]) {
    const r = await createRunsProbe({ link: fakeLink({ answers }) }).read(1);
    assert.deepEqual({ engine: r.engine, cron: r.cron, total: r.total, complete: r.complete }, want, JSON.stringify(want));
    assert.equal(r.active, 1);
  }
});

test("probe: no link, or a link that is down => engine, cron and approvals are null, complete:false, and no request is made", async () => {
  for (const link of [undefined, null, fakeLink({ up: false, pending: 3, answers: { "sessions.list": sessionsAnswer(1), "cron.list": cronAnswer(1) } })]) {
    const r = await createRunsProbe({ link }).read(2);
    assert.deepEqual(r, { active: 2, engine: null, cron: null, approvalsPending: null, total: 2, complete: false });
    if (link) assert.equal(link.requests.length, 0);
  }
});

test("probe: reads are cached for at most 3 s and shared by concurrent callers; the app's own count and the approvals are always fresh", async () => {
  assert.ok(RUNS_CACHE_MS <= 3000);
  let t = 1_000_000;
  let n = 1;
  const link = fakeLink({ pending: 0, answers: { "sessions.list": () => sessionsAnswer(n), "cron.list": () => cronAnswer(0) } });
  const probe = createRunsProbe({ link, now: () => t });
  const [a, b] = await Promise.all([probe.read(0), probe.read(0)]);
  assert.deepEqual([a.engine, b.engine], [1, 1]);
  assert.equal(link.requests.length, 2, "two concurrent callers, one pair of reads");
  n = 7; link.pending = 4;
  t += 2_999;
  const c = await probe.read(5);
  assert.deepEqual([c.engine, c.active, c.approvalsPending], [1, 5, 4], "cached engine count, fresh app count and approvals");
  assert.equal(link.requests.length, 2);
  t += 2;
  assert.equal((await probe.read(0)).engine, 7, "after 3 s the next read asks again");
  assert.equal(link.requests.length, 4);
  // a failure is cached for the same short time too (a wedged gateway is not hammered)
  link.answers["sessions.list"] = new Error("down");
  t += 3_001;
  assert.equal((await probe.read(0)).engine, null);
  link.answers["sessions.list"] = () => sessionsAnswer(2);
  assert.equal((await probe.read(0)).engine, null);
  t += 3_001;
  assert.equal((await probe.read(0)).engine, 2);
});

// ---------------------------------------------------------------- GET /app/v1/status over HTTP ------------------------------------------

let dir, configPath;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-bridge-runs-"));
  configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, "{}");
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

async function mount(link, extra = {}) {
  const app = express();
  app.use("/app/v1", createAppBridge({ token: APP_TOKEN, gatewayUrl: "http://127.0.0.1:9", gatewayToken: GW_TOKEN, configPath, link, ...extra }));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const b = `http://127.0.0.1:${srv.address().port}/app/v1`;
  return { b, status: () => fetch(`${b}/status`, { headers: { authorization: `Bearer ${APP_TOKEN}` } }).then((r) => r.json()), close: () => srv.close() };
}

test("status.runs over HTTP: all sources ok, one unavailable, link down — and no identifier anywhere in the response", async () => {
  const full = fakeLink({ pending: 1, answers: { "sessions.list": sessionsAnswer(2), "cron.list": cronAnswer(1) } });
  const m1 = await mount(full);
  try {
    const j = await m1.status();
    assert.deepEqual(j.runs, { active: 0, engine: 2, cron: 1, approvalsPending: 1, total: 3, complete: true });
    for (const s of SECRETS) assert.ok(!JSON.stringify(j).includes(s), s);
  } finally { m1.close(); }
  const partial = fakeLink({ answers: { "sessions.list": new Error("x"), "cron.list": cronAnswer(0) } });
  const m2 = await mount(partial);
  try {
    const j = await m2.status();
    assert.deepEqual(j.runs, { active: 0, engine: null, cron: 0, approvalsPending: 0, total: 0, complete: false });
  } finally { m2.close(); }
  const down = await mount(fakeLink({ up: false }));
  try {
    assert.deepEqual((await down.status()).runs, { active: 0, engine: null, cron: null, approvalsPending: null, total: 0, complete: false });
  } finally { down.close(); }
  const none = await mount(undefined);
  try {
    assert.deepEqual((await none.status()).runs, { active: 0, engine: null, cron: null, approvalsPending: null, total: 0, complete: false });
  } finally { none.close(); }
});

test("status.runs: the bridge's own running turn counts in `active` and in `total`; polling status is a burst-safe read (cached)", async () => {
  const enc = new TextEncoder();
  let finish;
  const fetchImpl = async (_u, init) => new Response(new ReadableStream({
    start(c) {
      init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")), { once: true });
      c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "x" } }] })}\n\n`));
      finish = () => { try { c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } catch { /* ended */ } };
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const link = fakeLink({ answers: { "sessions.list": sessionsAnswer(0), "cron.list": cronAnswer(0) } });
  const m = await mount(link, { fetchImpl });
  try {
    assert.equal((await m.status()).runs.total, 0);
    const sent = await fetch(`${m.b}/send`, { method: "POST", headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ message: "x" }) });
    assert.equal(sent.status, 202);
    for (let i = 0; i < 100 && !finish; i++) await new Promise((r) => setTimeout(r, 10));
    const j = await m.status();
    assert.deepEqual([j.runs.active, j.runs.total, j.runs.complete], [1, 1, true]);
    await Promise.all([m.status(), m.status(), m.status()]);
    assert.equal(link.requests.length, 2, "five status polls inside 3 s made one pair of reads");
  } finally { m.close(); finish?.(); }
});

test("the release rule in the docs matches the fields (complete, total, approvalsPending) and says what runs does not cover", () => {
  const docs = fs.readFileSync(new URL("../docs/BASHT_APP_BRIDGE.md", import.meta.url), "utf8");
  const rule = docs.slice(docs.indexOf("## Release rule"), docs.indexOf("## Enable and roll back"));
  assert.match(rule, /runs\.complete === true/);
  assert.match(rule, /runs\.total === 0/);
  assert.match(rule, /runs\.approvalsPending === 0/);
  assert.match(rule, /immediately before the restart/);
  assert.match(rule, /complete: false/);
  assert.match(docs, /\*\*`runs` does not cover:\*\*/);
  assert.match(docs, /right after the check/);
});
