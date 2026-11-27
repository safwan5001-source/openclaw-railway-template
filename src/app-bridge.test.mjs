// BASHT app bridge: auth, the read allowlist, owner-only conversations, and one owner turn at a time in the app session.
// A FAKE gateway (in this file) stands in for OpenClaw; loopback only, synthetic tokens, temp config.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { APP_SESSION, APP_SESSION_KEY, MAX_AUDIO_BYTES, assistantMeta, capConcurrency, createAppBridge, isReadable, mainIsOwnerOnly, mapModel, messageText, modelRef, parseTranscribeOutput, readPolicyFromConfig, safeStr } from "./app-bridge.js";

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
  if (method === "sessions.describe") return { session: params.key === APP_SESSION_KEY ? { ...appSession } : null }; // a snapshot, as the real CLI returns
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

let gateway, gwUrl, server, base, dir, stateDir, speechDir;
// ---- fake voice: the `tts` tool writes one mp3 into the state dir; the injected transcriber reads the bridge's temp file ----
const SPEECH = Buffer.concat([Buffer.from("ID3"), crypto.randomBytes(4000)]);
const ttsCalls = [];
let ttsMode = "ok";   // ok | refuse | not_allowed | path (returns ttsTarget as the audioPath)
let ttsTarget = null;
const transcribed = []; // { file, mode, bytes } as the fake transcriber saw them
let transcribeImpl = async () => "  نص الملاحظة  ";
async function fakeTranscribe(file) {
  const st = fs.statSync(file);
  transcribed.push({ file, mode: st.mode & 0o777, dirMode: fs.statSync(path.dirname(file)).mode & 0o777, bytes: fs.readFileSync(file) });
  return transcribeImpl(file);
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-bridge-"));
  stateDir = path.join(dir, "state");
  speechDir = path.join(stateDir, "media", "tool-speech-synthesis");
  fs.mkdirSync(speechDir, { recursive: true });
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
        if (tool === "tts") {
          ttsCalls.push({ args, sessionKey: JSON.parse(body).sessionKey ?? null });
          if (ttsMode === "refuse") { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: { type: "tool_error", message: "tool execution failed" } })); }
          if (ttsMode === "not_allowed") { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: { type: "not_found", message: "Tool not available: tts" } })); }
          const audioPath = ttsMode === "ok" ? path.join(speechDir, `voice---${crypto.randomUUID()}.mp3`) : ttsTarget;
          if (ttsMode === "ok") fs.writeFileSync(audioPath, SPEECH);
          return res.end(JSON.stringify({ ok: true, result: { content: [{ type: "text", text: "(spoken)" }], details: { audioPath, provider: "openai", media: { mediaUrl: audioPath } } } }));
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
    gatewayCall: fakeGatewayCall, now: () => Date.now() + clockOffset, stateDir, transcribe: fakeTranscribe }));
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
  // review L9: the key is parsed exactly — extra segments or a group marker never pass on a trailing owner number
  for (const key of [`agent:main:whatsapp:direct:+966511111111:${OWNER}`, `agent:main:whatsapp:group:direct:${OWNER}`,
    `agent:main:whatsapp:default:x:direct:${OWNER}`, `agent:main:whatsapp:direct:${OWNER}:x`, `agent:main:whatsappx:direct:${OWNER}`]) {
    assert.equal(isReadable({ key }, [OWNER]), false, key);
  }
  assert.equal(isReadable({ key: "agent:main:main" }, [OWNER]), false, "main is not readable unless proven owner-only");
  assert.equal(isReadable({ key: "agent:main:main" }, [OWNER], true), true);
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
  assert.ok(r.json.messages.every((m) => Array.isArray(m.media) && m.media.length === 0)); // B2: every row carries `media` (and `id`)
  assert.deepEqual(r.json.messages.map(({ id: _id, media: _media, ...m }) => m), [
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
  appSession.modelOverrideSource = "user"; clockOffset += 3_000; // the engine changed it on its own: seen once the short read cache expires
  assert.equal((await call("/model")).json.model.source, "override");
  appSession.modelOverrideSource = "inherited"; clockOffset += 3_000;
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

// ---------------------------------------------------------------- security review fixes (L6, L9) ----------------------------------------------------------------

test("L9: the main session is readable only while it can hold nobody else's messages", () => {
  const owners = [OWNER];
  assert.equal(mainIsOwnerOnly({}, owners), true, "no channel at all: only the Control UI writes there");
  assert.equal(mainIsOwnerOnly({ session: { dmScope: "per-channel-peer" }, channels: { whatsapp: { dmPolicy: "open" } } }, owners), true, "DMs split per peer");
  assert.equal(mainIsOwnerOnly({ channels: { whatsapp: { dmPolicy: "pairing" } } }, owners), false, "default dmScope + pairing: other senders merge into main");
  assert.equal(mainIsOwnerOnly({ session: { dmScope: "main" }, channels: { whatsapp: { dmPolicy: "allowlist", allowFrom: [OWNER, "+966511111111"] } } }, owners), false);
  assert.equal(mainIsOwnerOnly({ channels: { whatsapp: { dmPolicy: "allowlist", allowFrom: ["whatsapp:966500000001"] } } }, owners), true, "owner-only allowlist");
  assert.equal(mainIsOwnerOnly({ channels: { whatsapp: { dmPolicy: "allowlist", allowFrom: [OWNER] }, telegram: { dmPolicy: "allowlist", allowFrom: ["123"] } } }, owners), false,
    "a second DM channel cannot be proven owner-only");
  assert.equal(mainIsOwnerOnly({ channels: { whatsapp: { dmPolicy: "allowlist", allowFrom: [OWNER] }, discord: { enabled: false, dmPolicy: "open" } } }, owners), true);
  assert.equal(mainIsOwnerOnly({ channels: { whatsapp: { dmPolicy: "allowlist", allowFrom: [] } } }, owners), false);
  assert.equal(mainIsOwnerOnly(null, owners), true);
  const f = path.join(os.tmpdir(), `bridge-policy-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify({ commands: { ownerAllowFrom: [`whatsapp:${OWNER}`] }, channels: { whatsapp: { dmPolicy: "pairing" } } }));
  try { assert.deepEqual(readPolicyFromConfig(f), { owners: [OWNER], mainReadable: false }); } finally { fs.rmSync(f, { force: true }); }
  assert.deepEqual(readPolicyFromConfig("/nonexistent/openclaw.json"), { owners: [], mainReadable: false }, "unreadable config fails closed");
});

test("L9: with other senders admitted, main is neither listed nor readable", async () => {
  const cfgPath = path.join(dir, "openclaw.json");
  const original = fs.readFileSync(cfgPath, "utf8");
  fs.writeFileSync(cfgPath, JSON.stringify({ commands: { ownerAllowFrom: [`whatsapp:${OWNER}`] }, channels: { whatsapp: { dmPolicy: "pairing" } } }));
  try {
    assert.deepEqual((await call("/sessions")).json.sessions.map((s) => s.key), [`agent:main:whatsapp:direct:${OWNER}`, APP_SESSION_KEY]);
    assert.equal((await call(`/history?key=${encodeURIComponent("agent:main:main")}`)).status, 404);
  } finally { fs.writeFileSync(cfgPath, original); }
});

test("L6: GET /model shares one sessions.describe for a few seconds; a write makes the next read fresh", async () => {
  appSession = freshSession();
  rpc.length = 0;
  const describes = () => rpc.filter((c) => c.method === "sessions.describe").length;
  await Promise.all(Array.from({ length: 10 }, () => call("/model")));
  assert.equal(describes(), 1, "ten concurrent reads, one CLI call");
  await call("/model");
  assert.equal(describes(), 1, "a read right after is served from the short cache");
  assert.equal((await post("/thinking", { level: "high" })).status, 200);
  const before = describes();
  assert.equal((await call("/model")).json.thinking.level, "high", "the read after a write is fresh");
  assert.equal(describes(), before + 1);
  clockOffset += 3_000;
  await call("/model");
  assert.equal(describes(), before + 2, "expires after the short window");
});

test("L6: a read taken while a settings write is in flight is not served from the cache after the write", async () => {
  appSession = freshSession();
  clockOffset += 3_000; // start past any earlier cached read
  patchDelay = 300;
  try {
    const write = post("/thinking", { level: "high" });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await call("/model")).json.thinking.level ?? null, appSession.thinkingLevel ?? null);
    assert.equal((await write).status, 200);
    assert.equal((await call("/model")).json.thinking.level, "high", "the first read after the write is fresh");
  } finally { patchDelay = 0; }
});

test("L6: gateway CLI calls are capped (2 at once, a bounded queue, the rest fail fast)", async () => {
  let active = 0, peak = 0;
  const release = [];
  const slow = capConcurrency(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => release.push(r)); active--; return "ok"; }, 2, 3);
  const calls = Array.from({ length: 5 }, () => slow());
  await assert.rejects(slow(), /queue full/);
  for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 5)); release.shift()?.(); }
  for (let i = 0; i < 5 && release.length; i++) { await new Promise((r) => setTimeout(r, 5)); release.shift()?.(); }
  assert.deepEqual(await Promise.all(calls), ["ok", "ok", "ok", "ok", "ok"]);
  assert.equal(peak, 2);
});

// ---------------------------------------------------------------- voice (V2 speak / V3 transcribe) ----------------------------------

const speak = (body, { token = APP_TOKEN, b = base } = {}) => fetch(`${b}/speak`, { method: "POST",
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: JSON.stringify(body) });
const upload = (bytes, type = "audio/webm", { token = APP_TOKEN, b = base } = {}) => fetch(`${b}/transcribe`, { method: "POST",
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(type ? { "content-type": type } : {}) }, body: bytes });
const AUDIO = Buffer.concat([Buffer.from("OggS"), crypto.randomBytes(3000)]);
const speechFiles = () => fs.readdirSync(speechDir);

/** A separate bridge on its own port (fresh rate limits / other options). */
async function mount(opts) {
  const app = express();
  app.use("/v", createAppBridge({ token: APP_TOKEN, gatewayUrl: gwUrl, gatewayToken: GW_TOKEN, configPath: path.join(dir, "openclaw.json"), ...opts }));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  return { b: `http://127.0.0.1:${srv.address().port}/v`, close: () => srv.close() };
}

test("speak: needs the app token", async () => {
  assert.equal((await speak({ text: "مرحبا" }, { token: null })).status, 401);
  assert.equal((await speak({ text: "مرحبا" }, { token: GW_TOKEN })).status, 401);
});

test("speak: BASHT's own voice — the tts tool on the app session; the caller cannot pick session, voice or provider", async () => {
  ttsMode = "ok"; ttsCalls.length = 0;
  const r = await speak({ text: "  **مرحبا** يا صفوان  ", sessionKey: "agent:main:main", voice: "alloy", provider: "elevenlabs", model: "x" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/mpeg");
  assert.equal(r.headers.get("content-length"), String(SPEECH.length));
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(SPEECH));
  assert.deepEqual(ttsCalls, [{ args: { text: "**مرحبا** يا صفوان" }, sessionKey: APP_SESSION_KEY }]);
  assert.equal(seen.at(-1).auth, `Bearer ${GW_TOKEN}`);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(speechFiles(), [], "the one-shot audio file is deleted after it was sent");
});

test("speak: validates the text (1..1500 chars) before calling the engine", async () => {
  ttsCalls.length = 0;
  for (const body of [{}, { text: "" }, { text: "   " }, { text: 5 }, { text: ["x"] }, { text: "ا".repeat(1501) }]) {
    const r = await speak(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
    assert.deepEqual(await r.json(), { ok: false, error: "bad_request" });
  }
  assert.equal(ttsCalls.length, 0);
  assert.equal((await speak({ text: "ا".repeat(1500) })).status, 200);
});

test("speak: never reads or deletes a file outside the speech directory (traversal, symlink, wrong type)", async () => {
  const outside = path.join(dir, "secret.mp3");
  fs.writeFileSync(outside, "do not read");
  const link = path.join(speechDir, "voice---link.mp3");
  fs.symlinkSync(outside, link);
  const txt = path.join(speechDir, "notes.txt");
  fs.writeFileSync(txt, "not audio");
  ttsMode = "path";
  try {
    for (const target of [outside, path.join(speechDir, "..", "..", "..", "secret.mp3"), link, txt, speechDir, "relative.mp3", "", null]) {
      ttsTarget = target;
      const r = await speak({ text: "مرحبا" });
      assert.equal(r.status, 503, String(target));
      const body = await r.text();
      assert.deepEqual(JSON.parse(body), { ok: false, error: "voice_unavailable" });
      assert.ok(!body.includes("do not read"));
    }
    assert.equal(fs.readFileSync(outside, "utf8"), "do not read", "the outside file is untouched");
    assert.ok(fs.existsSync(link) && fs.existsSync(txt));
  } finally {
    ttsMode = "ok"; fs.rmSync(link, { force: true }); fs.rmSync(txt, { force: true }); fs.rmSync(outside, { force: true });
  }
});

test("speak: a tool refusal or a tool the policy does not allow is voice_unavailable (503); no engine is 502", async () => {
  for (const mode of ["refuse", "not_allowed"]) {
    ttsMode = mode;
    const r = await speak({ text: "مرحبا" });
    assert.equal(r.status, 503, mode);
    assert.deepEqual(await r.json(), { ok: false, error: "voice_unavailable" });
  }
  ttsMode = "ok";
  const down = await mount({ gatewayUrl: "http://127.0.0.1:9", stateDir });
  try {
    const r = await speak({ text: "مرحبا" }, { b: down.b });
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { ok: false, error: "engine_unavailable" });
  } finally { down.close(); }
});

test("voice routes answer 503 voice_unavailable when the wrapper gives no state dir / transcriber", async () => {
  const b = base.replace("/app/v1", "/nocall/v1");
  const s = await speak({ text: "مرحبا" }, { b });
  assert.equal(s.status, 503);
  assert.deepEqual(await s.json(), { ok: false, error: "voice_unavailable" });
  const t = await upload(AUDIO, "audio/webm", { b });
  assert.equal(t.status, 503);
  assert.deepEqual(await t.json(), { ok: false, error: "voice_unavailable" });
});

test("speak: rate limited (30 a minute)", async () => {
  let t = 0;
  const m = await mount({ stateDir, now: () => t });
  try {
    for (let i = 0; i < 30; i++) assert.equal((await speak({ text: "x" }, { b: m.b })).status, 200);
    assert.equal((await speak({ text: "x" }, { b: m.b })).status, 429);
    t += 61_000;
    assert.equal((await speak({ text: "x" }, { b: m.b })).status, 200);
  } finally { m.close(); }
});

test("transcribe: needs the app token", async () => {
  assert.equal((await upload(AUDIO, "audio/webm", { token: null })).status, 401);
  assert.equal((await upload(AUDIO, "audio/webm", { token: GW_TOKEN })).status, 401);
});

test("transcribe: a private temp file the bridge names, the engine's transcript back (trimmed), the file deleted", async () => {
  transcribed.length = 0;
  const r = await upload(AUDIO, "audio/webm;codecs=opus");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, text: "نص الملاحظة" });
  const [t] = transcribed;
  assert.ok(t.bytes.equals(AUDIO));
  assert.equal(t.mode, 0o600);
  assert.equal(t.dirMode, 0o700);
  assert.match(path.basename(t.file), /^note\.webm$/);
  assert.ok(t.file.startsWith(path.join(os.tmpdir(), "basht-voice-")));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!fs.existsSync(path.dirname(t.file)), "temp dir removed");
  // each allowed type keeps a matching extension (the transcriber sees the format by its name)
  for (const [type, ext] of [["audio/ogg", ".ogg"], ["audio/mp4", ".m4a"], ["audio/mpeg", ".mp3"], ["audio/wav", ".wav"], ["audio/x-m4a", ".m4a"]]) {
    assert.equal((await upload(AUDIO, type)).status, 200, type);
    assert.equal(path.extname(transcribed.at(-1).file), ext);
  }
});

test("transcribe: refuses other types, oversized and tiny audio before transcribing", async () => {
  transcribed.length = 0;
  for (const type of ["text/plain", "application/json", "application/octet-stream", "video/webm", "audio/aac", "", "audio/ogg/../x"]) {
    const r = await upload(AUDIO, type || null);
    assert.equal(r.status, 415, type);
    assert.deepEqual(await r.json(), { ok: false, error: "unsupported_audio" });
  }
  const big = await upload(Buffer.alloc(MAX_AUDIO_BYTES + 1, 1), "audio/webm");
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { ok: false, error: "too_large" });
  const tiny = await upload(Buffer.alloc(1023, 1), "audio/webm");
  assert.equal(tiny.status, 422);
  assert.deepEqual(await tiny.json(), { ok: false, error: "no_speech" });
  assert.equal(transcribed.length, 0, "nothing reached the transcriber");
});

test("transcribe: empty transcript is no_speech; a refusal is voice_unavailable; a crash is engine_unavailable; unreadable audio is unsupported_audio; files always removed", async () => {
  const cases = [
    [async () => "   ", 422, "no_speech"],
    [async () => { throw Object.assign(new Error("no audio model"), { refused: true }); }, 503, "voice_unavailable"],
    [async () => { throw new Error("spawn ENOENT /secret/path"); }, 502, "engine_unavailable"],
    [async () => { throw Object.assign(new Error("remux failed"), { badAudio: true }); }, 415, "unsupported_audio"],
  ];
  try {
    for (const [impl, status, error] of cases) {
      transcribeImpl = impl;
      const r = await upload(AUDIO, "audio/ogg");
      assert.equal(r.status, status, error);
      assert.deepEqual(await r.json(), { ok: false, error });
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(!fs.existsSync(path.dirname(transcribed.at(-1).file)), `temp dir removed (${error})`);
    }
    transcribeImpl = async () => "ب".repeat(9000);
    const long = await (await upload(AUDIO, "audio/ogg")).json();
    assert.equal(long.text.length, 8000, "capped to one sendable message");
  } finally { transcribeImpl = async () => "  نص الملاحظة  "; }
});

test("transcribe: rate limited, and at most two at once", async () => {
  let t = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const m = await mount({ now: () => t, transcribe: async () => { await gate; return "ok"; } });
  try {
    const a = upload(AUDIO, "audio/ogg", { b: m.b }), b = upload(AUDIO, "audio/ogg", { b: m.b });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await upload(AUDIO, "audio/ogg", { b: m.b })).status, 429, "a third concurrent upload waits for another try");
    release();
    assert.equal((await a).status, 200);
    assert.equal((await b).status, 200);
    for (let i = 3; i < 20; i++) assert.equal((await upload(AUDIO, "audio/ogg", { b: m.b })).status, 200);
    assert.equal((await upload(AUDIO, "audio/ogg", { b: m.b })).status, 429);
  } finally { m.close(); }
});

test("transcribe: uploads still arriving hold a slot — never more than two transcribers; aborted uploads free theirs (Codex review on #56)", async () => {
  let active = 0, peak = 0;
  const m = await mount({ transcribe: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 30)); active--; return "ok"; } });
  const u = new URL(`${m.b}/transcribe`);
  // an upload whose body is still arriving: headers sent, half the bytes written, the rest later
  const slow = () => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST",
      headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "audio/ogg", "content-length": AUDIO.length } });
    const done = new Promise((resolve) => { req.on("response", (r) => { r.resume(); r.on("end", () => resolve(r.statusCode)); }); req.on("error", () => resolve("aborted")); });
    req.write(AUDIO.subarray(0, 1000));
    return { finish: () => req.end(AUDIO.subarray(1000)), abort: () => req.destroy(), done };
  };
  try {
    const a = slow(), b = slow();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await upload(AUDIO, "audio/ogg", { b: m.b })).status, 429, "two uploads in progress already hold both slots");
    b.abort();
    await b.done;
    await new Promise((r) => setTimeout(r, 50));
    const c = upload(AUDIO, "audio/ogg", { b: m.b }); // the aborted upload's slot is free again
    a.finish();
    assert.equal(await a.done, 200);
    assert.equal((await c).status, 200);
    assert.ok(peak <= 2, `at most two transcribers at once (peak ${peak})`);
    assert.equal((await upload(Buffer.from("OggS"), "audio/ogg", { b: m.b })).status, 422); // a tiny body releases its slot too
    assert.equal((await upload(AUDIO, "audio/ogg", { b: m.b })).status, 200);
    assert.equal((await upload(AUDIO, "audio/ogg", { b: m.b })).status, 200);
  } finally { m.close(); }
});

test("transcribe: a late answer keeps its slot and its input until the subprocess finishes (Codex review on #56)", async () => {
  const waiting = [];
  const seen = [];
  const finish = () => waiting.shift()?.();
  const m = await mount({ transcribeTimeoutMs: 40, transcribe: async (file) => { await new Promise((r) => waiting.push(r)); seen.push(fs.existsSync(file)); return "late"; } });
  try {
    assert.equal((await upload(AUDIO, "audio/ogg", { b: m.b })).status, 502, "the app gets an answer at the deadline");
    const ok = upload(AUDIO, "audio/ogg", { b: m.b }); // the second slot
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await upload(AUDIO, "audio/ogg", { b: m.b })).status, 429, "the timed-out transcriber still holds its slot");
    finish(); // the timed-out first transcriber ends now
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, [true], "its input file still existed when it finished");
    // its slot is free now: a new upload is accepted (it too answers 502 at the deadline, not 429)
    assert.equal((await upload(AUDIO, "audio/ogg", { b: m.b })).status, 502);
    while (waiting.length) finish();
    await ok;
  } finally { m.close(); }
});

test("transcribe output parser: the CLI's JSON document, log lines before it skipped", () => {
  const doc = { ok: true, outputs: [{ text: "مرحبا" }] };
  assert.deepEqual(parseTranscribeOutput(JSON.stringify(doc, null, 2)), doc);
  assert.deepEqual(parseTranscribeOutput(`[media] warming up\n{x\n${JSON.stringify(doc)}`), doc);
  assert.equal(parseTranscribeOutput("not json"), null);
  assert.equal(parseTranscribeOutput(""), null);
  assert.equal(parseTranscribeOutput(undefined), null);
  assert.equal(parseTranscribeOutput("[1,2]"), null);
});
