// BASHT app bridge: the voice identity guard, POST /speak v2 (link RPC, guard states, error mapping) and the GET /status additions.
// A FAKE link and a FAKE fetch stand in for the gateway; temp config files; synthetic secrets only. Nothing here talks to a provider.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { APP_SESSION_KEY, createAppBridge } from "./app-bridge.js";
import { FEATURES, REASONS, SPEAK_STATES, canonicalize, evaluateVoiceGuard, mergeDeep, normalizeSpeechProviderId, prefsPathFor, identityHash, isSecretKey, readVoiceGuard, speakStatus, stripSecrets, voiceIdentity } from "./app-bridge-voice.js";

const CONTRACT = JSON.parse(fs.readFileSync(new URL("./fixtures/voice-contract.json", import.meta.url), "utf8"));
const APP_TOKEN = "synthetic-app-token-0123456789abcdef0123";
const GW_TOKEN = "synthetic-gateway-token-0123456789abcdef";
const SECRET_INSTRUCTIONS = "synthetic-private-instructions-do-not-leak";
const FAKE_KEY = "sk-synthetic-key-must-never-appear";

/** The approved voice, as in the agent block. */
const voiceBlock = (extra = {}) => ({ provider: "openai", providers: { openai: { model: "synthetic-model", speakerVoice: "synthetic-voice", instructions: SECRET_INSTRUCTIONS, ...extra } } });
const cfgWith = ({ agent, global } = {}) => ({ ...(agent ? { agents: { entries: { main: { tts: agent } } } } : {}), ...(global ? { tts: global } : {}) });

// ---------------------------------------------------------------- the guard (pure) --------------------------------------------------

test("guard: every state", () => {
  assert.equal(evaluateVoiceGuard(cfgWith({ agent: voiceBlock(), global: voiceBlock() })).state, "match");
  assert.equal(evaluateVoiceGuard(cfgWith({ agent: voiceBlock() })).state, "no_global");
  assert.equal(evaluateVoiceGuard(cfgWith({ agent: voiceBlock(), global: {} })).state, "no_global", "an empty global block is no global block");
  assert.equal(evaluateVoiceGuard(cfgWith({ agent: voiceBlock(), global: { auto: "off" } })).state, "no_global", "a global block without a provider names no voice");
  assert.equal(evaluateVoiceGuard(cfgWith({ agent: voiceBlock(), global: voiceBlock({ speakerVoice: "other" }) })).state, "mismatch");
  assert.equal(evaluateVoiceGuard(cfgWith({ global: voiceBlock() })).state, "global_only");
  assert.equal(evaluateVoiceGuard(cfgWith({})).state, "no_agent_block");
  assert.equal(evaluateVoiceGuard({ agents: { entries: { main: { tts: { voice: "x" } } } }, tts: { auto: "off" } }).state, "no_agent_block", "no provider anywhere");
  assert.equal(evaluateVoiceGuard(null).state, "unknown");
  assert.equal(evaluateVoiceGuard([]).state, "unknown");
  assert.equal(evaluateVoiceGuard("x").state, "unknown");
  assert.deepEqual(evaluateVoiceGuard(undefined), { state: "unknown", warnings: [] });
});

test("guard: a mismatch is any difference in provider, model, voice or instructions; key order does not matter", () => {
  const base = voiceBlock();
  const states = (global) => evaluateVoiceGuard(cfgWith({ agent: base, global })).state;
  assert.equal(states(voiceBlock({ model: "another-model" })), "mismatch");
  assert.equal(states(voiceBlock({ speakerVoice: "another-voice" })), "mismatch");
  assert.equal(states(voiceBlock({ instructions: `${SECRET_INSTRUCTIONS} ` })), "mismatch");
  assert.equal(states(voiceBlock({ instructions: undefined })), "mismatch");
  // the agent's effective block is global + agent: an extra setting in the GLOBAL block is inherited by the agent, so both speak the same
  assert.equal(states(voiceBlock({ extraSetting: 1 })), "match");
  // ... while an extra setting only in the AGENT block is not in what tts.speak would use
  assert.equal(evaluateVoiceGuard(cfgWith({ agent: voiceBlock({ extraSetting: 1 }), global: voiceBlock() })).state, "mismatch");
  assert.equal(states({ provider: "elevenlabs", providers: { elevenlabs: base.providers.openai } }), "mismatch");
  assert.equal(states({ provider: "openai", providers: {} }), "mismatch", "a provider without its settings is the default voice");
  assert.equal(states({ provider: "openai" }), "mismatch");
  // the same identity written in another key order
  const shuffled = { providers: { openai: { instructions: SECRET_INSTRUCTIONS, speakerVoice: "synthetic-voice", model: "synthetic-model" } }, provider: "openai" };
  assert.equal(states(shuffled), "match");
  // settings of a provider that is NOT the selected one are not part of the identity
  assert.equal(states({ ...shuffled, providers: { ...shuffled.providers, elevenlabs: { voiceId: "unrelated" } } }), "match");
  assert.equal(states({ ...shuffled, provider: " openai " }), "match");
});

test("guard: secret-looking keys are removed before comparing, hashing and logging", () => {
  const secrets = { apiKey: FAKE_KEY, api_key: FAKE_KEY, token: FAKE_KEY, secret: FAKE_KEY, password: FAKE_KEY, key: FAKE_KEY, accessKey: FAKE_KEY,
    authToken: FAKE_KEY, clientSecret: FAKE_KEY, authorization: `Bearer ${FAKE_KEY}`, Authorization: FAKE_KEY, headers: { "x-api-key": FAKE_KEY }, credentials: { a: FAKE_KEY } };
  for (const k of Object.keys(secrets)) assert.ok(isSecretKey(k), k);
  for (const k of ["model", "speakerVoice", "instructions", "voice", "voiceId", "baseUrl", "speed", "language", "maxTokens", "stability"]) assert.ok(!isSecretKey(k), k);
  // a different key on each side is not a different voice
  const a = evaluateVoiceGuard(cfgWith({ agent: voiceBlock({ apiKey: "sk-a" }), global: voiceBlock({ apiKey: "sk-b", headers: { x: 1 } }) }));
  assert.equal(a.state, "match");
  const b = evaluateVoiceGuard(cfgWith({ agent: voiceBlock(secrets), global: voiceBlock() }));
  assert.equal(b.state, "match");
  assert.equal(b.hash, evaluateVoiceGuard(cfgWith({ agent: voiceBlock(), global: voiceBlock() })).hash, "the hash does not depend on keys");
  assert.ok(!JSON.stringify(b).includes(FAKE_KEY));
  // nested secrets go too
  assert.deepEqual(stripSecrets({ a: { b: 1, token: "t", c: [{ secret: "s", d: 2 }] } }), { a: { b: 1, c: [{ d: 2 }] } });
  assert.deepEqual(voiceIdentity({ provider: "p", providers: { p: { model: "m", apiKey: "k" } } }), { provider: "p", providerConfig: { model: "m" } });
  assert.equal(voiceIdentity({ providers: { p: {} } }), null);
  assert.equal(voiceIdentity(null), null);
});

test("guard: the result carries a state, a short hash and warning codes — never text, instructions or keys", () => {
  const r = evaluateVoiceGuard(cfgWith({ agent: voiceBlock({ apiKey: FAKE_KEY }), global: voiceBlock({ apiKey: FAKE_KEY }) }));
  assert.deepEqual(Object.keys(r).sort(), ["hash", "provider", "state", "warnings"]);
  assert.match(r.hash, /^[0-9a-f]{12}$/);
  const blob = JSON.stringify(r);
  for (const leak of [SECRET_INSTRUCTIONS, FAKE_KEY, "synthetic-voice", "synthetic-model"]) assert.ok(!blob.includes(leak), leak);
  const m = evaluateVoiceGuard(cfgWith({ agent: voiceBlock(), global: voiceBlock({ model: "x" }) }));
  assert.match(m.hash, /^[0-9a-f]{12}$/);
  assert.match(m.globalHash, /^[0-9a-f]{12}$/);
  assert.notEqual(m.hash, m.globalHash);
  assert.equal(evaluateVoiceGuard(cfgWith({ global: voiceBlock() })).hash, identityHash(voiceIdentity(voiceBlock())), "global_only reports the global identity");
  assert.equal(canonicalize({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test("guard: warnings (never a block) for `auto` other than off and for prefsPath on the global block", () => {
  const w = (global) => evaluateVoiceGuard(cfgWith({ agent: voiceBlock(), global: { ...voiceBlock(), ...global } }));
  assert.deepEqual(w({}).warnings, []);
  assert.deepEqual(w({ auto: "off" }).warnings, []);
  assert.deepEqual(w({ auto: " OFF " }).warnings, []);
  assert.deepEqual(w({ auto: false }).warnings, []);
  for (const auto of ["always", "inbound", "tagged", true, 1]) assert.deepEqual(w({ auto }).warnings, ["global_auto_enabled"], String(auto));
  assert.deepEqual(w({ prefsPath: "/some/where.json" }).warnings, ["global_prefs_path"]);
  assert.deepEqual(w({ auto: "always", prefsPath: "x" }).warnings, ["global_auto_enabled", "global_prefs_path"]);
  assert.equal(w({ auto: "always" }).state, "match", "a warning does not change the state");
  assert.ok(!JSON.stringify(w({ prefsPath: "/some/where.json" })).includes("/some/where"));
});

test("guard: an unreadable, missing or malformed config is state unknown; a fresh read every time", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-guard-"));
  try {
    const f = path.join(dir, "openclaw.json");
    assert.deepEqual(readVoiceGuard(f), { state: "unknown", warnings: [] }, "missing");
    fs.writeFileSync(f, "{ not json");
    assert.equal(readVoiceGuard(f).state, "unknown", "malformed");
    fs.writeFileSync(f, JSON.stringify(cfgWith({ agent: voiceBlock() })));
    assert.equal(readVoiceGuard(f).state, "no_global");
    fs.writeFileSync(f, JSON.stringify(cfgWith({ agent: voiceBlock(), global: voiceBlock() })));
    assert.equal(readVoiceGuard(f).state, "match", "the operator's edit applies without a restart");
    assert.equal(readVoiceGuard(dir).state, "unknown", "a directory is not a config");
    assert.equal(readVoiceGuard(undefined).state, "unknown");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("speakStatus: the voice state shown on /status", () => {
  const g = (state) => ({ state, warnings: [] });
  assert.deepEqual(speakStatus(g("match"), { linkUp: true }), { speak: "ready" });
  assert.deepEqual(speakStatus(g("global_only"), { linkUp: true }), { speak: "degraded", reason: "tool_path_only" }, "no agent block to compare with: tool path only");
  assert.deepEqual(speakStatus(g("match"), { linkUp: false }), { speak: "degraded", reason: "link_down" });
  assert.deepEqual(speakStatus(g("no_global"), { linkUp: true }), { speak: "degraded", reason: "tool_path_only" });
  assert.deepEqual(speakStatus(g("no_global"), { linkUp: false, toolPath: false }), { speak: "unconfigured", reason: "tool_path_unavailable" });
  assert.deepEqual(speakStatus(g("mismatch"), { linkUp: true }), { speak: "mismatch", reason: "identity_mismatch" });
  assert.deepEqual(speakStatus(g("no_agent_block"), { linkUp: true }), { speak: "unconfigured", reason: "no_tts_config" });
  assert.deepEqual(speakStatus(g("unknown"), { linkUp: true }), { speak: "unknown", reason: "config_unreadable" });
  assert.deepEqual(speakStatus(undefined), { speak: "unknown", reason: "config_unreadable" });
});

// ---------------------------------------------------------------- POST /speak ---------------------------------------------------------

let dir, configPath, stateDir, speechDir;
const EMITTED = new Set(); // every `reason` a bridge in this file logged or showed on /status (checked against the contract at the end)
const MP3 = Buffer.concat([Buffer.from("ID3"), crypto.randomBytes(3000)]);
const setConfig = (cfg) => fs.writeFileSync(configPath, typeof cfg === "string" ? cfg : JSON.stringify(cfg));

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-bridge-voice-"));
  configPath = path.join(dir, "openclaw.json");
  stateDir = path.join(dir, "state");
  speechDir = path.join(stateDir, "media", "tool-speech-synthesis");
  fs.mkdirSync(speechDir, { recursive: true });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A link that records every request and answers with `impl`. */
function fakeLink({ up = true, impl, version = null } = {}) {
  const calls = [];
  const link = {
    up,
    calls,
    impl: impl ?? (async () => ({ audioBase64: MP3.toString("base64"), provider: "openai", outputFormat: "mp3", mimeType: "audio/mpeg", fileExtension: ".mp3" })),
    isUp() { return this.up; },
    status() { return { state: this.up ? "up" : "down", since: 0, lastUpAt: null, reconnects: 0, lastError: null, pendingApprovals: 0 }; },
    serverVersion: () => version,
    setDecorator() {},
    request(method, params, opts) { calls.push({ method, params, opts }); return this.impl(method, params, opts); },
  };
  return link;
}
const ok = (over = {}) => async () => ({ audioBase64: MP3.toString("base64"), provider: "openai", outputFormat: "mp3", mimeType: "audio/mpeg", fileExtension: ".mp3", ...over });

/** The tool path's gateway, faked: records what was asked. */
function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    const r = await handler(body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
const noFetch = () => fakeFetch(() => { throw new Error("the tool path must not be used"); });

async function mount(opts = {}) {
  const lines = [];
  const log = { warn: (_t, m) => { lines.push(String(m)); const r = /\((\w+)\)$/.exec(String(m)); if (r) EMITTED.add(r[1]); }, info: (_t, m) => lines.push(String(m)) };
  const app = express();
  app.use("/v", createAppBridge({ token: APP_TOKEN, gatewayUrl: "http://127.0.0.1:9", gatewayToken: GW_TOKEN, configPath, stateDir, log, ...opts }));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const b = `http://127.0.0.1:${srv.address().port}/v`;
  const post = (body, { token = APP_TOKEN } = {}) => fetch(`${b}/speak`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = (p) => fetch(`${b}${p}`, { headers: { authorization: `Bearer ${APP_TOKEN}` } }).then(async (r) => {
    const json = await r.json();
    if (json?.voice?.reason) EMITTED.add(json.voice.reason);
    return { status: r.status, json };
  });
  return { b, post, get, lines, close: () => srv.close() };
}

const MATCH = cfgWith({ agent: voiceBlock(), global: voiceBlock() });

test("speak (match): one tts.speak on the link with {text} only and a 60 s timeout; the bytes come back; no tool path, no CLI", async () => {
  setConfig(MATCH);
  const link = fakeLink();
  const fetchImpl = noFetch();
  const gatewayCall = () => { throw new Error("the CLI path must not be used"); };
  const m = await mount({ link, fetchImpl, gatewayCall });
  try {
    const r = await m.post({ text: "  **مرحبا** يا صفوان  ", sessionKey: "agent:main:main", voice: "alloy", provider: "elevenlabs", model: "x", instructions: "y" });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "audio/mpeg");
    assert.equal(r.headers.get("content-length"), String(MP3.length));
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(MP3));
    assert.deepEqual(link.calls, [{ method: "tts.speak", params: { text: "**مرحبا** يا صفوان" }, opts: { timeoutMs: 60_000 } }]);
    assert.equal(fetchImpl.calls.length, 0);
  } finally { m.close(); }
});

test("speak (global_only, no agent block): NOT the link path — the legacy tool path, like no_global", async () => {
  setConfig(cfgWith({ global: voiceBlock() }));
  const link = fakeLink();
  const fetchImpl = fakeFetch(async () => ({ status: 404, json: { ok: false, error: { type: "not_found", message: "Tool not available: tts" } } }));
  const m = await mount({ link, fetchImpl });
  try {
    const r = await m.post({ text: "مرحبا" });
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { ok: false, error: "voice_unavailable", reason: "tool_denied" });
    assert.equal(link.calls.length, 0, "the link was not used");
    assert.equal(fetchImpl.calls.length, 1, "the tool was");
  } finally { m.close(); }
});

test("speak (mismatch): 503 voice_unavailable/identity_mismatch, and NOTHING is called (no link request, no tool, no provider)", async () => {
  setConfig(cfgWith({ agent: voiceBlock(), global: voiceBlock({ speakerVoice: "some-other-voice" }) }));
  const link = fakeLink();
  const fetchImpl = noFetch();
  const m = await mount({ link, fetchImpl });
  try {
    const r = await m.post({ text: "مرحبا" });
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { ok: false, error: "voice_unavailable", reason: "identity_mismatch" });
    assert.equal(link.calls.length, 0);
    assert.equal(fetchImpl.calls.length, 0);
    assert.deepEqual(m.lines, ["speak refused: voice_unavailable (identity_mismatch)"]);
  } finally { m.close(); }
});

test("speak (no_agent_block): 503 voice_unavailable/unconfigured, nothing called", async () => {
  setConfig(cfgWith({}));
  const link = fakeLink();
  const fetchImpl = noFetch();
  const m = await mount({ link, fetchImpl });
  try {
    const r = await m.post({ text: "مرحبا" });
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { ok: false, error: "voice_unavailable", reason: "unconfigured" });
    assert.equal(link.calls.length + fetchImpl.calls.length, 0);
  } finally { m.close(); }
});

test("speak (no_global, the situation before the config change): the existing tool path, unchanged; 404 = tool_denied, any tool refusal = provider_error", async () => {
  setConfig(cfgWith({ agent: voiceBlock() }));
  const link = fakeLink();
  let mode = "ok";
  const fetchImpl = fakeFetch(async () => {
    if (mode === "404") return { status: 404, json: { ok: false, error: { type: "not_found", message: "Tool not available: tts" } } };
    if (mode === "tool_error") return { status: 500, json: { ok: false, error: { type: "tool_error", message: "tool execution failed" } } };
    if (mode === "other") return { status: 502, json: { ok: false } };
    const audioPath = path.join(speechDir, `voice---${crypto.randomUUID()}.mp3`);
    fs.writeFileSync(audioPath, MP3);
    return { json: { ok: true, result: { details: { audioPath } } } };
  });
  const m = await mount({ link, fetchImpl });
  try {
    const good = await m.post({ text: "  **مرحبا**  " });
    assert.equal(good.status, 200);
    assert.ok(Buffer.from(await good.arrayBuffer()).equals(MP3));
    assert.deepEqual(fetchImpl.calls.map((c) => [c.url, c.body]), [["http://127.0.0.1:9/tools/invoke", { tool: "tts", args: { text: "**مرحبا**" }, sessionKey: APP_SESSION_KEY }]]);
    assert.equal(link.calls.length, 0, "the tool path does not use the link");
    for (const [x, status, reason] of [["404", 503, "tool_denied"], ["tool_error", 503, "provider_error"], ["other", 503, "provider_error"]]) {
      mode = x;
      const r = await m.post({ text: "مرحبا" });
      assert.equal(r.status, status, x);
      assert.deepEqual(await r.json(), { ok: false, error: "voice_unavailable", reason }, x);
    }
    assert.deepEqual(fs.readdirSync(speechDir), [], "no audio file is left behind");
  } finally { m.close(); }
});

test("speak (unknown config): the tool path as well; an engine that does not answer is 502 engine_unavailable", async () => {
  setConfig("{ broken");
  const link = fakeLink();
  const fetchImpl = async () => { throw new Error("connect ECONNREFUSED"); };
  const m = await mount({ link, fetchImpl });
  try {
    const r = await m.post({ text: "مرحبا" });
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { ok: false, error: "engine_unavailable", reason: "engine_error" });
    assert.equal(link.calls.length, 0);
  } finally { m.close(); }
  const noState = await mount({ link, fetchImpl, stateDir: undefined });
  try {
    const r = await noState.post({ text: "مرحبا" });
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { ok: false, error: "voice_unavailable", reason: "unconfigured" });
  } finally { noState.close(); }
});

test("speak (link path): link down = 502 engine_unavailable/link_down, with NO fallback to the tool or the CLI", async () => {
  setConfig(MATCH);
  const fetchImpl = noFetch();
  const gatewayCall = () => { throw new Error("no CLI fallback"); };
  for (const link of [fakeLink({ up: false }), undefined]) {
    const m = await mount({ link, fetchImpl, gatewayCall });
    try {
      const r = await m.post({ text: "مرحبا" });
      assert.equal(r.status, 502);
      assert.deepEqual(await r.json(), { ok: false, error: "engine_unavailable", reason: "link_down" });
      assert.equal(link?.calls.length ?? 0, 0);
    } finally { m.close(); }
  }
  assert.equal(fetchImpl.calls.length, 0);
  // the link drops while the request is in flight
  const link = fakeLink({ impl: async () => { throw Object.assign(new Error("link_down"), { code: "link_down" }); } });
  const m = await mount({ link, fetchImpl, gatewayCall });
  try {
    const r = await m.post({ text: "مرحبا" });
    assert.deepEqual(await r.json(), { ok: false, error: "engine_unavailable", reason: "link_down" });
    assert.equal(link.calls.length, 1, "not retried");
  } finally { m.close(); }
});

test("speak (link path): gateway refusal = voice_unavailable/provider_error; timeout = 502 engine_unavailable/timeout; neither is ever retried", async () => {
  setConfig(MATCH);
  const cases = [
    [Object.assign(new Error("provider said no"), { code: "UNAVAILABLE", refused: true }), 503, { error: "voice_unavailable", reason: "provider_error" }],
    [Object.assign(new Error("tts.speak timed out"), { code: "timeout" }), 502, { error: "engine_unavailable", reason: "timeout" }],
    [Object.assign(new Error("tts.speak: params not allowed"), { code: "bad_params" }), 502, { error: "engine_unavailable", reason: "engine_error" }],
    [new Error("boom"), 502, { error: "engine_unavailable", reason: "engine_error" }],
  ];
  for (const [err, status, body] of cases) {
    const link = fakeLink({ impl: async () => { throw err; } });
    const m = await mount({ link, fetchImpl: noFetch() });
    try {
      const r = await m.post({ text: "مرحبا بك" });
      assert.equal(r.status, status, err.code ?? err.message);
      const text = await r.text();
      assert.deepEqual(JSON.parse(text), { ok: false, ...body });
      assert.ok(!text.includes("provider said no") && !text.includes("مرحبا"), "no engine text, no request text");
      assert.equal(link.calls.length, 1, "exactly one attempt");
      assert.ok(m.lines.every((l) => !l.includes("مرحبا") && !l.includes("provider said no")), JSON.stringify(m.lines));
    } finally { m.close(); }
  }
});

test("speak (link path): the audio is validated — non-empty, <= 8 MB, an allowed audio type; anything else is voice_unavailable/bad_audio", async () => {
  setConfig(MATCH);
  const good = MP3.toString("base64");
  const bad = [
    {}, { audioBase64: "" }, { audioBase64: 5 }, { audioBase64: null }, { audioBase64: [good] },
    { audioBase64: good, mimeType: undefined }, { audioBase64: good, mimeType: "" }, { audioBase64: good, mimeType: "text/html" },
    { audioBase64: good, mimeType: "audio/flac" }, { audioBase64: good, mimeType: "video/mp4" }, { audioBase64: good, mimeType: "application/octet-stream" },
    { audioBase64: good, mimeType: "audio/mpeg", fileExtension: ".exe" }, { audioBase64: good, mimeType: "audio/mpeg", fileExtension: ".html" },
    { audioBase64: Buffer.alloc(8 * 1024 * 1024 + 1, 1).toString("base64"), mimeType: "audio/mpeg" },
    { audioBase64: "A".repeat(20 * 1024 * 1024), mimeType: "audio/mpeg" },
  ];
  for (const raw of bad) {
    const payload = { provider: "openai", ...raw };
    const link = fakeLink({ impl: async () => payload });
    const m = await mount({ link, fetchImpl: noFetch() });
    try {
      const r = await m.post({ text: "مرحبا" });
      assert.equal(r.status, 503, JSON.stringify(payload).slice(0, 60));
      assert.deepEqual(await r.json(), { ok: false, error: "voice_unavailable", reason: "bad_audio" });
    } finally { m.close(); }
  }
  // the limit itself is allowed, and the allowed types map to the bridge's four content types
  const exactly = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(8 * 1024 * 1024 - 3, 7)]);
  for (const [mimeType, ext, type, bytes] of [["audio/mpeg", ".mp3", "audio/mpeg", MP3], ["audio/mp3", ".mp3", "audio/mpeg", MP3], ["AUDIO/MPEG; charset=x", undefined, "audio/mpeg", MP3],
    ["audio/ogg", ".ogg", "audio/ogg", MP3], ["audio/opus", ".opus", "audio/ogg", MP3], ["audio/wav", ".wav", "audio/wav", MP3], ["audio/x-wav", ".WAV", "audio/wav", MP3],
    ["audio/wave", undefined, "audio/wav", MP3], ["audio/mpeg", ".mp3", "audio/mpeg", exactly]]) {
    const link = fakeLink({ impl: ok({ mimeType, fileExtension: ext, audioBase64: bytes.toString("base64") }) });
    const m = await mount({ link, fetchImpl: noFetch() });
    try {
      const r = await m.post({ text: "مرحبا" });
      assert.equal(r.status, 200, `${mimeType} ${ext}`);
      assert.equal(r.headers.get("content-type"), type);
      const out = Buffer.from(await r.arrayBuffer());
      assert.equal(out.length, bytes.length);
      assert.equal(r.headers.get("content-length"), String(bytes.length));
    } finally { m.close(); }
  }
});

test("speak: validates the text before anything else; auth first; 30 a minute; at most 2 in flight (429 rate_limited with a reason)", async () => {
  setConfig(MATCH);
  let t = 1_000_000;
  const release = [];
  const link = fakeLink({ impl: () => new Promise((res) => release.push(() => res({ audioBase64: MP3.toString("base64"), mimeType: "audio/mpeg", provider: "openai" }))) });
  const m = await mount({ link, fetchImpl: noFetch(), now: () => t });
  try {
    assert.equal((await m.post({ text: "x" }, { token: null })).status, 401);
    assert.equal((await m.post({ text: "x" }, { token: GW_TOKEN })).status, 401);
    for (const body of [{}, { text: "" }, { text: "   " }, { text: 5 }, { text: "ا".repeat(1501) }]) {
      const r = await m.post(body);
      assert.equal(r.status, 400);
      assert.deepEqual(await r.json(), { ok: false, error: "bad_request" });
    }
    assert.equal(link.calls.length, 0);
    const a = m.post({ text: "one" });
    const b = m.post({ text: "two" });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(link.calls.length, 2);
    const c = await m.post({ text: "three" });
    assert.equal(c.status, 429);
    assert.deepEqual(await c.json(), { ok: false, error: "rate_limited", reason: "in_flight" });
    assert.equal(link.calls.length, 2, "the third never reached the engine");
    assert.ok(m.lines.includes("speak refused: rate_limited (in_flight)"));
    release.shift()(); release.shift()();
    assert.equal((await a).status, 200);
    assert.equal((await b).status, 200);
    // the slots are free again, even after a failure
    link.impl = async () => { throw new Error("boom"); };
    assert.equal((await m.post({ text: "four" })).status, 502);
    link.impl = ok();
    for (let i = 0; i < 26; i++) assert.equal((await m.post({ text: "x" })).status, 200, `request ${i}`); // 4 so far + 26 = 30 a minute
    const limited = await m.post({ text: "x" });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { ok: false, error: "rate_limited", reason: "per_minute" });
    t += 61_000;
    assert.equal((await m.post({ text: "x" })).status, 200);
  } finally { m.close(); }
});

test("speak: the request text never reaches the log; refusals log one line with the reason only", async () => {
  setConfig(cfgWith({ agent: voiceBlock(), global: voiceBlock({ model: "x" }) }));
  const m = await mount({ link: fakeLink(), fetchImpl: noFetch() });
  try {
    await m.post({ text: "نص سري للغاية" });
    await m.post({ text: "نص سري للغاية" });
    assert.equal(m.lines.length, 2);
    for (const l of m.lines) assert.match(l, /^speak refused: [a-z_]+ \([a-z_]+\)$/);
    assert.ok(!m.lines.join("\n").includes("سري"));
  } finally { m.close(); }
});

// ---------------------------------------------------------------- GET /status ---------------------------------------------------------

test("status: additive fixed fields — features, voice, runs, signing; engine version only when the link has it", async () => {
  setConfig(MATCH);
  const link = fakeLink({ version: "2026.11.10" });
  const m = await mount({ link, fetchImpl: noFetch() });
  try {
    const { status, json } = await m.get("/status");
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.appSession, APP_SESSION_KEY);
    assert.equal(json.link.state, "up", "existing fields stay");
    assert.deepEqual(json.features, CONTRACT.features);
    assert.deepEqual(json.voice, { speak: "ready", warnings: [] });
    assert.deepEqual(json.runs, { active: 0 });
    assert.deepEqual(json.signing, { mode: "off" });
    assert.deepEqual(json.engine, { version: "2026.11.10" });
    assert.deepEqual(Object.keys(json).sort(), ["appSession", "engine", "features", "link", "ok", "runs", "signing", "voice"]);
    assert.equal(link.calls.length, 0, "status makes no gateway call and no TTS call");
  } finally { m.close(); }
  const noVersion = await mount({ link: fakeLink(), fetchImpl: noFetch() });
  try {
    const { json } = await noVersion.get("/status");
    assert.ok(!("engine" in json));
  } finally { noVersion.close(); }
  const noLink = await mount({ fetchImpl: noFetch() });
  try {
    const { json } = await noLink.get("/status");
    assert.deepEqual(json.link, { state: "off" });
    assert.ok(!("engine" in json));
    assert.deepEqual(json.voice, { speak: "degraded", reason: "link_down", warnings: [] });
  } finally { noLink.close(); }
});

test("status: voice.speak follows the guard and the link", async () => {
  const fetchImpl = noFetch();
  const cases = [
    [MATCH, true, { speak: "ready" }],
    [MATCH, false, { speak: "degraded", reason: "link_down" }],
    [cfgWith({ global: voiceBlock() }), true, { speak: "degraded", reason: "tool_path_only" }],
    [cfgWith({ agent: voiceBlock() }), true, { speak: "degraded", reason: "tool_path_only" }],
    [cfgWith({ agent: voiceBlock(), global: voiceBlock({ model: "x" }) }), true, { speak: "mismatch", reason: "identity_mismatch" }],
    [cfgWith({}), true, { speak: "unconfigured", reason: "no_tts_config" }],
    ["{ nope", true, { speak: "unknown", reason: "config_unreadable" }],
  ];
  for (const [cfg, up, want] of cases) {
    setConfig(cfg);
    const link = fakeLink({ up });
    const m = await mount({ link, fetchImpl });
    try {
      const { json } = await m.get("/status");
      assert.deepEqual({ speak: json.voice.speak, ...(json.voice.reason ? { reason: json.voice.reason } : {}) }, want, JSON.stringify(cfg).slice(0, 50));
      assert.equal(link.calls.length, 0);
    } finally { m.close(); }
  }
  // warnings are reported as codes
  setConfig(cfgWith({ agent: voiceBlock(), global: { ...voiceBlock(), auto: "always", prefsPath: "/x" } }));
  const m = await mount({ link: fakeLink(), fetchImpl });
  try {
    const { json } = await m.get("/status");
    assert.deepEqual(json.voice, { speak: "ready", warnings: ["global_auto_enabled", "global_prefs_path"] });
    assert.ok(!JSON.stringify(json).includes(SECRET_INSTRUCTIONS));
  } finally { m.close(); }
});

test("status: runs.active counts the app turns running right now", async () => {
  setConfig(MATCH);
  const enc = new TextEncoder();
  let finish;
  const fetchImpl = async (_url, init) => new Response(new ReadableStream({
    start(c) {
      init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")), { once: true }); // a real fetch honours the abort
      c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "جارٍ" } }] })}\n\n`));
      finish = () => { try { c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } catch { /* already ended or aborted */ } };
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const m = await mount({ link: fakeLink(), fetchImpl });
  const auth = { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" };
  try {
    assert.equal((await m.get("/status")).json.runs.active, 0);
    const sent = await fetch(`${m.b}/send`, { method: "POST", headers: auth, body: JSON.stringify({ message: "ابدأ" }) });
    assert.equal(sent.status, 202);
    const { runId } = await sent.json();
    for (let i = 0; i < 100 && !finish; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await m.get("/status")).json.runs.active, 1);
    finish();
    for (let i = 0; i < 100; i++) {
      const r = (await m.get(`/runs/${runId}`)).json;
      if (r.status !== "running") break;
      await new Promise((x) => setTimeout(x, 10));
    }
    assert.equal((await m.get("/status")).json.runs.active, 0);
    // a stopped turn is not active either
    const again = await (await fetch(`${m.b}/send`, { method: "POST", headers: auth, body: JSON.stringify({ message: "ثانية" }) })).json();
    assert.equal((await m.get("/status")).json.runs.active, 1);
    await fetch(`${m.b}/runs/${again.runId}/stop`, { method: "POST", headers: auth });
    for (let i = 0; i < 100 && (await m.get("/status")).json.runs.active > 0; i++) await new Promise((x) => setTimeout(x, 10));
    assert.equal((await m.get("/status")).json.runs.active, 0);
  } finally { m.close(); finish?.(); }
});

// ---------------------------------------------------------------- C1: the gateway's real merge semantics --------------------------------

const guardState = (cfg, prefs) => evaluateVoiceGuard(cfg, prefs).state;
const agentOnly = (block) => cfgWith({ agent: block });

test("guard (C1): the agent's effective identity is merge(global, agent); the RPC uses the global block alone", () => {
  // legacy top-level shape: the agent changes the voice and adds instructions on top of a global alloy voice
  assert.equal(guardState({ tts: { provider: "openai", openai: { voice: "alloy" } }, agents: { entries: { main: { tts: { provider: "openai", openai: { voice: "nova", instructions: "BASHT" } } } } } }), "mismatch");
  assert.equal(guardState({ tts: { provider: "openai", openai: { voice: "nova", instructions: "BASHT" } }, agents: { entries: { main: { tts: { provider: "openai" } } } } }), "match", "the agent inherits everything from global");
  // provider id written in another case: normalised like the gateway; a difference in the settings is still a mismatch
  assert.equal(guardState({ tts: { provider: "OpenAI", providers: { openai: { voice: "alloy" } } }, agents: { entries: { main: { tts: { provider: "OpenAI", providers: { openai: { voice: "nova" } } } } } } }), "mismatch");
  assert.equal(guardState({ tts: { provider: "OpenAI", providers: { OPENAI: { voice: "nova" } } }, agents: { entries: { main: { tts: { provider: " openai ", providers: { openai: { voice: "nova" } } } } } } }), "match");
  // an agent block WITHOUT a provider, that changes the provider's voice
  assert.equal(guardState({ tts: { provider: "openai", providers: { openai: { voice: "alloy" } } }, agents: { entries: { main: { tts: { providers: { openai: { voice: "nova" } } } } } } }), "mismatch");
  assert.equal(guardState({ tts: { provider: "openai", providers: { openai: { voice: "nova" } } }, agents: { entries: { main: { tts: { providers: { openai: { voice: "nova" } } } } } } }), "match");
  assert.equal(guardState({ tts: { provider: "openai", providers: { openai: { voice: "nova" } } }, agents: { entries: { main: { tts: { auto: "off" } } } } }), "match", "an agent block with no voice setting at all");
  // legacy on one side, providers[] on the other, same settings: the same voice (providers[p] first, then the legacy entry)
  assert.equal(guardState({ tts: { provider: "openai", openai: { voice: "nova" } }, agents: { entries: { main: { tts: { providers: { openai: { voice: "nova" } } } } } } }), "match");
  // the agent selects another provider
  assert.equal(guardState({ tts: { provider: "openai", providers: { openai: { voice: "nova" } } }, agents: { entries: { main: { tts: { provider: "elevenlabs" } } } } }), "mismatch");
  // the voice aliases are unified like the gateway does (voice == speakerVoice == voiceName)
  assert.equal(guardState({ tts: { provider: "openai", providers: { openai: { voice: "nova" } } }, agents: { entries: { main: { tts: { provider: "openai", providers: { openai: { speakerVoice: "nova" } } } } } } }), "match");
  assert.equal(guardState({ tts: { provider: "openai", providers: { openai: { voiceName: "nova" } } }, agents: { entries: { main: { tts: { provider: "openai", providers: { openai: { speakerVoice: "alloy" } } } } } } }), "mismatch");
});

test("guard (C1): provider ids — trim, lower-case, edge = microsoft; an id that is not a plain canonical token or is a registry alias fails closed", () => {
  assert.equal(normalizeSpeechProviderId(" OpenAI "), "openai");
  assert.equal(normalizeSpeechProviderId("Edge"), "microsoft");
  for (const bad of [undefined, null, "", "  ", 5, "__proto__", "constructor", "prototype"]) assert.equal(normalizeSpeechProviderId(bad), undefined, String(bad));
  const same = (provider) => cfgWith({ agent: { provider, providers: { [provider]: { voice: "v" } } }, global: { provider, providers: { [provider]: { voice: "v" } } } });
  assert.equal(guardState(same("openai")), "match");
  assert.equal(guardState(cfgWith({ agent: { provider: "edge", providers: { edge: { voice: "v" } } }, global: { provider: "microsoft", providers: { microsoft: { voice: "v" } } } })), "match", "edge is microsoft");
  for (const id of ["azure", "cli", "open ai", "../x", "https://openrouter.ai/v1", "a".repeat(80), "ünï", "x/y"]) assert.equal(guardState(same(id)), "mismatch", id);
  assert.equal(mergeDeep({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2] }).a.b, 1);
  assert.deepEqual(mergeDeep({ a: { b: 1 } }, { a: { c: 3 }, d: [2], e: undefined }), { a: { b: 1, c: 3 }, d: [2] });
  assert.deepEqual(mergeDeep({ a: 1 }, JSON.parse('{"__proto__": {"x": 1}, "b": 2}')), { a: 1, b: 2 }, "blocked keys never merge");
});

test("guard (C1): personas — a global persona is a mismatch; an agent persona that carries anything but label/description is a mismatch", () => {
  const base = voiceBlock();
  const withGlobal = (extra) => cfgWith({ agent: base, global: { ...voiceBlock(), ...extra } });
  assert.equal(guardState(withGlobal({})), "match");
  assert.equal(guardState(withGlobal({ persona: "" })), "match", "an empty persona is none");
  assert.equal(guardState(withGlobal({ personas: {} })), "match");
  assert.equal(guardState(withGlobal({ persona: "warm" })), "mismatch");
  assert.equal(guardState(withGlobal({ personas: { warm: { label: "Warm" } } })), "mismatch", "any global persona differs from what was approved");
  assert.equal(guardState(withGlobal({ persona: "x", personas: { x: { provider: "elevenlabs" } } })), "mismatch");
  assert.equal(guardState(withGlobal({ persona: "x", personas: { x: { providers: { openai: { speakerVoice: "other" } } } } })), "mismatch", "a global persona that changes the voice");
  const agentWith = (persona) => cfgWith({ agent: { ...base, ...persona }, global: voiceBlock() });
  assert.equal(guardState(agentWith({ persona: "warm", personas: { warm: { label: "Warm", description: "friendly" } } })), "match", "label/description never reach the provider request");
  for (const extra of [{ providers: { openai: { speakerVoice: "other" } } }, { voice: "x" }, { model: "m" }, { instructions: "i" }, { provider: "elevenlabs" }, { prompt: "p" }, { fallbackPolicy: "none" }]) {
    assert.equal(guardState(agentWith({ persona: "warm", personas: { warm: { label: "Warm", ...extra } } })), "mismatch", Object.keys(extra)[0]);
  }
  assert.equal(guardState(agentWith({ personas: { other: { instructions: "i" } } })), "mismatch", "an unselected persona could be selected from the preferences file");
  assert.equal(guardState(agentWith({ personas: { warm: "text" } })), "mismatch", "not an object: fail closed");
});

// ---------------------------------------------------------------- I2: the preferences file --------------------------------------------

test("guard (I2): a preferences file that sets another provider or a persona is a mismatch; the same provider is a warning only; no content leaks", () => {
  const cfg = cfgWith({ agent: voiceBlock(), global: voiceBlock() });
  const withPrefs = (prefs) => evaluateVoiceGuard(cfg, { agentPrefs: prefs, globalPrefs: prefs });
  assert.equal(withPrefs({}).state, "match");
  assert.deepEqual(withPrefs({}).warnings, []);
  assert.equal(withPrefs({ tts: { provider: "elevenlabs" } }).state, "mismatch");
  assert.equal(withPrefs({ tts: { provider: "ELEVENLABS " } }).state, "mismatch");
  assert.equal(withPrefs({ tts: { persona: "warm" } }).state, "mismatch", "a persona the config does not define is not 'no persona'");
  const p = withPrefs({ tts: { provider: "OpenAI" } });
  assert.equal(p.state, "match", "the same provider changes nothing");
  assert.deepEqual(p.warnings, ["prefs_file_overrides"]);
  assert.deepEqual(withPrefs({ tts: { auto: "always" } }).warnings, ["prefs_file_overrides"]);
  assert.deepEqual(withPrefs({ tts: { enabled: true } }).warnings, ["prefs_file_overrides"]);
  assert.deepEqual(withPrefs({ tts: { auto: "off", maxLength: 500 } }).warnings, []);
  assert.deepEqual(withPrefs(null).warnings, []);
  // only one side's file is different: still a mismatch
  assert.equal(evaluateVoiceGuard(cfg, { agentPrefs: {}, globalPrefs: { tts: { provider: "elevenlabs" } } }).state, "mismatch");
  assert.equal(evaluateVoiceGuard(cfg, { agentPrefs: { tts: { provider: "elevenlabs" } }, globalPrefs: {} }).state, "mismatch");
  // a persona the config defines with label/description only is harmless
  const labelled = cfgWith({ agent: { ...voiceBlock(), personas: { warm: { label: "Warm" } } }, global: voiceBlock() });
  const sameFile = { tts: { persona: "Warm" } }; // the gateway reads ONE file for both sides: the RPC side does not define that persona
  assert.equal(evaluateVoiceGuard(labelled, { agentPrefs: sameFile, globalPrefs: sameFile }).state, "mismatch");
  assert.equal(evaluateVoiceGuard(labelled, { agentPrefs: { tts: { persona: "warm" } }, globalPrefs: {} }).state, "match");
  assert.ok(!JSON.stringify(p).includes("elevenlabs"));
});

test("guard (I2): the file is found where the gateway reads it (config prefsPath, env OPENCLAW_TTS_PREFS, <state dir>/settings/tts.json), read-only, missing or broken = none", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-prefs-"));
  try {
    const state = path.join(root, "state");
    fs.mkdirSync(path.join(state, "settings"), { recursive: true });
    const cfgFile = path.join(root, "openclaw.json");
    const write = (cfg) => fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    const base = cfgWith({ agent: voiceBlock(), global: voiceBlock() });
    write(base);
    assert.equal(readVoiceGuard(cfgFile, { stateDir: state, env: {} }).state, "match", "no prefs file");
    const defaultFile = path.join(state, "settings", "tts.json");
    fs.writeFileSync(defaultFile, JSON.stringify({ tts: { provider: "elevenlabs", maxLength: 1500 } }));
    const g = readVoiceGuard(cfgFile, { stateDir: state, env: {} });
    assert.equal(g.state, "mismatch", "the default location");
    assert.ok(!JSON.stringify(g).includes(defaultFile) && !JSON.stringify(g).includes("elevenlabs"));
    fs.writeFileSync(defaultFile, "{ not json");
    assert.equal(readVoiceGuard(cfgFile, { stateDir: state, env: {} }).state, "match", "unreadable = the gateway uses its configured defaults too");
    fs.writeFileSync(defaultFile, JSON.stringify({ tts: { persona: "x" } }));
    // the env variable takes the place of the default location
    const envFile = path.join(root, "elsewhere.json");
    fs.writeFileSync(envFile, JSON.stringify({ tts: { auto: "off" } }));
    assert.equal(readVoiceGuard(cfgFile, { stateDir: state, env: { OPENCLAW_TTS_PREFS: envFile } }).state, "match");
    // a config prefsPath beats the env variable
    const cfgFileFile = path.join(root, "cfg-prefs.json");
    fs.writeFileSync(cfgFileFile, JSON.stringify({ tts: { provider: "elevenlabs" } }));
    write({ ...base, tts: { ...base.tts, prefsPath: cfgFileFile } });
    const w = readVoiceGuard(cfgFile, { stateDir: state, env: { OPENCLAW_TTS_PREFS: envFile } });
    assert.equal(w.state, "mismatch");
    assert.ok(w.warnings.includes("global_prefs_path"));
    // the guard only reads: the files are as they were
    assert.equal(fs.readFileSync(cfgFileFile, "utf8"), JSON.stringify({ tts: { provider: "elevenlabs" } }));
    assert.equal(prefsPathFor({}, { env: {}, stateDir: "/s" }), path.join("/s", "settings", "tts.json"));
    assert.equal(prefsPathFor({}, { env: { OPENCLAW_TTS_PREFS: "/e/p.json" }, stateDir: "/s" }), "/e/p.json");
    assert.equal(prefsPathFor({ prefsPath: "/c/p.json" }, { env: { OPENCLAW_TTS_PREFS: "/e/p.json" }, stateDir: "/s" }), "/c/p.json");
    assert.equal(prefsPathFor({}, { env: {} }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("speak (I2): a preferences file that overrides the provider makes /speak refuse with identity_mismatch (nothing is called)", async () => {
  setConfig(MATCH);
  fs.mkdirSync(path.join(stateDir, "settings"), { recursive: true });
  const prefs = path.join(stateDir, "settings", "tts.json");
  fs.writeFileSync(prefs, JSON.stringify({ tts: { provider: "elevenlabs" } }));
  const link = fakeLink();
  const m = await mount({ link, fetchImpl: noFetch() });
  try {
    const r = await m.post({ text: "مرحبا" });
    assert.deepEqual(await r.json(), { ok: false, error: "voice_unavailable", reason: "identity_mismatch" });
    assert.equal(link.calls.length, 0);
    const st = (await m.get("/status")).json.voice;
    assert.deepEqual([st.speak, st.reason], ["mismatch", "identity_mismatch"]);
    assert.deepEqual(st.warnings, ["prefs_file_overrides"]);
  } finally { m.close(); fs.rmSync(path.join(stateDir, "settings"), { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- C2: the provider that actually spoke ---------------------------------

test("speak (C2): audio from another provider than the approved one is refused, with no audio returned", async () => {
  setConfig(MATCH);
  for (const provider of ["elevenlabs", "microsoft", "", undefined, null, 5, "openai-compatible"]) {
    const link = fakeLink({ impl: ok({ provider }) });
    const m = await mount({ link, fetchImpl: noFetch() });
    try {
      const r = await m.post({ text: "مرحبا" });
      assert.equal(r.status, 503, String(provider));
      const body = await r.text();
      assert.deepEqual(JSON.parse(body), { ok: false, error: "voice_unavailable", reason: "identity_mismatch" });
      assert.ok(!body.includes("ID3"));
      assert.equal(link.calls.length, 1, "one attempt, never retried");
      assert.deepEqual(m.lines, ["speak refused: voice_unavailable (identity_mismatch)"]);
    } finally { m.close(); }
  }
  // the approved provider, written in any case the gateway might answer with, is fine
  for (const provider of ["openai", "OpenAI", " openai "]) {
    const m = await mount({ link: fakeLink({ impl: ok({ provider }) }), fetchImpl: noFetch() });
    try { assert.equal((await m.post({ text: "مرحبا" })).status, 200, provider); } finally { m.close(); }
  }
  // edge is microsoft on both sides
  setConfig(cfgWith({ agent: { provider: "edge", providers: { edge: { voice: "v" } } }, global: { provider: "Edge", providers: { edge: { voice: "v" } } } }));
  const m = await mount({ link: fakeLink({ impl: ok({ provider: "microsoft" }) }), fetchImpl: noFetch() });
  try { assert.equal((await m.post({ text: "مرحبا" })).status, 200); } finally { m.close(); }
  assert.equal(readVoiceGuard(configPath).provider, "microsoft");
});

// ---------------------------------------------------------------- I4: the shared contract ----------------------------------------------

test("speak (I4): the gateway rejecting the text (INVALID_REQUEST) is 400 bad_request/text_rejected, not a missing voice", async () => {
  setConfig(MATCH);
  const link = fakeLink({ impl: async () => { throw Object.assign(new Error("tts.speak text too long"), { code: "INVALID_REQUEST", refused: true }); } });
  const m = await mount({ link, fetchImpl: noFetch() });
  try {
    const r = await m.post({ text: "مرحبا" });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { ok: false, error: "bad_request", reason: "text_rejected" });
    assert.equal(link.calls.length, 1);
  } finally { m.close(); }
});

test("contract: reasons, speak states and features are exactly the shared fixture (src/fixtures/voice-contract.json)", () => {
  assert.deepEqual([...Object.values(REASONS)].sort(), [...CONTRACT.reasons].sort(), "the code's reason constants and the fixture agree both ways");
  assert.deepEqual([...SPEAK_STATES], CONTRACT.speakStates);
  assert.deepEqual([...FEATURES], CONTRACT.features);
  assert.equal(new Set(Object.values(REASONS)).size, Object.values(REASONS).length);
  // no reason is written as a string literal in the code that emits it: every one goes through REASONS
  for (const f of ["./app-bridge.js", "./app-bridge-voice.js"]) {
    const src = fs.readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(!/refuseSpeak\(res, \d+, "[a-z_]+", "/.test(src), `${f}: a literal reason passed to refuseSpeak`);
    for (const m of src.matchAll(/\breason: "([a-z_]+)"/g)) assert.ok(CONTRACT.reasons.includes(m[1]), `${f}: literal reason ${m[1]}`);
  }
  // every `error` code the contract's consumers already know is untouched
  for (const r of CONTRACT.reasons) assert.match(r, /^[a-z_]+$/);
});

test("contract: every reason this file's bridges logged or showed on /status is in the fixture (and the main ones were really emitted)", () => {
  assert.ok(EMITTED.size >= 8, [...EMITTED].join());
  for (const r of EMITTED) assert.ok(CONTRACT.reasons.includes(r), `emitted a reason outside the contract: ${r}`);
  for (const r of ["identity_mismatch", "unconfigured", "link_down", "timeout", "provider_error", "bad_audio", "engine_error", "in_flight", "per_minute",
    "text_rejected", "tool_denied", "tool_path_only", "no_tts_config", "config_unreadable"]) assert.ok(EMITTED.has(r), `never emitted: ${r}`);
});
