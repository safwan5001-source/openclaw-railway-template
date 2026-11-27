// BASHT app bridge (C2 + C4): the ONLY surface the BASHT app (safwan-smart-assistant) uses to talk to this engine.
//
//   GET  /app/v1/status            -> { ok, appSession }
//   GET  /app/v1/sessions          -> the conversations the app may read (allowlist below), newest first
//   GET  /app/v1/history?key=...   -> one allowed conversation's messages (text only, no tool payloads)
//   POST /app/v1/send { message }  -> starts ONE owner turn in the app's own session; returns { runId } at once
//   GET  /app/v1/runs/:id          -> that turn's live text and status (the app polls it)
//   POST /app/v1/runs/:id/stop     -> stops that turn
//   GET  /app/v1/models            -> the models the agent may use (models.list, default view), cached 60 s
//   GET  /app/v1/model             -> the app session's model, thinking level, fast mode, usage, last fallback, last-run latency
//   POST /app/v1/model { model }   -> pins a listed, available model on the app session ("default" clears the pin)
//   POST /app/v1/thinking { level }-> sets a thinking level the current model offers ("default" clears it)
//   POST /app/v1/fast { mode }     -> "on" | "off" | "default"; "on" only when the current model supports fast mode
//   GET  /app/v1/events, /approvals, /approvals/history, POST /approvals/:id -> src/app-bridge-live.js (B0/B3, persistent link)
//   POST /app/v1/speak { text }    -> the text spoken in BASHT's own voice (the agent's `tts` config), as audio bytes
//   POST /app/v1/transcribe <audio>-> { text }: a voice note transcribed with the engine's own audio config (as on WhatsApp)
//
// Trust model
// - Off unless BASHT_APP_TOKEN (>= 32 chars) is set. The app holds only that token; it never sees OPENCLAW_GATEWAY_TOKEN
//   or SETUP_PASSWORD. The bridge calls the loopback gateway itself, with a FIXED set of operations:
//   `sessions_list` / `sessions_history` (read) and `/v1/chat/completions` on ONE session key (write). Nothing else.
// - Model control (M) adds, through an injected `gatewayCall` (the wrapper runs `openclaw gateway call`): `models.list`,
//   `sessions.describe` and `sessions.patch` (thinkingLevel / fastMode), and the `sessions` tool `patch` (model). Every
//   write targets APP_SESSION_KEY only, with values validated against what the engine itself listed. No config writes.
// - Voice (V2/V3): the `tts` tool on the app session (so `agents.entries.main.tts` — provider, voice, model, instructions — applies;
//   the caller never picks a voice, provider or session), and an injected `transcribe(filePath)` (the wrapper runs
//   `openclaw infer audio transcribe --agent main`). Audio files live only in private temp/state paths and are deleted after use.
// - The app is the owner's own client, so its turns are owner turns (same agent, same shared memory, same tool policy and
//   approval rules as the Control UI). They run in their own session (`app:owner`), separate from the WhatsApp chat.
// - Reads are limited to the owner's own conversations: the app session, the owner's direct WhatsApp chat(s) (owners from
//   commands.ownerAllowFrom; the key is parsed exactly) and the main session ONLY while it can hold nobody else's messages
//   (mainIsOwnerOnly: session.dmScope per peer, or every DM channel an owner-only allowlist). Group chats and other people's chats
//   are never listed or read. See docs/BASHT_APP_BRIDGE.md ("Which conversations the app can read").
// - A turn keeps running if the phone goes away: the bridge, not the phone, holds the upstream request.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { normalizeWhatsAppSender, whatsAppOwnersFrom } from "../patches/whatsapp-owner.mjs";
import { createLiveRoutes } from "./app-bridge-live.js";

export const APP_SESSION = "app:owner";
export const APP_SESSION_KEY = "agent:main:app:owner";
export const MAIN_SESSION_KEY = "agent:main:main";
export const MIN_TOKEN_LENGTH = 32;
export const MAX_MESSAGE_CHARS = 8000;
const MAX_RUNS_KEPT = 20;
const RUN_TIMEOUT_MS = 15 * 60_000;
const READ_TIMEOUT_MS = 15_000;
const AUTH_FAILURES_PER_MINUTE = 20;
const MAX_LIST_PAGES = 20; // up to 2000 sessions
const MODELS_CACHE_MS = 60_000;
const MAX_MODEL_REF = 200;
const FAST_MODES = { on: true, off: false, default: null };
const RESET_RECHECK_MS = 1500;
const DESCRIBE_CACHE_MS = 2500; // GET /model polling shares one sessions.describe (a CLI spawn) for this long; any write invalidates it
const GATEWAY_CONCURRENCY = 2;  // at most this many `openclaw gateway call` processes at once …
const GATEWAY_QUEUE_MAX = 16;   // … and this many waiting; beyond that a call fails fast (the engine, WhatsApp first, must not starve)
const PER_PEER_DM_SCOPES = new Set(["per-peer", "per-channel-peer", "per-account-channel-peer"]);
// agent:main:whatsapp:[<account>:]direct:<peer> — the optional account segment is never a chat-kind word ("group:direct:<x>")
const WHATSAPP_DIRECT_KEY = /^agent:main:whatsapp:(?:(?!(?:direct|group|channel|thread):)[^:]+:)?direct:([^:]+)$/i;
const APPROVAL_GRACE_MS = 60_000; // a turn waiting on an approval may run until that approval expires, plus this
const WATCH_MS = 20_000; // the app counts as "watching" a reply when it polled the bridge this recently
// ---- voice ----
export const MAX_SPEAK_CHARS = 1500; // the app splits longer replies on sentence boundaries (engine hard cap: tts.maxTextLength 4096)
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MIN_AUDIO_BYTES = 1024; // OpenClaw skips audio below 1 KB anyway
export const MAX_TRANSCRIPT_CHARS = MAX_MESSAGE_CHARS; // a transcript is sent as the owner's message
const MAX_SPEECH_BYTES = 8 * 1024 * 1024;
const SPEAK_TIMEOUT_MS = 60_000;
const TRANSCRIBE_TIMEOUT_MS = 95_000; // the wrapper kills its CLI at 90 s
const SPEAK_PER_MINUTE = 30;
const TRANSCRIBE_PER_MINUTE = 20;
const TRANSCRIBES_IN_FLIGHT = 2; // each one spawns the OpenClaw CLI
/** Recorded audio the app may upload: MIME (without parameters) -> the file extension the transcriber sees. */
export const AUDIO_TYPES = { "audio/ogg": ".ogg", "audio/webm": ".webm", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a",
  "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/wave": ".wav" };
/** Synthesized speech the bridge may return: file extension -> content type. */
const SPEECH_TYPES = { ".mp3": "audio/mpeg", ".opus": "audio/ogg", ".ogg": "audio/ogg", ".wav": "audio/wav" };

/** A short display string from an upstream value: strings only, control characters removed, capped. Else null. */
export function safeStr(v, max = 200) {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return s ? s.slice(0, max) : null;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v) => (typeof v === "boolean" ? v : null);

/** The selectable `provider/model` ref of a catalog row (an id that already carries its provider is kept as it is). */
export function modelRef(provider, id) {
  const p = safeStr(provider, MAX_MODEL_REF);
  const m = safeStr(id, MAX_MODEL_REF);
  if (!m) return null;
  return p && !m.startsWith(`${p}/`) ? `${p}/${m}` : m;
}

const levelIds = (levels) => (Array.isArray(levels) ? levels : [])
  .map((l) => safeStr(typeof l === "string" ? l : l?.id, 40)).filter(Boolean);

/** One models.list row in the bridge's fixed shape. Raw upstream objects never leave the bridge. */
export function mapModel(r) {
  const id = modelRef(r?.provider, r?.id);
  if (!id) return null;
  const available = r.available === true;
  const manualSelectionAllowed = r.manualSelectionAllowed !== false; // only capable clients receive the flag; the gateway re-checks policy on patch
  return {
    id, name: safeStr(r.name) ?? id, provider: safeStr(r.provider, 100), providerName: safeStr(r.providerName, 100),
    available, unavailableReason: safeStr(r.unavailableReason), unavailableUntil: num(r.unavailableUntil),
    contextWindow: num(r.contextWindow), reasoning: r.reasoning === true, thinkingLevels: levelIds(r.thinkingLevels),
    thinkingDefault: safeStr(r.thinkingDefault, 40), supportsFastMode: r.supportsFastMode === true, supportsTools: bool(r.supportsTools),
    input: (Array.isArray(r.input) ? r.input : []).map((x) => safeStr(x, 20)).filter(Boolean), recommended: r.recommended === true,
    selectable: available && manualSelectionAllowed,
  };
}

/** Provider/model of an assistant transcript message, plus the structured fallback record OpenClaw writes on a model switch. */
export function assistantMeta(m) {
  const out = { provider: safeStr(m?.provider, 100), model: safeStr(m?.model, MAX_MODEL_REF) };
  const fb = m?.openclawDeliveryMirror;
  // OpenClaw writes the same kind with phase "restored" when the selected model is back: that is not a fallback
  if (fb && fb.kind === "model-fallback" && fb.phase !== "restored") {
    out.fallback = { from: safeStr(fb.fromModel, MAX_MODEL_REF), to: safeStr(fb.toModel, MAX_MODEL_REF), reason: safeStr(fb.reason, 60) };
  }
  return out;
}

/** The JSON document of `openclaw infer audio transcribe --json` (stdout; any log lines before it are skipped). Else null. */
export function parseTranscribeOutput(stdout) {
  const s = String(stdout ?? "");
  for (const start of [0, ...[...s.matchAll(/^\{/gm)].map((m) => m.index)]) {
    try { const j = JSON.parse(s.slice(start)); if (j && typeof j === "object" && !Array.isArray(j)) return j; } catch { /* next candidate */ }
  }
  return null;
}

const isMirror = (m) => m?.provider === "openclaw" || m?.openclawDeliveryMirror != null;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Owners (+digits) from the gateway config, read fresh on each call (cheap; the file is small). Never throws. */
export function ownersFromConfig(configPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return whatsAppOwnersFrom(cfg?.commands?.ownerAllowFrom);
  } catch {
    return [];
  }
}

/**
 * Can the main session (`agent:main:main`) hold only the owner's own messages? With OpenClaw's default `session.dmScope` ("main")
 * every admitted direct-message sender lands in it, so it is readable only when DMs are split per peer, or when every configured
 * channel admits direct messages from owners only (dmPolicy "disabled", or "allowlist" whose entries are all owners — verifiable
 * for WhatsApp only). "pairing"/"open" or any other channel → not owner-only. Never throws (fails closed).
 */
export function mainIsOwnerOnly(cfg, owners) {
  try {
    if (PER_PEER_DM_SCOPES.has(String(cfg?.session?.dmScope ?? ""))) return true;
    const channels = cfg?.channels && typeof cfg.channels === "object" ? cfg.channels : {};
    return Object.entries(channels).every(([name, c]) => {
      if (!c || typeof c !== "object" || c.enabled === false || c.dmPolicy === "disabled") return true;
      if (name !== "whatsapp" || c.dmPolicy !== "allowlist" || !Array.isArray(c.allowFrom) || !c.allowFrom.length) return false;
      return c.allowFrom.every((e) => { const n = normalizeWhatsAppSender(e); return !!n && owners.includes(n); });
    });
  } catch {
    return false;
  }
}

/** What the app may read, from the gateway config (read fresh on each call; the file is small). Never throws. */
export function readPolicyFromConfig(configPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const owners = whatsAppOwnersFrom(cfg?.commands?.ownerAllowFrom);
    return { owners, mainReadable: mainIsOwnerOnly(cfg, owners) };
  } catch {
    return { owners: [], mainReadable: false };
  }
}

/** Is this session one the app may read? The app session, the owner's own direct WhatsApp chat(s), and main if owner-only. */
export function isReadable(row, owners, mainReadable = false) {
  const key = String(row?.key ?? "");
  if (key === APP_SESSION_KEY) return true;
  if (key === MAIN_SESSION_KEY) return mainReadable === true;
  const m = WHATSAPP_DIRECT_KEY.exec(key); // exact: no extra segments (e.g. …:direct:<other>:<owner>) and no group keys
  const digits = m ? m[1].replace(/\D/g, "") : "";
  return digits.length > 0 && owners.some((o) => o === `+${digits}`);
}

/** Text of one transcript message (text parts only — tool calls, thinking and images are not shown). */
export function messageText(m) {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
}

function sessionLabel(row) {
  if (row.key === APP_SESSION_KEY) return "التطبيق";
  if (row.key === MAIN_SESSION_KEY) return "الجلسة الرئيسية";
  if (String(row.key).includes(":whatsapp:")) return "واتساب";
  return String(row.label || row.title || row.key);
}

/** At most `max` calls of `fn` at once, up to `queueMax` waiting (first come, first served); more fail at once. */
export function capConcurrency(fn, max, queueMax) {
  let active = 0;
  const waiting = [];
  const next = () => { if (active < max && waiting.length) { active++; waiting.shift()(); } };
  return (...args) => {
    if (active >= max && waiting.length >= queueMax) return Promise.reject(new Error("gateway call queue full"));
    return new Promise((resolve) => { waiting.push(resolve); next(); })
      .then(() => fn(...args))
      .finally(() => { active--; next(); });
  };
}

/** Reads the SSE stream of /v1/chat/completions, calling onText with the growing text (the first call marks the first token). */
async function readCompletionStream(body, onText) {
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return text;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        if (j?.error) throw new Error(typeof j.error?.message === "string" ? j.error.message : "agent run failed");
        const delta = j?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) { text += delta; onText(text); }
      }
    }
  }
  return text;
}

/**
 * @param {{ token?: string, gatewayUrl: string, gatewayToken: string, configPath: string, log?: any,
 *           fetchImpl?: typeof fetch, now?: () => number,
 *           gatewayCall?: (method: "models.list" | "sessions.describe" | "sessions.patch", params: object) => Promise<any> }} opts
 *   gatewayCall: one gateway RPC as the wrapper (the wrapper injects `openclaw gateway call`); without it the model routes return 503.
 *   stateDir: OpenClaw's state dir; the `tts` tool writes its audio under <stateDir>/media/tool-speech-synthesis/. Without it /speak is 503.
 *   transcribe: (filePath) => Promise<string>, the wrapper's `openclaw infer audio transcribe`; it rejects with `.refused` when the CLI
 *     answered ok:false (no audio model, provider error), `.badAudio` when the recording cannot be read. Without it /transcribe is 503.
 * @param {ReturnType<import("./gateway-link.js").createGatewayLink>} [opts.link] the persistent gateway link (events, approvals,
 *   and the approval deadline that keeps a waiting turn alive); without it /events and /approvals* return 503 not_available.
 * @returns {import("express").Router | null} null when the bridge is not enabled
 */
export function createAppBridge({ token, gatewayUrl, gatewayToken, configPath, log, fetchImpl = fetch, now = Date.now, gatewayCall: rawGatewayCall, link,
  stateDir, transcribe }) {
  const appToken = String(token ?? "").trim();
  if (appToken.length < MIN_TOKEN_LENGTH) return null;
  const gatewayCall = rawGatewayCall ? capConcurrency(rawGatewayCall, GATEWAY_CONCURRENCY, GATEWAY_QUEUE_MAX) : undefined;
  const router = express.Router();
  const runs = new Map(); // runId -> { id, status, text, error, startedAt, firstTokenAt, finishedAt, abort }
  let failures = { windowStart: 0, count: 0 };
  // B4: a reply that finishes while the app was not polling (phone locked / app closed) is worth a push; /events is the server's
  // own poller, never the app on screen, so it does not count.
  let lastAppAt = 0;
  link?.setDecorator((e) => (e.type === "chat.final" || e.type === "chat.error" ? { ...e, seen: now() - lastAppAt < WATCH_MS } : e));

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "");
    // A valid token always passes: anonymous failures must never lock the owner's app out (they only slow down guessing).
    if (m && safeEqual(m[1].trim(), appToken)) {
      if (!req.path.startsWith("/events")) lastAppAt = now();
      return next();
    }
    const t = now();
    if (t - failures.windowStart > 60_000) failures = { windowStart: t, count: 0 };
    failures.count += 1;
    if (failures.count > AUTH_FAILURES_PER_MINUTE) return res.status(429).json({ ok: false, error: "rate_limited" });
    return res.status(401).json({ ok: false, error: "unauthorized" });
  });
  const jsonBody = express.json({ limit: "64kb" });
  router.use((req, res, next) => (req.path === "/transcribe" ? next() : jsonBody(req, res, next))); // /transcribe takes raw audio only

  const gatewayHeaders = { authorization: `Bearer ${gatewayToken}`, "content-type": "application/json" };

  async function invoke(tool, args, { sessionKey, timeoutMs = READ_TIMEOUT_MS } = {}) {
    const res = await fetchImpl(`${gatewayUrl}/tools/invoke`, {
      method: "POST",
      headers: gatewayHeaders,
      body: JSON.stringify(sessionKey ? { tool, args, sessionKey } : { tool, args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || j?.ok !== true) {
      const err = new Error(`gateway ${tool} failed (${res.status})`);
      err.toolError = j?.error?.type === "tool_error"; // the tool ran and refused (bad input), not an outage
      err.answered = j?.ok === false; // the gateway answered with a refusal (tool failed, or not allowed: 404), as opposed to no answer
      throw err;
    }
    return j.result?.details ?? {};
  }

  /** Every session row, paged (the gateway caps one page at 100): an allowed conversation must never fall off a truncated page. */
  async function allSessions() {
    const rows = [];
    let offset = 0;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const d = await invoke("sessions_list", { limit: 100, offset, excludeSubagents: true });
      const batch = Array.isArray(d.sessions) ? d.sessions : [];
      rows.push(...batch);
      if (d.hasMore !== true || !batch.length) break;
      offset = Number.isInteger(d.nextOffset) && d.nextOffset > offset ? d.nextOffset : offset + batch.length;
    }
    return rows;
  }

  const fail = (res, err, what) => {
    log?.warn?.("app-bridge", `${what}: ${err?.message ?? err}`);
    res.status(502).json({ ok: false, error: "engine_unavailable" });
  };

  router.get("/status", (_req, res) => res.json({ ok: true, appSession: APP_SESSION_KEY, link: link ? link.status() : { state: "off" } }));

  router.get("/sessions", async (_req, res) => {
    try {
      const { owners, mainReadable } = readPolicyFromConfig(configPath);
      const rows = (await allSessions()).filter((r) => isReadable(r, owners, mainReadable));
      const sessions = rows
        .map((r) => ({ key: r.key, label: sessionLabel(r), channel: String(r.channel ?? ""), updatedAt: Number(r.updatedAt) || 0,
          status: String(r.status ?? ""), writable: r.key === APP_SESSION_KEY }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      if (!sessions.some((s) => s.key === APP_SESSION_KEY)) sessions.unshift({ key: APP_SESSION_KEY, label: "التطبيق", channel: "app", updatedAt: 0, status: "", writable: true });
      res.json({ ok: true, sessions });
    } catch (err) { fail(res, err, "sessions"); }
  });

  router.get("/history", async (req, res) => {
    const key = String(req.query.key ?? APP_SESSION_KEY);
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
    const offsetRaw = req.query.offset;
    try {
      // The allowlist is decided by the key alone (app, main, the owner's direct WhatsApp chat), never by a listing.
      const { owners, mainReadable } = readPolicyFromConfig(configPath);
      if (!isReadable({ key }, owners, mainReadable)) return res.status(404).json({ ok: false, error: "not_found" });
      const args = { sessionKey: key, limit };
      if (offsetRaw !== undefined) args.offset = Math.max(Number.parseInt(String(offsetRaw), 10) || 0, 0);
      const h = await invoke("sessions_history", args);
      const messages = (Array.isArray(h.messages) ? h.messages : [])
        .filter((m) => m && (m.role === "user" || m.role === "assistant"))
        .map((m) => ({ role: m.role, text: messageText(m), at: Number(m.timestamp) || 0, ...(m.role === "assistant" ? assistantMeta(m) : {}) }))
        .filter((m) => m.text.trim() !== "");
      res.json({ ok: true, key, messages, nextOffset: Number.isInteger(h.nextOffset) ? h.nextOffset : null, hasMore: h.hasMore === true });
    } catch (err) { fail(res, err, "history"); }
  });

  router.post("/send", (req, res) => {
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message || message.length > MAX_MESSAGE_CHARS) return res.status(400).json({ ok: false, error: "bad_request" });
    if ([...runs.values()].some((r) => r.status === "running")) return res.status(409).json({ ok: false, error: "busy" });

    const id = crypto.randomUUID();
    const ctl = new AbortController();
    const run = { id, status: "running", text: "", error: null, startedAt: now(), firstTokenAt: null, finishedAt: null, abort: () => ctl.abort() };
    runs.set(id, run);
    while (runs.size > MAX_RUNS_KEPT) runs.delete(runs.keys().next().value);

    // A turn waiting on an exec/plugin approval must not time out before the approval itself does (30 min by default)
    const onTimeout = () => {
      const until = link?.approvalDeadline(APP_SESSION_KEY);
      if (until && until > now()) { timer = setTimeout(onTimeout, until - now() + APPROVAL_GRACE_MS); return; }
      ctl.abort();
    };
    let timer = setTimeout(onTimeout, RUN_TIMEOUT_MS);
    (async () => {
      await queue; // a model/thinking/fast change already under way applies BEFORE this turn starts (never mid-turn)
      const r = await fetchImpl(`${gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { ...gatewayHeaders, "x-openclaw-session-key": APP_SESSION },
        body: JSON.stringify({ model: "openclaw/default", stream: true, messages: [{ role: "user", content: message }] }),
        signal: ctl.signal,
      });
      if (!r.ok || !r.body) throw new Error(`chat ${r.status}`);
      run.text = await readCompletionStream(r.body, (t) => { run.firstTokenAt ??= now(); run.text = t; });
      run.status = "done";
    })()
      .catch((err) => {
        run.status = ctl.signal.aborted ? "stopped" : "error";
        run.error = run.status === "error" ? "engine_error" : null;
        if (run.status === "error") log?.warn?.("app-bridge", `run failed: ${err?.message ?? err}`);
      })
      .finally(() => { clearTimeout(timer); run.finishedAt = now(); forgetDescribe(); }); // the turn saved the session: a cached describe is stale

    res.status(202).json({ ok: true, runId: id });
  });

  const latency = (r) => ({
    firstTokenMs: r.firstTokenAt == null ? null : r.firstTokenAt - r.startedAt,
    totalMs: r.finishedAt == null ? null : r.finishedAt - r.startedAt,
  });
  const view = (r) => ({ ok: true, runId: r.id, status: r.status, text: r.text, error: r.error, startedAt: r.startedAt, finishedAt: r.finishedAt, ...latency(r) });

  router.get("/runs/:id", (req, res) => {
    const r = runs.get(req.params.id);
    return r ? res.json(view(r)) : res.status(404).json({ ok: false, error: "not_found" });
  });

  router.post("/runs/:id/stop", (req, res) => {
    const r = runs.get(req.params.id);
    if (!r) return res.status(404).json({ ok: false, error: "not_found" });
    if (r.status === "running") r.abort();
    res.json({ ok: true });
  });

  // ---- Model control (M). Reads: models.list + sessions.describe. Writes: the app session only, validated values only. ----
  let modelsCache = { at: 0, rows: null, pending: null };

  /** The agent's model catalog in the bridge shape. Default view: the agent's modelPolicy allowlist when one is set. */
  async function listModels() {
    if (modelsCache.rows && now() - modelsCache.at < MODELS_CACHE_MS) return { rows: modelsCache.rows, at: modelsCache.at, cached: true };
    modelsCache.pending ??= (async () => {
      try {
        const r = await gatewayCall("models.list", { agentId: "main", sessionKey: APP_SESSION_KEY, view: "default", includeDetails: true });
        if (!Array.isArray(r?.models)) throw new Error("models.list: no models array");
        const seen = new Set();
        const rows = r.models.map(mapModel).filter((m) => m && !seen.has(m.id) && seen.add(m.id));
        modelsCache = { at: now(), rows, pending: null };
        return { rows, at: modelsCache.at, cached: false };
      } finally { modelsCache.pending = null; }
    })();
    return modelsCache.pending;
  }

  async function describeApp() {
    const d = await gatewayCall("sessions.describe", { key: APP_SESSION_KEY });
    const s = d?.session;
    if (!s || s.key !== APP_SESSION_KEY) throw new Error("sessions.describe: unexpected session");
    return s;
  }
  // GET /model only: one describe shared by concurrent and closely repeated reads. Writes always describe afresh, and any
  // write (or a turn ending) makes the next read fetch again.
  let described = { at: 0, writes: -1, value: null, pending: null };
  function forgetDescribe() { described = { at: 0, writes: -1, value: null, pending: null }; }
  function describeForRead() {
    if (described.value && described.writes === writes && now() - described.at < DESCRIBE_CACHE_MS) return Promise.resolve(described.value);
    if (described.pending && described.writes === writes) return described.pending;
    const mark = writes;
    const pending = describeApp().then((value) => { if (described.pending === pending) described = { at: now(), writes: mark, value, pending: null }; return value; },
      (err) => { if (described.pending === pending) described = { at: 0, writes: -1, value: null, pending: null }; throw err; });
    described = { at: 0, writes: mark, value: null, pending };
    return pending;
  }

  // Settings writes (model / thinking / fast) run one at a time — two devices changing settings together never interleave
  // (e.g. a level validated against the old model landing on the new one). A new turn waits for the queue to drain.
  let queue = Promise.resolve();
  // A GET /model taken while a write was in flight may hold the old value under the new write count: forget it once the
  // write has finished, so the first read after a successful change is always fresh.
  const serial = (fn) => { const p = queue.then(fn, fn).finally(forgetDescribe); queue = p.catch(() => {}); return p; };
  const turnRunning = () => [...runs.values()].some((r) => r.status === "running");
  let writes = 0; // every settings write bumps this; a delayed re-check only acts if nothing was written since
  const patchApp = (fields) => { writes++; return gatewayCall("sessions.patch", { key: APP_SESSION_KEY, ...fields }); };
  // A change made while a turn is running is overwritten when that turn saves the session: refuse it (409 busy) instead.
  const busy = (res, s) => {
    // the engine's flag can lag right at the start of a turn: this bridge's own running turn counts too
    if (s?.hasActiveRun !== true && !turnRunning()) return false;
    res.status(409).json({ ok: false, error: "busy" });
    return true;
  };
  const needsCall = (res) => {
    if (gatewayCall) return false;
    res.status(503).json({ ok: false, error: "not_available" });
    return true;
  };
  const bad = (res, error) => res.status(400).json({ ok: false, error });

  router.get("/models", async (_req, res) => {
    if (needsCall(res)) return;
    try {
      const { rows, at, cached } = await listModels();
      res.json({ ok: true, models: rows, fetchedAt: at, cached });
    } catch (err) { fail(res, err, "models"); }
  });

  router.get("/model", async (_req, res) => {
    if (needsCall(res)) return;
    try {
      const [s, hist, models] = await Promise.all([
        describeForRead(),
        invoke("sessions_history", { sessionKey: APP_SESSION_KEY, limit: 20 }).catch(() => null),
        listModels().then((m) => m.rows).catch(() => null),
      ]);
      const id = modelRef(s.modelProvider, s.model);
      const row = models?.find((m) => m.id === id) ?? null;
      const msgs = Array.isArray(hist?.messages) ? hist.messages : [];
      const reply = [...msgs].reverse().find((m) => m?.role === "assistant" && !isMirror(m)) ?? null;
      const replyRun = reply?.__openclaw?.runId;
      const mirror = replyRun ? msgs.findLast((m) => m?.openclawDeliveryMirror?.kind === "model-fallback" && m.openclawDeliveryMirror.phase !== "restored"
        && m.openclawDeliveryMirror.runId === replyRun) : null;
      const last = [...runs.values()].at(-1) ?? null;
      res.json({
        ok: true,
        sessionKey: APP_SESSION_KEY,
        model: { id, provider: safeStr(s.modelProvider, 100), model: safeStr(s.model, MAX_MODEL_REF),
          // "user" = the owner pinned it; "auto" = OpenClaw's temporary runtime-fallback pin (never shown as the owner's choice)
          source: s.modelOverrideSource === "user" ? "override" : s.modelOverrideSource === "auto" ? "fallback" : "default" },
        thinking: { level: safeStr(s.thinkingLevel, 40), default: safeStr(s.thinkingDefault, 40),
          effective: safeStr(s.thinkingLevel, 40) ?? safeStr(s.thinkingDefault, 40), levels: levelIds(s.thinkingLevels) },
        fast: { supported: row ? row.supportsFastMode : null, enabled: bool(s.effectiveFastMode), source: safeStr(s.effectiveFastModeSource, 40) },
        usage: { inputTokens: num(s.inputTokens), outputTokens: num(s.outputTokens), contextTokens: num(s.totalTokens), contextWindow: num(s.contextTokens) },
        lastReply: reply ? { ...assistantMeta(reply), at: Number(reply.timestamp) || 0 } : null,
        fallback: mirror ? { ...assistantMeta(mirror).fallback, at: Number(mirror.timestamp) || 0 } : null,
        lastRun: last ? { runId: last.id, status: last.status, startedAt: last.startedAt, ...latency(last) } : null,
      });
    } catch (err) { fail(res, err, "model"); }
  });

  router.post("/model", (req, res) => serial(async () => {
    if (needsCall(res)) return;
    const want = typeof req.body?.model === "string" ? req.body.model.trim() : "";
    if (!want || want.length > MAX_MODEL_REF) return bad(res, "bad_request");
    try {
      if (busy(res, await describeApp())) return;
      if (want !== "default") {
        const row = (await listModels()).rows.find((m) => m.id === want);
        if (!row) return bad(res, "unknown_model");
        if (!row.available) return bad(res, "model_unavailable");
        if (!row.selectable) return bad(res, "model_not_selectable");
      }
      // The sessions tool resolves and policy-checks the ref itself; "default" clears the session pin.
      writes++;
      const d = await invoke("sessions", { action: "patch", sessionKey: APP_SESSION_KEY, model: want });
      if (d?.status !== "updated" || d?.sessionKey !== APP_SESSION_KEY) return bad(res, "rejected");
      const r = d.resolved ?? {};
      // A thinking level or fast mode the NEW model does not offer would stay stored (the gateway keeps it) and be shown while
      // the provider ignores it: clear it, and say so.
      const id = modelRef(r.modelProvider, r.model);
      const [s, { rows }] = await Promise.all([describeApp(), listModels()]);
      const row = rows.find((m) => m.id === id);
      const reset = { thinking: false, fast: false };
      if (s.thinkingLevel && row && !row.thinkingLevels.includes(s.thinkingLevel)) { await patchApp({ thinkingLevel: null }); reset.thinking = true; }
      if (s.effectiveFastModeSource === "session" && s.effectiveFastMode === true && row && !row.supportsFastMode) { await patchApp({ fastMode: null }); reset.fast = true; }
      if (reset.thinking || reset.fast) {
        // OpenClaw can save the session a moment later from work that started earlier: check once and clear again if it came back.
        // Only if no other settings write happened meanwhile (a newer model or level must never be undone by this re-check).
        const mine = writes;
        await new Promise((r) => setTimeout(r, RESET_RECHECK_MS));
        const again = writes === mine ? await describeApp() : null;
        if (again && writes === mine && modelRef(again.modelProvider, again.model) === id) {
          if (reset.thinking && again.thinkingLevel && row && !row.thinkingLevels.includes(again.thinkingLevel)) await patchApp({ thinkingLevel: null });
          if (reset.fast && again.effectiveFastModeSource === "session" && again.effectiveFastMode === true) await patchApp({ fastMode: null });
        }
      }
      // No override/default flag here: pinning the configured primary is stored as no override. GET /model reports it.
      res.json({ ok: true, model: { id, provider: safeStr(r.modelProvider, 100), model: safeStr(r.model, MAX_MODEL_REF) },
        thinkingLevel: reset.thinking ? null : safeStr(r.thinkingLevel, 40), reset });
    } catch (err) {
      if (err?.toolError || err?.refused) return bad(res, "rejected");
      fail(res, err, "model patch");
    }
  }));

  router.post("/thinking", (req, res) => serial(async () => {
    if (needsCall(res)) return;
    const level = typeof req.body?.level === "string" ? req.body.level.trim() : "";
    if (!level || level.length > 40) return bad(res, "bad_request");
    try {
      const s = await describeApp();
      if (busy(res, s)) return;
      if (level !== "default" && !levelIds(s.thinkingLevels).includes(level)) return bad(res, "unsupported_level");
      await patchApp({ thinkingLevel: level === "default" ? null : level });
      res.json({ ok: true, thinking: { level: level === "default" ? null : level } });
    } catch (err) { if (err?.refused) return bad(res, "rejected"); fail(res, err, "thinking patch"); }
  }));

  router.post("/fast", (req, res) => serial(async () => {
    if (needsCall(res)) return;
    const mode = typeof req.body?.mode === "string" ? req.body.mode.trim() : "";
    if (!Object.hasOwn(FAST_MODES, mode)) return bad(res, "bad_request");
    try {
      const s = await describeApp();
      if (busy(res, s)) return;
      if (mode === "on") {
        // The gateway itself accepts fastMode on any model, so the bridge checks the current model's capability first.
        const row = (await listModels()).rows.find((m) => m.id === modelRef(s.modelProvider, s.model));
        if (!row?.supportsFastMode) return bad(res, "fast_mode_unsupported");
      }
      await patchApp({ fastMode: FAST_MODES[mode] });
      res.json({ ok: true, fast: { mode } });
    } catch (err) { if (err?.refused) return bad(res, "rejected"); fail(res, err, "fast patch"); }
  }));

  // ---- Voice (V2/V3): BASHT's own voice and the engine's own transcription. The caller sends text or audio, nothing else. ----
  const perMinute = (max) => {
    let hits = [];
    return () => { const t = now(); hits = hits.filter((h) => t - h < 60_000); if (hits.length >= max) return false; hits.push(t); return true; };
  };
  const speakLimit = perMinute(SPEAK_PER_MINUTE);
  const transcribeLimit = perMinute(TRANSCRIBE_PER_MINUTE);
  let transcribing = 0;
  const voiceUnavailable = (res) => res.status(503).json({ ok: false, error: "voice_unavailable" });
  const speechDir = stateDir ? path.join(stateDir, "media", "tool-speech-synthesis") : null;

  /** The tool's audio file, only if it really is a regular file inside the speech directory (symlinks resolved). Else null. */
  async function speechFile(p) {
    if (typeof p !== "string" || !p || !speechDir) return null;
    try {
      const [real, base] = await Promise.all([fs.promises.realpath(p), fs.promises.realpath(speechDir)]);
      if (!real.startsWith(base + path.sep) || !Object.hasOwn(SPEECH_TYPES, path.extname(real).toLowerCase())) return null;
      const st = await fs.promises.lstat(real);
      return st.isFile() ? { real, size: st.size } : null;
    } catch { return null; }
  }

  router.post("/speak", async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text || text.length > MAX_SPEAK_CHARS) return bad(res, "bad_request");
    if (!speechDir) return voiceUnavailable(res);
    if (!speakLimit()) return res.status(429).json({ ok: false, error: "rate_limited" });
    let d;
    try {
      // the agent's tool on the app session: agents.entries.main.tts (voice, model, instructions) applies; markdown is stripped by the engine
      d = await invoke("tts", { text }, { sessionKey: APP_SESSION_KEY, timeoutMs: SPEAK_TIMEOUT_MS });
    } catch (err) {
      if (err?.answered) { log?.warn?.("app-bridge", `speak refused: ${err.message}`); return voiceUnavailable(res); }
      return fail(res, err, "speak");
    }
    const file = await speechFile(d?.audioPath);
    if (!file) {
      // never read (or delete) anything outside the speech directory
      log?.warn?.("app-bridge", "speak: the tool returned no usable audio file");
      return voiceUnavailable(res);
    }
    try {
      if (file.size < 1 || file.size > MAX_SPEECH_BYTES) return voiceUnavailable(res);
      const audio = await fs.promises.readFile(file.real);
      res.set({ "Content-Type": SPEECH_TYPES[path.extname(file.real).toLowerCase()], "Content-Length": String(audio.length),
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.status(200).end(audio);
    } catch (err) {
      fail(res, err, "speak read");
    } finally {
      fs.promises.unlink(file.real).catch(() => {}); // one-shot: the app plays it, the engine keeps no copy
    }
  });

  const rawAudio = express.raw({ type: () => true, limit: MAX_AUDIO_BYTES });
  router.post("/transcribe", (req, res, next) => {
    if (!transcribe) return voiceUnavailable(res);
    const type = String(req.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!Object.hasOwn(AUDIO_TYPES, type)) return res.status(415).json({ ok: false, error: "unsupported_audio" });
    const declared = Number(req.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) return res.status(413).json({ ok: false, error: "too_large" });
    if (!transcribeLimit()) return res.status(429).json({ ok: false, error: "rate_limited" });
    if (transcribing >= TRANSCRIBES_IN_FLIGHT) return res.status(429).json({ ok: false, error: "rate_limited" });
    // Reserve the slot BEFORE the body is read: uploads still arriving count, so overlapping uploads can never start more than
    // TRANSCRIBES_IN_FLIGHT transcribers. Released exactly once: by the handler when it finishes, or when the response ends
    // without the handler having run (parse error, too large, client gone).
    transcribing++;
    const slot = { handled: false, released: false };
    req.voiceSlot = slot;
    const release = () => { if (!slot.released) { slot.released = true; transcribing--; } };
    slot.release = release;
    res.on("close", () => { if (!slot.handled) release(); });
    req.audioExt = AUDIO_TYPES[type];
    rawAudio(req, res, (err) => {
      if (err) return res.status(err.status === 413 ? 413 : 400).json({ ok: false, error: err.status === 413 ? "too_large" : "bad_request" });
      next();
    });
  }, async (req, res) => {
    const slot = req.voiceSlot;
    slot.handled = true;
    const audio = Buffer.isBuffer(req.body) ? req.body : null;
    if (!audio || audio.length < MIN_AUDIO_BYTES) { slot.release(); return res.status(422).json({ ok: false, error: "no_speech" }); }
    let dir = null;
    try {
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "basht-voice-")); // 0700, unpredictable name
      const file = path.join(dir, `note${req.audioExt}`); // the only argv the CLI gets from here: a path the bridge chose
      await fs.promises.writeFile(file, audio, { mode: 0o600, flag: "wx" });
      const raw = await Promise.race([
        transcribe(file),
        new Promise((_, reject) => setTimeout(() => reject(new Error("transcribe timed out")), TRANSCRIBE_TIMEOUT_MS).unref()),
      ]);
      const text = (typeof raw === "string" ? raw : "").trim().slice(0, MAX_TRANSCRIPT_CHARS);
      if (!text) return res.status(422).json({ ok: false, error: "no_speech" });
      res.json({ ok: true, text });
    } catch (err) {
      if (err?.refused) { log?.warn?.("app-bridge", `transcribe refused: ${err.message}`); return voiceUnavailable(res); }
      if (err?.badAudio) return res.status(415).json({ ok: false, error: "unsupported_audio" }); // the recording could not be read
      fail(res, err, "transcribe");
    } finally {
      slot.release();
      if (dir) fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
  router.use(createLiveRoutes({ link, log }));

  // Anything else under /app/v1 ends here: it must never fall through to the gateway proxy (that would forward the app token).
  router.use((_req, res) => res.status(404).json({ ok: false, error: "not_found" }));
  return router;
}
