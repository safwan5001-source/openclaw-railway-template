// BASHT app bridge: auth, the read allowlist, owner-only conversations, and one owner turn at a time in the app session.
// A FAKE gateway (in this file) stands in for OpenClaw; loopback only, synthetic tokens, temp config.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { APP_SESSION, APP_SESSION_KEY, assistantMeta, createAppBridge, isReadable, mapModel, messageText, modelRef, safeStr } from "./app-bridge.js";

const APP_TOKEN = "synthetic-app-token-0123456789abcdef0123";
const GW_TOKEN = "synthetic-gateway-token-0123456789abcdef";
const OWNER = "+966500000001";
const seen = []; // what the fake gateway received
let chatGate = null; // when set, the fake chat stream waits for it before finishing

const ROWS = [
  { key: APP_SESSION_KEY, channel: "unknown", updatedAt: 3 },
  { key: "agent:main:main", channel: "webchat", updatedAt: 2 },
  { key: `agent:main:whatsapp:direct:${OWNER}`, channel: "whatsapp", updatedAt: 5 },
  { key: "agent:main:whatsapp:direct:+966511111111", channel: "whatsapp", updatedAt: 9 }, // someone else
  { key: "agent:main:whatsapp:group:120363@g.us", channel: "whatsapp", updatedAt: 8 },
  { key: "agent:main:subagent:abc", channel: "unknown", updatedAt: 7 },
];

const FILLER = Array.from({ length: 120 }, (_, i) => ({ key: `agent:main:whatsapp:group:${i}@g.us`, channel: "whatsapp", updatedAt: 1 }));

// ---- fake model control: what `openclaw gateway call` and the `sessions` tool would answer (shapes seen on 2026.11.10) ----
const rpc = []; // every gatewayCall the bridge made
const timeline = []; // order in which writes and turns reached the (fake) gateway
let patchDelay = 0;  // ms a sessions.patch takes (to hold a write in flight)
let clockOffset = 0; // moves the bridge's clock (models cache)
const RUNTIME = { id: "openclaw", source: "implicit" };
const MODELS = [
  { id: "echo", name: "Echo", provider: "mock", available: true, reasoning: true, contextWindow: 128000, input: ["text"], local: true,
    thinkingLevels: [{ id: "off", label: "off" }, { id: "low", label: "low" }, { id: "high", label: "high" }], thinkingDefault: "low",
    agentRuntime: RUNTIME, tags: ["default"], baseUrl: "http://10.0.0.1/secret", apiKey: "sk-should-never-leave" },
  { id: "echo2", name: "Echo Two", provider: "mock", available: true, thinkingLevels: [{ id: "off", label: "off" }], tags: ["fallback#1"] },
  { id: "grok-3", name: "Grok 3", provider: "xai", available: true, supportsFastMode: true, thinkingLevels: [{ id: "off", label: "off" }] },
  { id: "down", provider: "mock", available: false, unavailableReason: "rate_limit", unavailableUntil: 1795750000000 },
  { id: "locked", provider: "mock", available: true, manualSelectionAllowed: false },
  { id: "policy", provider: "mock", available: true }, // listed, but the engine refuses it on patch
  { id: "anthropic/claude-x", provider: "openrouter", providerName: "OpenRouter", available: true, recommended: true },
];
const LEVELS = { "mock/echo": MODELS[0].thinkingLevels, "mock/echo2": MODELS[1].thinkingLevels, "xai/grok-3": MODELS[2].thinkingLevels };
const freshSession = () => ({ key: APP_SESSION_KEY, modelProvider: "mock", model: "echo", modelOverrideSource: null, thinkingLevels: LEVELS["mock/echo"],
  thinkingDefault: "low", effectiveFastMode: false, effectiveFastModeSource: "default", inputTokens: 50, outputTokens: 7, totalTokens: 57,
  contextTokens: 128000, path: "/data/.openclaw/agents/main/agent/openclaw-agent.sqlite" });
let appSession = freshSession();
const otherPatched = []; // any write that named a session other than the app's

async function fakeGatewayCall(method, params) {
  rpc.push({ method, params });
  if (method === "models.list") return { models: MODELS, decisionModels: [{ id: "x" }], accountSelection: { kind: "automatic" } };
  if (method === "sessions.describe") return { session: params.key === APP_SESSION_KEY ? appSession : null };
  if (method === "sessions.patch") {
    if (patchDelay) await new Promise((r) => setTimeout(r, patchDelay));
    timeline.push(`patch:${Object.keys(params).filter((k) => k !== "key").join(",")}`);
    if (params.key !== APP_SESSION_KEY) { otherPatched.push(params); return { ok: true }; }
    if ("thinkingLevel" in params) { if (params.thinkingLevel === null) delete appSession.thinkingLevel; else appSession.thinkingLevel = params.thinkingLevel; }
    if ("fastMode" in params) {
      appSession.effectiveFastMode = params.fastMode === true;
      appSession.effectiveFastModeSource = params.fastMode === null ? "default" : "session";
    }
    return { ok: true, path: "/data/secret.sqlite", key: params.key, entry: {} };
  }
  throw new Error(`unexpected gateway call ${method}`);
}

const fakeSessionsTool = (args) => {
  timeline.push(`model:${args.model}`);
  if (args.sessionKey !== APP_SESSION_KEY) { otherPatched.push(args); return { status: "updated", sessionKey: args.sessionKey }; }
  if (args.model === "mock/policy") return null; // the engine's own policy refuses it
  if (args.model === "default") Object.assign(appSession, { modelProvider: "mock", model: "echo", modelOverrideSource: null });
  else { const [p, ...m] = args.model.split("/"); Object.assign(appSession, { modelProvider: p, model: m.join("/"), modelOverrideSource: "user" }); }
  appSession.thinkingLevels = LEVELS[`${appSession.modelProvider}/${appSession.model}`] ?? [];
  return { status: "updated", sessionKey: APP_SESSION_KEY, updated: ["model"],
    resolved: { modelProvider: appSession.modelProvider, model: appSession.model, agentRuntime: RUNTIME, thinkingLevel: "off" } };
};

const APP_HISTORY = [
  { role: "user", content: "مرحبا", timestamp: 10 },
  { role: "assistant", provider: "openclaw", model: "delivery-mirror", api: "openclaw-transcript", timestamp: 11,
    content: [{ type: "text", text: "Model switched from mock/echo to mock/echo2 (server_error)." }],
    openclawDeliveryMirror: { kind: "model-fallback", runId: "chatcmpl_1", fromModel: "mock/echo", toModel: "mock/echo2", reason: "server_error" } },
  { role: "assistant", provider: "mock", model: "echo2", api: "openai-completions", timestamp: 12, responseId: "secret-id",
    content: [{ type: "text", text: "رد" }], __openclaw: { runId: "chatcmpl_1", id: "x" } },
];

let gateway, gwUrl, server, base, dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-bridge-"));
  fs.writeFileSync(path.join(dir, "openclaw.json"), JSON.stringify({ commands: { ownerAllowFrom: [`whatsapp:${OWNER}`] } }));
  gateway = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      seen.push({ url: req.url, auth: req.headers.authorization, session: req.headers["x-openclaw-session-key"] ?? null, body });
      if (req.headers.authorization !== `Bearer ${GW_TOKEN}`) { res.writeHead(401); return res.end(); }
      if (req.url === "/tools/invoke") {
        const { tool, args } = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        if (tool === "sessions_list") {
          // paged like the real gateway: the owner's WhatsApp chat sits on the SECOND page, behind unrelated sessions
          const all = [...ROWS.filter((r) => !r.key.includes(OWNER)), ...FILLER, ...ROWS.filter((r) => r.key.includes(OWNER))];
          const off = args.offset ?? 0, page = all.slice(off, off + (args.limit ?? 100));
          return res.end(JSON.stringify({ ok: true, result: { details: { sessions: page, hasMore: off + page.length < all.length, nextOffset: off + page.length } } }));
        }
        if (tool === "sessions") {
          const d = args.action === "patch" ? fakeSessionsTool(args) : null;
          if (!d) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: { type: "tool_error", message: "tool execution failed" } })); }
          return res.end(JSON.stringify({ ok: true, result: { details: d } }));
        }
        if (tool === "sessions_history" && args.sessionKey === APP_SESSION_KEY) {
          return res.end(JSON.stringify({ ok: true, result: { details: { sessionKey: args.sessionKey, hasMore: false, messages: APP_HISTORY } } }));
        }
        if (tool === "sessions_history") {
          return res.end(JSON.stringify({ ok: true, result: { details: { sessionKey: args.sessionKey, hasMore: false, messages: [
            { role: "user", content: "مرحبا", timestamp: 1 },
            { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "أهلًا" }, { type: "toolCall", name: "x" }], timestamp: 2 },
            { role: "toolResult", content: "tool output", timestamp: 3 },
          ] } } }));
        }
        return res.end(JSON.stringify({ ok: false }));
      }
      if (req.url === "/v1/chat/completions") {
        timeline.push("turn");
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (d) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: d }] })}\n\n`);
        send({ role: "assistant" });
        send({ content: "تم " });
        if (chatGate) await chatGate;
        send({ content: "التنفيذ" });
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  gwUrl = `http://127.0.0.1:${gateway.address().port}`;
  const app = express();
  app.use("/app/v1", createAppBridge({ token: APP_TOKEN, gatewayUrl: gwUrl, gatewayToken: GW_TOKEN, configPath: path.join(dir, "openclaw.json"),
    gatewayCall: fakeGatewayCall, now: () => Date.now() + clockOffset }));
  app.use("/nocall/v1", createAppBridge({ token: APP_TOKEN, gatewayUrl: gwUrl, gatewayToken: GW_TOKEN, configPath: path.join(dir, "openclaw.json") }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/app/v1`;
});

after(() => {
  server?.close();
  gateway?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = (p, { method = "GET", token = APP_TOKEN, body } = {}) =>
  fetch(base + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const waitRun = async (id) => {
  for (let i = 0; i < 100; i++) {
    const r = await call(`/runs/${id}`);
    if (r.json.status !== "running") return r.json;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("run did not finish");
};

test("off without a long enough token", () => {
  assert.equal(createAppBridge({ token: "", gatewayUrl: "x", gatewayToken: "y", configPath: "z" }), null);
  assert.equal(createAppBridge({ token: "short", gatewayUrl: "x", gatewayToken: "y", configPath: "z" }), null);
});

test("requires the app token; the gateway token is not accepted from outside", async () => {
  assert.equal((await call("/status", { token: null })).status, 401);
  assert.equal((await call("/status", { token: GW_TOKEN })).status, 401);
  assert.equal((await call("/status", { token: APP_TOKEN + "x" })).status, 401);
  const ok = await call("/status");
  assert.equal(ok.status, 200);
  assert.equal(ok.json.appSession, APP_SESSION_KEY);
});

test("failed attempts are throttled, but never lock out the valid token", async () => {
  for (let i = 0; i < 25; i++) await call("/status", { token: "wrong-token-" + i });
  assert.equal((await call("/status", { token: "wrong-token-x" })).status, 429);
  assert.equal((await call("/status")).status, 200, "the owner's app keeps working during an anonymous flood");
});

test("lists only the owner's own conversations; never groups, other people or subagents", async () => {
  const r = await call("/sessions");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.sessions.map((s) => s.key), [`agent:main:whatsapp:direct:${OWNER}`, APP_SESSION_KEY, "agent:main:main"]);
  assert.deepEqual(r.json.sessions.map((s) => s.writable), [false, true, false]);
  assert.ok(!JSON.stringify(r.json).includes("+966511111111"));
  // the bridge used the gateway token itself
  assert.equal(seen.at(-1).auth, `Bearer ${GW_TOKEN}`);
});

test("history: text only (no thinking, tool calls or tool results), and refuses chats outside the allowlist", async () => {
  const r = await call(`/history?key=${encodeURIComponent(`agent:main:whatsapp:direct:${OWNER}`)}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.messages.map((m) => [m.role, m.text]), [["user", "مرحبا"], ["assistant", "أهلًا"]]);
  for (const key of ["agent:main:whatsapp:direct:+966511111111", "agent:main:whatsapp:group:120363@g.us", "agent:main:subagent:abc", "agent:main:unknown"]) {
    assert.equal((await call(`/history?key=${encodeURIComponent(key)}`)).status, 404, key);
  }
});

test("send: one owner turn in the app session only, streamed text, one at a time", async () => {
  let open;
  chatGate = new Promise((r) => (open = r));
  const started = await call("/send", { method: "POST", body: { message: "أرسل التقرير", sessionKey: "agent:main:whatsapp:direct:+966500000001" } });
  assert.equal(started.status, 202);
  await new Promise((r) => setTimeout(r, 50));
  const live = await call(`/runs/${started.json.runId}`);
  assert.equal(live.json.status, "running");
  assert.equal(live.json.text, "تم ");
  assert.ok(Number.isInteger(live.json.firstTokenMs) && live.json.firstTokenMs >= 0, "first token measured while running");
  assert.equal(live.json.totalMs, null);
  assert.equal((await call("/send", { method: "POST", body: { message: "ثانية" } })).status, 409);
  open();
  chatGate = null;
  const done = await waitRun(started.json.runId);
  assert.equal(done.status, "done");
  assert.equal(done.text, "تم التنفيذ");
  assert.ok(done.totalMs >= done.firstTokenMs && done.totalMs >= 40, "total covers the gated wait");
  const chat = seen.find((s) => s.url === "/v1/chat/completions");
  assert.equal(chat.session, APP_SESSION, "always the app's own session, whatever the caller sends");
  assert.equal(chat.auth, `Bearer ${GW_TOKEN}`);
  assert.deepEqual(JSON.parse(chat.body).messages, [{ role: "user", content: "أرسل التقرير" }]);
});

test("send: rejects empty and oversized messages; stop ends a running turn", async () => {
  assert.equal((await call("/send", { method: "POST", body: { message: "  " } })).status, 400);
  assert.equal((await call("/send", { method: "POST", body: { message: "x".repeat(8001) } })).status, 400);
  chatGate = new Promise(() => {}); // never finishes by itself
  const s = await call("/send", { method: "POST", body: { message: "طويلة" } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await call(`/runs/${s.json.runId}/stop`, { method: "POST" })).status, 200);
  const r = await waitRun(s.json.runId);
  assert.equal(r.status, "stopped");
  chatGate = null;
  assert.equal((await call("/runs/nope")).status, 404);
});

test("allowlist and text helpers", () => {
  assert.equal(isReadable({ key: `agent:main:whatsapp:default:direct:${OWNER}` }, [OWNER]), true);
  assert.equal(isReadable({ key: `agent:main:whatsapp:direct:${OWNER}` }, []), false, "no configured owner: no WhatsApp chat is readable");
  assert.equal(isReadable({ key: "agent:other:main" }, [OWNER]), false);
  assert.equal(messageText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "a\nb");
  assert.equal(messageText({ content: null }), "");
});

// ---------------------------------------------------------------- model control (M) ----------------------------------------------------------------

const post = (p, body, opts = {}) => call(p, { method: "POST", body, ...opts });

test("model routes require the app token like every other route", async () => {
  clockOffset += 61_000; // a fresh auth-failure window (an earlier test floods it on purpose)
  for (const [m, p] of [["GET", "/models"], ["GET", "/model"], ["POST", "/model"], ["POST", "/thinking"], ["POST", "/fast"]]) {
    assert.equal((await call(p, { method: m, token: null, body: m === "POST" ? { model: "mock/echo2" } : undefined })).status, 401, p);
    assert.equal((await call(p, { method: m, token: GW_TOKEN })).status, 401, p);
  }
});

test("models: fixed safe shape, provider/model refs, no raw upstream fields, cached for 60 s", async () => {
  rpc.length = 0;
  const r = await call("/models");
  assert.equal(r.status, 200);
  assert.equal(r.json.cached, false);
  const keys = ["id", "name", "provider", "providerName", "available", "unavailableReason", "unavailableUntil", "contextWindow", "reasoning",
    "thinkingLevels", "thinkingDefault", "supportsFastMode", "supportsTools", "input", "recommended", "selectable"];
  for (const m of r.json.models) assert.deepEqual(Object.keys(m), keys);
  const byId = Object.fromEntries(r.json.models.map((m) => [m.id, m]));
  assert.deepEqual(Object.keys(byId), ["mock/echo", "mock/echo2", "xai/grok-3", "mock/down", "mock/locked", "mock/policy", "openrouter/anthropic/claude-x"]);
  assert.deepEqual(byId["mock/echo"].thinkingLevels, ["off", "low", "high"]);
  assert.equal(byId["mock/echo"].thinkingDefault, "low");
  assert.equal(byId["xai/grok-3"].supportsFastMode, true);
  assert.equal(byId["mock/echo"].supportsFastMode, false);
  assert.equal(byId["mock/down"].unavailableReason, "rate_limit");
  assert.equal(byId["mock/down"].selectable, false);
  assert.equal(byId["mock/locked"].selectable, false);
  assert.equal(byId["openrouter/anthropic/claude-x"].providerName, "OpenRouter");
  const raw = JSON.stringify(r.json);
  for (const leak of ["sk-should-never-leave", "10.0.0.1", "agentRuntime", "decisionModels", "accountSelection", "tags"]) assert.ok(!raw.includes(leak), leak);
  assert.deepEqual(rpc.map((c) => c.method), ["models.list"]);
  assert.deepEqual(rpc[0].params, { agentId: "main", sessionKey: APP_SESSION_KEY, view: "default", includeDetails: true });

  const again = await call("/models");
  assert.equal(again.json.cached, true);
  assert.equal(rpc.length, 1, "served from cache");
  clockOffset += 61_000;
  assert.equal((await call("/models")).json.cached, false);
  assert.equal(rpc.length, 2, "refreshed after 60 s");
});

test("model: current state of the app session, fallback from the transcript, bridge-measured latency", async () => {
  appSession = freshSession();
  rpc.length = 0;
  const r = await call("/model");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.model, { id: "mock/echo", provider: "mock", model: "echo", source: "default" });
  assert.deepEqual(r.json.thinking, { level: null, default: "low", effective: "low", levels: ["off", "low", "high"] });
  assert.deepEqual(r.json.fast, { supported: false, enabled: false, source: "default" });
  assert.deepEqual(r.json.usage, { inputTokens: 50, outputTokens: 7, contextTokens: 57, contextWindow: 128000 });
  assert.deepEqual(r.json.lastReply, { provider: "mock", model: "echo2", at: 12 });
  assert.deepEqual(r.json.fallback, { from: "mock/echo", to: "mock/echo2", reason: "server_error", at: 11 });
  assert.ok(r.json.lastRun && typeof r.json.lastRun.runId === "string");
  assert.ok("firstTokenMs" in r.json.lastRun && "totalMs" in r.json.lastRun);
  assert.ok(!JSON.stringify(r.json).includes("openclaw-agent.sqlite"), "no upstream paths");
  assert.deepEqual(rpc.find((c) => c.method === "sessions.describe").params, { key: APP_SESSION_KEY });
});

test("model: pins a listed, available model on the app session only; 'default' clears it", async () => {
  appSession = freshSession();
  const before = seen.length;
  const r = await post("/model", { model: "mock/echo2", sessionKey: "agent:main:main", key: "agent:main:main" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.model, { id: "mock/echo2", provider: "mock", model: "echo2" });
  const tool = seen.slice(before).find((s) => s.url === "/tools/invoke");
  assert.deepEqual(JSON.parse(tool.body), { tool: "sessions", args: { action: "patch", sessionKey: APP_SESSION_KEY, model: "mock/echo2" } });
  assert.equal(tool.auth, `Bearer ${GW_TOKEN}`);
  assert.equal((await call("/model")).json.model.source, "override");
  assert.deepEqual((await call("/model")).json.thinking.levels, ["off"], "levels follow the new model");

  assert.equal((await post("/model", { model: "default" })).status, 200);
  assert.deepEqual((await call("/model")).json.model, { id: "mock/echo", provider: "mock", model: "echo", source: "default" });
  assert.deepEqual(otherPatched, []);
});

test("model: rejects anything that is not a listed, available, selectable model", async () => {
  const before = seen.filter((s) => s.url === "/tools/invoke" && JSON.parse(s.body).tool === "sessions").length;
  for (const [body, error] of [
    [{}, "bad_request"], [{ model: 42 }, "bad_request"], [{ model: "  " }, "bad_request"], [{ model: "x".repeat(201) }, "bad_request"],
    [{ model: "openai/gpt-x" }, "unknown_model"], [{ model: "echo" }, "unknown_model"], [{ model: "mock/echo3" }, "unknown_model"],
    [{ model: "mock/down" }, "model_unavailable"], [{ model: "mock/locked" }, "model_not_selectable"],
  ]) {
    const r = await post("/model", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, error, JSON.stringify(body));
  }
  const after = seen.filter((s) => s.url === "/tools/invoke" && JSON.parse(s.body).tool === "sessions").length;
  assert.equal(after, before, "nothing invalid reached the engine");
  // listed, but the engine's own policy refuses it: still a 400, not a 502
  const refused = await post("/model", { model: "mock/policy" });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error, "rejected");
  assert.deepEqual(otherPatched, []);
});

test("thinking: only levels the CURRENT model offers; 'default' clears; app session only", async () => {
  appSession = freshSession();
  rpc.length = 0;
  const r = await post("/thinking", { level: "high", sessionKey: "agent:main:main" });
  assert.equal(r.status, 200);
  assert.deepEqual(rpc.filter((c) => c.method === "sessions.patch").map((c) => c.params), [{ key: APP_SESSION_KEY, thinkingLevel: "high" }]);
  assert.equal((await call("/model")).json.thinking.effective, "high");
  assert.equal((await post("/thinking", { level: "default" })).status, 200);
  assert.equal((await call("/model")).json.thinking.level, null);

  for (const [body, error] of [[{}, "bad_request"], [{ level: 3 }, "bad_request"], [{ level: "x".repeat(41) }, "bad_request"],
    [{ level: "ultra" }, "unsupported_level"], [{ level: "medium" }, "unsupported_level"]]) {
    const x = await post("/thinking", body);
    assert.equal(x.status, 400, JSON.stringify(body));
    assert.equal(x.json.error, error);
  }
  await post("/model", { model: "mock/echo2" }); // offers "off" only
  assert.equal((await post("/thinking", { level: "high" })).json.error, "unsupported_level");
  await post("/model", { model: "default" });
  assert.ok(rpc.filter((c) => c.method === "sessions.patch").every((c) => c.params.key === APP_SESSION_KEY));
  assert.deepEqual(otherPatched, []);
});

test("fast: 'on' only when the current model supports fast mode; off/default always allowed; app session only", async () => {
  appSession = freshSession();
  rpc.length = 0;
  const no = await post("/fast", { mode: "on" });
  assert.equal(no.status, 400);
  assert.equal(no.json.error, "fast_mode_unsupported");
  assert.equal(rpc.filter((c) => c.method === "sessions.patch").length, 0);
  for (const body of [{}, { mode: true }, { mode: "auto" }, { mode: "turbo" }]) assert.equal((await post("/fast", body)).json.error, "bad_request", JSON.stringify(body));

  await post("/model", { model: "xai/grok-3" });
  assert.equal((await call("/model")).json.fast.supported, true);
  const on = await post("/fast", { mode: "on", sessionKey: "agent:main:main" });
  assert.equal(on.status, 200);
  assert.deepEqual((await call("/model")).json.fast, { supported: true, enabled: true, source: "session" });
  assert.equal((await post("/fast", { mode: "off" })).status, 200);
  assert.equal((await post("/fast", { mode: "default" })).status, 200);
  assert.deepEqual(rpc.filter((c) => c.method === "sessions.patch").map((c) => c.params),
    [{ key: APP_SESSION_KEY, fastMode: true }, { key: APP_SESSION_KEY, fastMode: false }, { key: APP_SESSION_KEY, fastMode: null }]);
  await post("/model", { model: "default" });
  assert.deepEqual(otherPatched, []);
});

test("history: assistant messages carry provider/model, and a model switch carries its fallback record", async () => {
  const r = await call(`/history?key=${encodeURIComponent(APP_SESSION_KEY)}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.messages, [
    { role: "user", text: "مرحبا", at: 10 },
    { role: "assistant", text: "Model switched from mock/echo to mock/echo2 (server_error).", at: 11, provider: "openclaw", model: "delivery-mirror",
      fallback: { from: "mock/echo", to: "mock/echo2", reason: "server_error" } },
    { role: "assistant", text: "رد", at: 12, provider: "mock", model: "echo2" },
  ]);
  assert.ok(!JSON.stringify(r.json).includes("secret-id"));
});

test("model routes answer 503 when the wrapper gives the bridge no gatewayCall", async () => {
  const b = base.replace("/app/v1", "/nocall/v1");
  for (const [m, p] of [["GET", "/models"], ["GET", "/model"], ["POST", "/model"], ["POST", "/thinking"], ["POST", "/fast"]]) {
    const r = await fetch(b + p, { method: m, headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined });
    assert.equal(r.status, 503, p);
  }
});

test("an engine outage is a 502, never a crash or a leaked error", async () => {
  const app = express();
  app.use("/x", createAppBridge({ token: APP_TOKEN, gatewayUrl: gwUrl, gatewayToken: GW_TOKEN, configPath: path.join(dir, "openclaw.json"),
    gatewayCall: async () => { throw new Error("spawn openclaw ENOENT /secret/path"); } }));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  try {
    for (const [m, p, body] of [["GET", "/models"], ["GET", "/model"], ["POST", "/model", { model: "mock/echo" }], ["POST", "/thinking", { level: "low" }], ["POST", "/fast", { mode: "off" }]]) {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}/x${p}`, { method: m, headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      assert.equal(r.status, 502, p);
      assert.deepEqual(await r.json(), { ok: false, error: "engine_unavailable" });
    }
  } finally { srv.close(); }
});

test("model helpers", () => {
  assert.equal(modelRef("mock", "echo"), "mock/echo");
  assert.equal(modelRef("openrouter", "anthropic/claude"), "openrouter/anthropic/claude");
  assert.equal(modelRef("mock", "mock/echo"), "mock/echo");
  assert.equal(modelRef("mock", ""), null);
  assert.equal(safeStr("a\u0000b\nc"), "abc");
  assert.equal(safeStr({ x: 1 }), null);
  assert.equal(mapModel({ provider: "p" }), null);
  assert.deepEqual(mapModel({ id: "m", provider: "p", available: true, thinkingLevels: ["off", { id: "low" }, 7] }).thinkingLevels, ["off", "low"]);
});

// ── review fixes (M) ──────────────────────────────────────────────────────
test("a 'restored' notice (primary back) is never reported as a fallback", () => {
  const restored = { openclawDeliveryMirror: { kind: "model-fallback", phase: "restored", fromModel: "mock/echo2", toModel: "mock/echo", reason: null } };
  assert.equal(assistantMeta(restored).fallback, undefined);
  const fell = { openclawDeliveryMirror: { kind: "model-fallback", fromModel: "mock/echo", toModel: "mock/echo2", reason: "server_error" } };
  assert.deepEqual(assistantMeta(fell).fallback, { from: "mock/echo", to: "mock/echo2", reason: "server_error" });
});

test("model source: the owner's pin vs OpenClaw's automatic fallback pin", async () => {
  appSession = { ...freshSession(), modelProvider: "mock", model: "echo2", modelOverrideSource: "auto" };
  assert.equal((await call("/model")).json.model.source, "fallback");
  appSession.modelOverrideSource = "user";
  assert.equal((await call("/model")).json.model.source, "override");
  appSession.modelOverrideSource = "inherited";
  assert.equal((await call("/model")).json.model.source, "default");
});

test("switching model clears a thinking level / fast mode the new model does not offer, and says so", async () => {
  appSession = { ...freshSession(), modelProvider: "xai", model: "grok-3", thinkingLevels: LEVELS["xai/grok-3"], thinkingLevel: "high",
    effectiveFastMode: true, effectiveFastModeSource: "session" };
  let r = await post("/model", { model: "mock/echo2" }); // echo2: levels ["off"], no fast mode
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.reset, { thinking: true, fast: true });
  assert.equal(appSession.thinkingLevel, undefined);
  assert.equal(appSession.effectiveFastMode, false);
  appSession.thinkingLevel = "off";
  r = await post("/model", { model: "mock/echo" }); // echo offers "off": kept
  assert.deepEqual(r.json.reset, { thinking: false, fast: false });
  assert.equal(appSession.thinkingLevel, "off");
  assert.deepEqual(otherPatched, []);
});

test("unknown /app/v1 paths end in the bridge (JSON 404), never at the gateway proxy", async () => {
  const before = seen.length;
  const r = await call("/no-such-route");
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { ok: false, error: "not_found" });
  assert.equal(seen.length, before, "nothing forwarded");
  assert.equal((await call("/no-such-route", { token: "wrong" })).status, 401, "auth still comes first");
});

test("a gateway refusal of a patch is 'rejected' (400), not an engine outage", async () => {
  const refusing = express();
  refusing.use(express.json());
  refusing.use("/app/v1", createAppBridge({ token: APP_TOKEN, gatewayUrl: gwUrl, gatewayToken: GW_TOKEN, configPath: "/nonexistent",
    gatewayCall: async (method, params) => {
      if (method === "sessions.patch") { const e = new Error("gateway call sessions.patch failed (invalid_request)"); e.refused = true; throw e; }
      return fakeGatewayCall(method, params);
    } }));
  const srv = refusing.listen(0);
  try {
    appSession = freshSession();
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/app/v1/thinking`, { method: "POST",
      headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ level: "high" }) });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { ok: false, error: "rejected" });
  } finally { srv.close(); }
});

test("no setting changes while a turn is running (it would be overwritten when the turn saves the session)", async () => {
  appSession = { ...freshSession(), hasActiveRun: true };
  for (const [p, body] of [["/model", { model: "mock/echo2" }], ["/thinking", { level: "high" }], ["/fast", { mode: "off" }]]) {
    const r = await post(p, body);
    assert.equal(r.status, 409, p);
    assert.deepEqual(r.json, { ok: false, error: "busy" });
  }
  assert.equal(appSession.thinkingLevel, undefined);
  assert.equal(appSession.model, "echo");
  appSession.hasActiveRun = false;
  assert.equal((await post("/thinking", { level: "high" })).status, 200);
});

test("a delayed reset re-check never undoes a newer write made meanwhile", async () => {
  appSession = { ...freshSession(), modelProvider: "xai", model: "grok-3", thinkingLevels: LEVELS["xai/grok-3"], thinkingLevel: "high" };
  const first = post("/model", { model: "mock/echo2" }); // echo2 has no "high": cleared, then re-checked ~1.5 s later
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await post("/model", { model: "mock/echo" })).status, 200);
  assert.equal((await post("/thinking", { level: "high" })).status, 200); // valid for echo
  assert.equal((await first).status, 200);
  assert.equal(appSession.thinkingLevel, "high", "the newer level survives the first request's re-check");
});

// ── concurrency: two devices, and a message started during a change ─────────
test("two devices at once: a model switch and a thinking change never interleave into an unsupported level", async () => {
  appSession = freshSession(); // echo: levels off/low/high
  patchDelay = 40;
  const [a, b] = await Promise.all([post("/model", { model: "mock/echo2" }), post("/thinking", { level: "high" })]); // echo2: levels off only
  patchDelay = 0;
  assert.equal(a.status, 200);
  assert.ok(b.status === 400 && b.json.error === "unsupported_level", `the level is judged against the model it would land on (${b.status})`);
  assert.equal(appSession.model, "echo2");
  assert.ok(appSession.thinkingLevel === undefined || LEVELS["mock/echo2"].includes(appSession.thinkingLevel));
  // the other order: the level first, then the switch clears it
  appSession = freshSession();
  patchDelay = 40;
  const [c, d] = await Promise.all([post("/thinking", { level: "high" }), post("/model", { model: "mock/echo2" })]);
  patchDelay = 0;
  assert.equal(c.status, 200);
  assert.deepEqual(d.json.reset, { thinking: true, fast: false });
  assert.equal(appSession.thinkingLevel, undefined);
});

test("two devices at once: fast on + switch to a model without it ends consistent, whatever the order", async () => {
  appSession = { ...freshSession(), modelProvider: "xai", model: "grok-3", thinkingLevels: LEVELS["xai/grok-3"] };
  patchDelay = 30;
  const [f, m] = await Promise.all([post("/fast", { mode: "on" }), post("/model", { model: "mock/echo" })]);
  patchDelay = 0;
  assert.equal(f.status, 200);
  assert.equal(m.status, 200);
  assert.equal(appSession.model, "echo");
  assert.equal(appSession.effectiveFastMode, false, "echo has no fast mode: the later switch cleared it");
});

test("a message sent while a model change is in flight starts only after the change — never mid-change", async () => {
  appSession = freshSession();
  timeline.length = 0;
  patchDelay = 80; // the reset patch after the switch is slow
  appSession = { ...freshSession(), thinkingLevel: "high" };
  const change = post("/model", { model: "mock/echo2" }); // will reset "high" (slow patch)
  await new Promise((r) => setTimeout(r, 10));
  const sent = await call("/send", { method: "POST", body: { message: "أثناء التبديل" } });
  assert.equal(sent.status, 202);
  assert.equal((await change).status, 200);
  await waitRun(sent.json.runId);
  patchDelay = 0;
  const iModel = timeline.indexOf("model:mock/echo2"), iReset = timeline.indexOf("patch:thinkingLevel"), iTurn = timeline.indexOf("turn");
  assert.ok(iModel >= 0 && iReset > iModel && iTurn > iReset, `order: ${timeline.join(" → ")}`);
});

test("a change while this bridge's own turn is starting is refused (even before the engine flags the run)", async () => {
  appSession = { ...freshSession(), hasActiveRun: false }; // the engine has not flagged it yet
  let open;
  chatGate = new Promise((r) => (open = r));
  const sent = await call("/send", { method: "POST", body: { message: "طويلة" } });
  await new Promise((r) => setTimeout(r, 20));
  const r = await post("/model", { model: "mock/echo2" });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { ok: false, error: "busy" });
  open(); chatGate = null;
  await waitRun(sent.json.runId);
  assert.equal(appSession.model, "echo", "nothing changed mid-turn");
  assert.equal((await post("/model", { model: "mock/echo2" })).status, 200, "allowed once the turn is over");
});
