// BASHT app control (B5–B7): fixed shapes, no paths/secrets, param validation for the two cron writes, caching, concurrency.
// A FAKE gatewayCall (in this file) stands in for `openclaw gateway call`; shapes follow what OpenClaw 2026.11.10 returned in the lab.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { APP_SESSION_KEY, createAppBridge } from "./app-bridge.js";
import { CONTROL_READ_RPC, CONTROL_WRITE_RPC, baseName, cleanText, mapHit, mapSchedule, textPart, validateControlRpc } from "./app-control.js";

const APP_TOKEN = "synthetic-app-token-0123456789abcdef0123";
const SECRET_PATH = "/data/.openclaw/state/openclaw.sqlite";
const J_OWNER = "e1e667e6-3167-4e9e-82e6-eeeda67c9afc";
const J_SYSTEM = "7dc4eee1-6213-40ab-870d-4c1ca2119cb4";
const J_OFF = "31226c93-f76d-4d99-a627-1d0328ab1936";
const J_CMD = "cmd-job-1";

let rpc = [];
let clockOffset = 0;
let delayMs = 0;
let inFlight = 0, maxInFlight = 0;
let failing = new Set(); // methods that throw like an unreachable gateway
let refusing = new Set(); // methods the gateway answers with an error
let jobs;

const freshJobs = () => [
  { id: J_OWNER, name: "متابعة الفواتير", enabled: true, createdAtMs: 1, updatedAtMs: 2, schedule: { kind: "every", everyMs: 21600000, anchorMs: 5 },
    sessionTarget: "isolated", wakeMode: "now", payload: { kind: "agentTurn", message: "راجع الفواتير المعلقة", toolsAllow: ["*"] },
    delivery: { mode: "announce", channel: "whatsapp", to: "+966500000001" }, configRevision: "sha256:abc",
    state: { nextRunAtMs: 2000, lastRunAtMs: 1000, lastRunStatus: "error", lastDurationMs: 11153, lastDeliveryStatus: "not-delivered",
      lastError: `failed to open ${SECRET_PATH} with key sk-live-abcdefghijklmnop`, consecutiveErrors: 2 } },
  { id: J_SYSTEM, declarationKey: "memory-core:memory-dreaming-promotion", name: "Memory Dreaming Promotion", enabled: true,
    description: "[managed-by=memory-core]", schedule: { kind: "cron", expr: "0 3 * * *" }, payload: { kind: "agentTurn", message: "__internal__" },
    state: { nextRunAtMs: 3000 } },
  { id: J_OFF, name: "تقرير الأحد", enabled: false, schedule: { kind: "cron", expr: "30 9 * * 0", tz: "Asia/Riyadh" },
    payload: { kind: "agentTurn", message: "تقرير أسبوعي" }, state: {} },
  { id: J_CMD, name: "Queue check", enabled: true, schedule: { kind: "on-exit", command: "scripts/check.sh", cwd: "/srv/app" },
    payload: { kind: "command", command: "scripts/check.sh --token secret" }, state: { runningAtMs: 5 } },
  { id: "../bad id", name: "x", enabled: true, schedule: { kind: "cron", expr: "* * * * *" }, state: {} },
];

const RESULTS = {
  "cron.runs": () => ({ entries: [
    { ts: 20, jobId: J_OWNER, action: "finished", status: "ok", completionStatus: "succeeded", summary: "NO_REPLY", runAtMs: 19, durationMs: 1855, deliveryStatus: "not-requested",
      sessionKey: "agent:main:cron:x", runId: "cron:x" },
    { ts: 10, jobId: J_OWNER, action: "finished", status: "error", completionStatus: "failed", summary: `رد طويل\nفيه مسار ${SECRET_PATH} ورابط https://example.com/a/b`,
      error: `boom at ${SECRET_PATH}`, runAtMs: 9, durationMs: 50, deliveryStatus: "not-delivered", deliveryError: "Channel is required" },
    { ts: 5, jobId: J_OWNER, action: "started" },
    { ts: 4, jobId: "someone-else", action: "finished", status: "ok", runAtMs: 4 },
  ], hasMore: false }),
  "sessions.usage": () => ({ startDate: "2026-10-29", endDate: "2026-11-27", sessions: [{ key: APP_SESSION_KEY, label: "app",
    usage: { sessionFile: `sqlite:main:x:${SECRET_PATH}`, input: 9540, output: 1413, totalTokens: 10953, totalCost: 0, missingCostEntries: 21,
      missingCostByModel: { "xai/grok-3-fast": 21 }, dailyBreakdown: [{ date: "2026-11-26", totalTokens: 100, totalCost: 0.01 }, { date: "2026-11-27", totalTokens: 10853, totalCost: 0, missingCostEntries: 21 }] } }],
    totals: { totalTokens: 10953 } }),
  "usage.cost": () => ({ days: 30, totals: { totalTokens: 11895, totalCost: 0.42, missingCostEntries: 0 },
    daily: [{ date: "2026-11-26", totalTokens: 1000, totalCost: 0.4 }, { date: "2026-11-27", totalTokens: 10895, totalCost: 0.02 }] }),
  "memory.status": () => ({ status: "ready", providerId: "memory-core", details: { legacy: { files: 11, chunks: 48, dirty: false, provider: "none",
    sourceCounts: [{ source: "memory", files: 4, chunks: 13 }, { source: "sessions", files: 7, chunks: 35 }], custom: { searchMode: "fts-only", indexIdentity: { status: "valid" } },
    dbPath: SECRET_PATH } } }),
  "agents.files.list": () => ({ agentId: "main", workspace: "/data/workspace", files: [
    { name: "AGENTS.md", path: "/data/workspace/AGENTS.md", size: 7203 }, { name: "USER.md", path: "/data/workspace/USER.md", size: 1077, updatedAtMs: 7 },
    { name: "MEMORY.md", path: "/data/workspace/MEMORY.md", missing: true }] }),
  "memory.search": (p) => ({ provider: "none", searchMode: "fts-only", stale: false, results: [
    { path: "MEMORY.md", startLine: 6, endLine: 7, score: 0.9, snippet: "- مورد الورق: مؤسسة النخبة.\n", source: "memory" },
    { path: "memory/2026-11-26.md", startLine: 1, endLine: 5, score: 0.8, snippet: "اتفقنا مع النخبة", source: "memory" },
    { path: "../../etc/passwd.md", snippet: "nope", source: "memory" },
    { path: "sessions/x.jsonl", snippet: "group chat text", source: "sessions" },
    ...Array.from({ length: Math.max(0, (p.maxResults ?? 10) - 4) }, (_, i) => ({ path: `memory/2026-10-${String(i + 1).padStart(2, "0")}.md`, snippet: `n${i}`, source: "memory" })),
  ] }),
  "memory.get": (p) => ({ status: "ok", reference: p.reference, text: p.reference.id === "MEMORY.md" ? "x".repeat(45_000) : "# 2026-11-26\nاتفقنا مع النخبة" }),
  "agents.files.get": (p) => ({ agentId: "main", workspace: "/data/workspace", file: p.name === "USER.md"
    ? { name: "USER.md", path: "/data/workspace/USER.md", missing: false, size: 30, updatedAtMs: 9, hash: "h", content: "# USER.md\n- يفضّل العربية" }
    : { name: p.name, path: `/data/workspace/${p.name}`, missing: true } }),
  "channels.status": () => ({ ts: 1, channelOrder: ["whatsapp", "telegram"], channelLabels: { whatsapp: "WhatsApp", telegram: "Telegram" },
    channelAccounts: { whatsapp: [{ accountId: "+966500000001", name: "Safwan", enabled: true, configured: true, linked: true, running: true, connected: true,
      lastConnectedAt: 123, dbPath: SECRET_PATH, allowFrom: ["+966500000001"] }], telegram: [{ accountId: "bot", configured: true, linked: false, botTokenSource: "env" }] },
    channelDefaultAccountId: { whatsapp: "+966500000001" }, statusIssues: [{ channel: "telegram", accountId: "bot", kind: "auth", message: `token missing in ${SECRET_PATH}` }] }),
  "skills.status": () => ({ workspaceDir: "/data/workspace", managedSkillsDir: "/data/skills", skills: [
    { name: "basht-daftra", emoji: "📒", description: "Daftra invoices", eligible: true, filePath: "/data/skills/basht-daftra/SKILL.md", baseDir: "/data/skills/basht-daftra" },
    { name: "1password", emoji: "🔐", eligible: false, missing: { bins: ["op"], anyBins: [], env: ["OP_TOKEN"], config: ["skills.1password.vault"], os: [] }, filePath: "/x/SKILL.md" },
    { name: "notes", eligible: false, disabled: true },
    { name: "mac-only", eligible: false, platformIncompatible: true, missing: { os: ["darwin"] } },
  ] }),
  "tools.effective": (p) => ({ agentId: "main", profile: "full", sessionKey: p.sessionKey, groups: [
    { id: "core", label: "Built-in tools", source: "core", tools: [{ id: "read", label: "Read", rawDescription: "raw" }, { id: "exec", label: "Exec" }, { id: "web_search", label: "Web Search" }, { id: "mystery", label: "Mystery" }] },
    { id: "plugin", label: "Connected tools", source: "plugin", tools: [{ id: "github_read", label: "Read GitHub", source: "plugin", pluginId: "github" }, { id: "dir_list", label: "Directory List", source: "plugin", pluginId: "file-transfer" }] },
  ], toolAccess: { checked: "live-session" } }),
  "tools.catalog": () => ({ groups: [{ id: "fs", label: "Files", tools: [{ id: "read" }] }, { id: "runtime", label: "Runtime", tools: [{ id: "exec" }] },
    { id: "web", label: "Web", tools: [{ id: "web_search" }] }, { id: "plugin:github", label: "github", tools: [{ id: "github_read" }] }] }),
  "plugins.list": () => ({ plugins: [{ id: "github", name: "GitHub", enabled: true, state: "enabled", packageName: "@x/y" }, { id: "memory-wiki", enabled: false, state: "disabled" },
    { id: "agent-guidance", name: "Agent Guidance", enabled: false, state: "needs-setup" }, { id: "broken", name: "Broken", enabled: true, state: "error" }] }),
};

async function fakeGatewayCall(method, params) {
  rpc.push({ method, params });
  inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (failing.has(method)) throw new Error("gateway call failed (ECONNREFUSED)");
    if (refusing.has(method)) { const e = new Error(`gateway call ${method} failed (gateway_request_error)`); e.refused = true; throw e; }
    if (method === "cron.list") return { jobs, hasMore: false, deliveryPreviews: {}, snapshotRevision: "r" };
    if (method === "cron.run") return { ok: true, enqueued: true, runId: "cron-request.x", processInstanceId: "p" };
    if (method === "cron.update") { const j = jobs.find((x) => x.id === params.id); j.enabled = params.patch.enabled; return { ...j }; }
    const r = RESULTS[method];
    if (!r) throw new Error(`unexpected gateway call ${method}`);
    return r(params);
  } finally { inFlight--; }
}

let server, base, dir, serverNoCall, baseNoCall;
const listen = (router) => new Promise((resolve) => {
  const app = express(); app.use("/app/v1", router);
  const s = app.listen(0, "127.0.0.1", () => resolve({ s, url: `http://127.0.0.1:${s.address().port}/app/v1` }));
});

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-control-"));
  fs.writeFileSync(path.join(dir, "openclaw.json"), "{}");
  const opts = { token: APP_TOKEN, gatewayUrl: "http://127.0.0.1:9", gatewayToken: "gw-synthetic", configPath: path.join(dir, "openclaw.json"), now: () => Date.now() + clockOffset };
  ({ s: server, url: base } = await listen(createAppBridge({ ...opts, gatewayCall: fakeGatewayCall })));
  ({ s: serverNoCall, url: baseNoCall } = await listen(createAppBridge(opts)));
});
after(() => { server.close(); serverNoCall.close(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { rpc = []; clockOffset += 10 * 60_000; delayMs = 0; failing = new Set(); refusing = new Set(); jobs = freshJobs(); maxInFlight = 0; }); // each test starts past every cache

const H = { authorization: `Bearer ${APP_TOKEN}` };
const get = (p, b = base) => fetch(b + p, { headers: H });
const post = (p, body, b = base) => fetch(b + p, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(body) });
const calls = (m) => rpc.filter((c) => c.method === m);
const noLeak = (j) => {
  const s = JSON.stringify(j);
  assert.ok(!s.includes("/data/"), `path leaked: ${s.slice(0, 300)}`);
  assert.ok(!/REDACTED|sk-live|sqlite:|\+966|botTokenSource|packageName|rawDescription|toolsAllow|configRevision|sessionKey|declarationKey/.test(s), `field leaked: ${s.slice(0, 300)}`);
};

test("control routes require the app token and never fall through", async () => {
  for (const p of ["/automations", "/usage", "/memory/status", "/memory/search?q=x", "/capabilities"]) {
    assert.equal((await fetch(base + p)).status, 401, p);
  }
  assert.equal((await fetch(base + `/automations/${J_OWNER}/run`, { method: "POST" })).status, 401);
  assert.equal(rpc.length, 0);
  assert.equal((await get("/memory/unknown")).status, 404);
});

test("allowlist: only the exact read methods plus cron.run / cron.update; the wrapper re-checks the write params", () => {
  assert.deepEqual([...CONTROL_WRITE_RPC], ["cron.run", "cron.update"]);
  for (const m of CONTROL_READ_RPC) assert.ok(!/\.(add|remove|delete|set|update|install|patch|run|reset)$/.test(m), m);
  assert.ok(!CONTROL_READ_RPC.includes("config.get"));
  assert.equal(validateControlRpc("cron.run", { id: J_OWNER, mode: "force" }), true);
  assert.equal(validateControlRpc("cron.update", { id: J_OWNER, patch: { enabled: false } }), true);
  for (const p of [{ id: J_OWNER }, { id: J_OWNER, mode: "due" }, { id: J_OWNER, mode: "force", extra: 1 }, { id: "../x", mode: "force" }, null, []]) {
    assert.equal(validateControlRpc("cron.run", p), false, JSON.stringify(p));
  }
  for (const p of [{ id: J_OWNER, patch: { enabled: "yes" } }, { id: J_OWNER, patch: { enabled: true, schedule: {} } }, { id: J_OWNER, patch: { payload: {} } },
    { id: J_OWNER, patch: { enabled: true }, expectedConfigRevision: "x" }, { id: J_OWNER }]) {
    assert.equal(validateControlRpc("cron.update", p), false, JSON.stringify(p));
  }
  assert.equal(validateControlRpc("memory.search", { anything: true }), true); // reads: the method allowlist decides
  const src = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
  assert.match(src, /APP_BRIDGE_RPC = new Set\(\[[^\]]*\.\.\.CONTROL_READ_RPC, \.\.\.CONTROL_WRITE_RPC\]\)/);
  assert.match(src, /if \(!validateControlRpc\(method, params\)\) return Promise\.reject/);
});

test("automations: fixed shape, owner prompt only, no commands/paths/delivery targets; cached 20 s", async () => {
  const r = await get("/automations");
  assert.equal(r.status, 200);
  const j = await r.json();
  noLeak(j);
  assert.deepEqual(j.jobs.map((x) => x.id), [J_OWNER, J_SYSTEM, J_OFF, J_CMD]); // a malformed id is dropped
  const [own, sys, off, cmd] = j.jobs;
  assert.deepEqual(Object.keys(own).sort(), ["autoDisabled", "consecutiveErrors", "enabled", "id", "kind", "last", "name", "nextRunAt", "prompt", "running", "schedule", "system"]);
  assert.equal(own.prompt, "راجع الفواتير المعلقة");
  assert.deepEqual(own.schedule, { kind: "every", everyMs: 21600000 });
  assert.equal(own.last.status, "error");
  assert.equal(own.last.delivery, "not-delivered");
  assert.match(own.last.error, /^failed to open … with key …$/);
  assert.equal(sys.system, true);
  assert.equal(sys.prompt, null);
  assert.deepEqual(off.schedule, { kind: "cron", expr: "30 9 * * 0", tz: "Asia/Riyadh" });
  assert.equal(off.enabled, false);
  assert.deepEqual(cmd.schedule, { kind: "other" });
  assert.equal(cmd.prompt, null);
  assert.equal(cmd.kind, "command");
  assert.equal(cmd.running, true);
  assert.deepEqual(calls("cron.list")[0].params, { includeDisabled: true, limit: 200, sortBy: "nextRunAtMs", sortDir: "asc" });
  await get("/automations");
  assert.equal(calls("cron.list").length, 1, "second read within 20 s is cached");
  clockOffset += 21_000;
  await get("/automations");
  assert.equal(calls("cron.list").length, 2);
});

test("automation runs: known jobs only, finished runs of that job, NO_REPLY is quiet, paths scrubbed, limit capped", async () => {
  assert.equal((await get("/automations/not-a-job/runs")).status, 404);
  assert.equal(calls("cron.runs").length, 0);
  const r = await get(`/automations/${J_OWNER}/runs?limit=500`);
  const j = await r.json();
  noLeak(j);
  assert.deepEqual(calls("cron.runs")[0].params, { scope: "job", id: J_OWNER, limit: 20, sortDir: "desc" });
  assert.equal(j.runs.length, 2);
  assert.deepEqual(j.runs[0], { at: 19, status: "ok", completion: "succeeded", durationMs: 1855, quiet: true, summary: null, error: null, delivery: "not-requested" });
  assert.equal(j.runs[1].summary, "رد طويل\nفيه مسار … ورابط https://example.com/a/b");
  assert.equal(j.runs[1].error, "boom at …");
});

test("run now: bridge-built params, owner jobs only, one at a time, refusal is a 400", async () => {
  assert.equal((await post(`/automations/${J_SYSTEM}/run`, {})).status, 400);
  assert.equal((await post(`/automations/nope/run`, {})).status, 404);
  assert.equal((await post(`/automations/${J_CMD}/run`, {})).status, 409); // already running
  assert.equal(calls("cron.run").length, 0);
  const r = await post(`/automations/${J_OWNER}/run`, { id: J_SYSTEM, mode: "due", sessionKey: "x" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, id: J_OWNER, enqueued: true });
  assert.deepEqual(calls("cron.run")[0].params, { id: J_OWNER, mode: "force" });
  assert.ok(calls("cron.run").every((c) => validateControlRpc(c.method, c.params)));
  refusing.add("cron.run");
  const bad = await post(`/automations/${J_OWNER}/run`, {});
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { ok: false, error: "rejected" });
});

test("enable/disable: boolean only, {enabled} patch only, answers with the engine's state; system jobs refused", async () => {
  assert.equal((await post(`/automations/${J_OFF}/enabled`, { enabled: "true" })).status, 400);
  assert.equal((await post(`/automations/${J_SYSTEM}/enabled`, { enabled: false })).status, 400);
  assert.equal(calls("cron.update").length, 0);
  const r = await post(`/automations/${J_OFF}/enabled`, { enabled: true, schedule: { kind: "every" } });
  assert.deepEqual(await r.json(), { ok: true, id: J_OFF, enabled: true });
  assert.deepEqual(calls("cron.update")[0].params, { id: J_OFF, patch: { enabled: true } });
  // already in that state: no write
  await post(`/automations/${J_OFF}/enabled`, { enabled: true });
  assert.equal(calls("cron.update").length, 1);
  // a fresh list after a write (never a cached one)
  const l = await (await get("/automations")).json();
  assert.equal(l.jobs.find((x) => x.id === J_OFF).enabled, true);
});

test("usage: app session tokens + 30-day totals; cost of an unpriced model is unknown, not 0; no session file paths", async () => {
  const j = await (await get("/usage")).json();
  noLeak(j);
  assert.deepEqual(calls("sessions.usage")[0].params, { key: APP_SESSION_KEY, range: "30d" });
  assert.equal(j.app.tokens, 10953);
  assert.equal(j.app.cost, null);
  assert.equal(j.app.costPartial, true);
  assert.deepEqual(j.app.today, { date: "2026-11-27", tokens: 10853, cost: null, costPartial: true });
  assert.equal(j.all.tokens, 11895);
  assert.equal(j.all.cost, 0.42);
  assert.equal(j.all.daily.length, 2);
  assert.deepEqual(j.missingCostModels, ["xai/grok-3-fast"]);
  failing.add("usage.cost");
  clockOffset += 61_000;
  const partial = await (await get("/usage")).json();
  assert.equal(partial.all, null);
  assert.equal(partial.app.tokens, 10953);
});

test("memory status: coarse state, memory-file counts, MEMORY.md / USER.md presence only", async () => {
  const j = await (await get("/memory/status")).json();
  noLeak(j);
  assert.equal(j.state, "ok");
  assert.equal(j.files, 4);
  assert.equal(j.chunks, 13);
  assert.equal(j.searchMode, "fts-only");
  assert.deepEqual(j.bootstrap, [{ name: "USER.md", exists: true, size: 1077, updatedAt: 7 }, { name: "MEMORY.md", exists: false, size: null, updatedAt: null }]);
});

test("memory search: memory files only, validated query, basenames, opaque refs; item reads only refs this bridge issued", async () => {
  assert.equal((await get("/memory/search?q=")).status, 400);
  assert.equal((await get(`/memory/search?q=${"x".repeat(201)}`)).status, 400);
  assert.equal((await get("/memory/search?q=x&page=3")).status, 400);
  const j = await (await get(`/memory/search?q=${encodeURIComponent("النخبة")}`)).json();
  noLeak(j);
  assert.deepEqual(calls("memory.search")[0].params, { query: "النخبة", agentId: "main", maxResults: 10, sources: ["memory"] });
  assert.equal(j.results.length, 8); // the traversal path and the session hit are dropped
  assert.deepEqual(j.results.slice(0, 2).map((h) => h.file), ["MEMORY.md", "2026-11-26.md"]);
  assert.equal(j.results[1].date, "2026-11-26");
  assert.ok(j.results.every((h) => /^[0-9a-f]{24}$/.test(h.ref) && !("reference" in h)));
  assert.equal(j.more, false);
  const item = await (await get(`/memory/item?ref=${j.results[1].ref}`)).json();
  assert.deepEqual(calls("memory.get")[0].params, { reference: { providerId: "memory-core", id: "memory/2026-11-26.md" } });
  assert.equal(item.file, "2026-11-26.md");
  assert.match(item.text, /اتفقنا مع النخبة/);
  assert.equal((await get(`/memory/item?ref=${"0".repeat(24)}`)).status, 404);
  assert.equal((await get("/memory/item?ref=memory/2026-11-26.md")).status, 404);
  assert.equal(calls("memory.get").length, 1);
  // paging and the 20 000-character parts
  const big = await (await get(`/memory/item?ref=${j.results[0].ref}&part=2`)).json();
  assert.deepEqual([big.part, big.parts, big.chars, big.text.length], [2, 3, 45_000, 5000]);
  assert.equal((await get(`/memory/item?ref=${j.results[0].ref}&part=99`)).status, 400);
  const p1 = await (await get(`/memory/search?q=x&page=1`)).json();
  assert.equal(calls("memory.search").at(-1).params.maxResults, 20);
  assert.equal(p1.results.length, 8); // 18 usable hits of 20: page 2 holds 11–18
});

test("memory files: MEMORY.md and USER.md only, read-only content, missing is reported", async () => {
  assert.equal((await get("/memory/file?name=AGENTS.md")).status, 400);
  assert.equal((await get("/memory/file?name=../openclaw.json")).status, 400);
  const u = await (await get("/memory/file?name=USER.md")).json();
  noLeak(u);
  assert.deepEqual(u, { ok: true, name: "USER.md", exists: true, updatedAt: 9, text: "# USER.md\n- يفضّل العربية", part: 0, parts: 1, chars: 25, truncated: false });
  const m = await (await get("/memory/file?name=MEMORY.md")).json();
  assert.equal(m.exists, false);
  assert.ok(calls("agents.files.get").every((c) => ["MEMORY.md", "USER.md"].includes(c.params.name)));
});

test("capabilities: channels linked/connected without account ids, skills with short reasons, tools grouped, plugins by name", async () => {
  const j = await (await get("/capabilities")).json();
  noLeak(j);
  assert.deepEqual(j.channels[0], { id: "whatsapp", label: "WhatsApp", accounts: 1, configured: true, linked: true, running: true, connected: true, lastConnectedAt: 123, issue: null });
  assert.equal(j.channels[1].issue, "auth");
  assert.deepEqual(j.skills.ready.map((s) => s.name), ["basht-daftra"]);
  assert.deepEqual(j.skills.missing[0].missing, { bins: ["op"], env: ["OP_TOKEN"], config: 1, os: false });
  assert.deepEqual(j.skills.unavailable.map((s) => s.state), ["disabled", "platform"]);
  assert.deepEqual(calls("tools.effective")[0].params, { agentId: "main", sessionKey: APP_SESSION_KEY });
  assert.deepEqual(j.tools.groups.map((g) => g.id), ["fs", "runtime", "web", "other", "plugin:github", "plugin:file-transfer"]);
  assert.equal(j.tools.count, 6);
  assert.deepEqual(j.plugins.enabled, [{ id: "github", name: "GitHub" }]);
  assert.deepEqual(j.plugins.needsSetup.map((p) => p.id), ["agent-guidance"]);
  assert.deepEqual(j.plugins.failed.map((p) => p.id), ["broken"]);
  // one section failing leaves the others
  failing.add("skills.status");
  clockOffset += 61_000;
  const p = await (await get("/capabilities")).json();
  assert.equal(p.skills, null);
  assert.equal(p.channels.length, 2);
  assert.equal(calls("tools.catalog").length, 1, "the tool catalog is cached for 10 minutes");
});

test("at most two engine calls at once, and parallel reads of one view share a call", async () => {
  delayMs = 40;
  await Promise.all([get("/capabilities"), get("/capabilities"), get("/usage"), get("/memory/status")]);
  assert.ok(maxInFlight <= 2, `in flight ${maxInFlight}`);
  assert.equal(calls("channels.status").length, 1);
});

test("without gatewayCall the control routes answer 503; an outage is a 502 with no engine text", async () => {
  const r = await get("/automations", baseNoCall);
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { ok: false, error: "not_available" });
  failing.add("cron.list");
  const o = await get("/automations");
  assert.equal(o.status, 502);
  assert.deepEqual(await o.json(), { ok: false, error: "engine_unavailable" });
});

test("helpers: paths and secret-shaped tokens are scrubbed, URLs kept; basenames; schedules; text parts", () => {
  assert.equal(cleanText("see /data/.openclaw/x.json and C:\\Users\\a\\b.txt"), "see … and …");
  assert.equal(cleanText("https://x.com/a/b ok"), "https://x.com/a/b ok");
  assert.equal(cleanText("key __OPENCLAW_REDACTED__ ghp_abcdefghijklmn"), "key … …");
  assert.equal(cleanText("a\u0000b\nc", 10), "a b c");
  assert.equal(cleanText("x".repeat(20), 5), "xxxx…");
  assert.equal(baseName("memory/2026-11-26.md"), "2026-11-26.md");
  assert.equal(baseName("../"), null);
  assert.deepEqual(mapSchedule({ kind: "stream", command: ["tail", "-f", "/var/log/x"] }), { kind: "other" });
  assert.deepEqual(mapSchedule({ kind: "at", at: "2026-12-01T09:00:00Z" }), { kind: "at", at: "2026-12-01T09:00:00Z" });
  assert.equal(mapHit({ path: "/abs/MEMORY.md", snippet: "x", source: "memory" }), null);
  assert.deepEqual(textPart("", 0), { text: "", part: 0, parts: 1, chars: 0, truncated: false });
  assert.equal(textPart("y".repeat(250_000), 9).truncated, true);
});
