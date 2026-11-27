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
//   B1/B2 (src/app-bridge-convo.js, src/app-bridge-media.js):
//   POST /send { message, images? }-> images ride on the same turn as `image_url` parts (<= 8, <= 10 MB each, <= 14 MB in total)
//   GET  /runs/:id                 -> also `steps: [{tool, done}]` (tool names only) while the turn runs
//   GET  /history?…&before=|around=-> earlier rows (also across a reset) / a window around one message; rows carry id, media, kind
//   POST /app/v1/new               -> «محادثة جديدة»: sessions.reset on the app session (nothing deleted; earlier rows stay readable)
//   GET  /app/v1/search?q=         -> sessions.search over the readable conversations only
//   GET  /app/v1/media?key&msg&ref -> one image/file of one message of a readable conversation (engine-owned files only)
//
// Trust model
// - Off unless BASHT_APP_TOKEN (>= 32 chars) is set. The app holds only that token; it never sees OPENCLAW_GATEWAY_TOKEN
//   or SETUP_PASSWORD. The bridge calls the loopback gateway itself, with a FIXED set of operations:
//   `sessions_list` / `sessions_history` (read) and `/v1/chat/completions` on ONE session key (write). Nothing else.
// - Model control (M) adds, through an injected `gatewayCall` (the wrapper runs `openclaw gateway call`): `models.list`,
//   `sessions.describe` and `sessions.patch` (thinkingLevel / fastMode), and the `sessions` tool `patch` (model). Every
//   write targets APP_SESSION_KEY only, with values validated against what the engine itself listed. No config writes.
// - The app is the owner's own client, so its turns are owner turns (same agent, same shared memory, same tool policy and
//   approval rules as the Control UI). They run in their own session (`app:owner`), separate from the WhatsApp chat.
// - Reads are limited to the owner's own conversations: the app session, the main session and the owner's direct WhatsApp
//   chat(s) (owners from commands.ownerAllowFrom). Group chats and other people's chats are never listed or read.
// - A turn keeps running if the phone goes away: the bridge, not the phone, holds the upstream request.
import crypto from "node:crypto";
import fs from "node:fs";
import express from "express";
import { whatsAppOwnersFrom } from "../patches/whatsapp-owner.mjs";
import { SEND_BODY_LIMIT, createRefCache, extractMedia, mediaRoots, parseImages, publicMedia, registerMediaRoute, resolveSource, turnContent } from "./app-bridge-media.js";
import { CURSOR_RE, STEPS_EVERY_MS, anchoredPage, createResetLedger, isResetRow, registerConvoRoutes, rowId, stepsFrom } from "./app-bridge-convo.js";

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

/** Is this session one the app may read? App + main session, and the owner's own direct WhatsApp chat(s). */
export function isReadable(row, owners) {
  const key = String(row?.key ?? "");
  if (key === APP_SESSION_KEY || key === MAIN_SESSION_KEY) return true;
  if (!/^agent:main:whatsapp:(?:[^:]+:)?direct:/i.test(key)) return false;
  const peer = key.slice(key.lastIndexOf(":") + 1);
  const digits = peer.replace(/\D/g, "");
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
 *   stateDir / workspaceDir: OpenClaw's state dir and the agent workspace — the only roots a MEDIA: file may be served from
 *     (B2), and where the reset ledger lives (B1). Without them no local file is served.
 * @returns {import("express").Router | null} null when the bridge is not enabled
 */
export function createAppBridge({ token, gatewayUrl, gatewayToken, configPath, log, fetchImpl = fetch, now = Date.now, gatewayCall, stateDir, workspaceDir }) {
  const appToken = String(token ?? "").trim();
  if (appToken.length < MIN_TOKEN_LENGTH) return null;
  const router = express.Router();
  const runs = new Map(); // runId -> { id, status, text, error, startedAt, firstTokenAt, finishedAt, abort }
  let failures = { windowStart: 0, count: 0 };

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "");
    // A valid token always passes: anonymous failures must never lock the owner's app out (they only slow down guessing).
    if (m && safeEqual(m[1].trim(), appToken)) return next();
    const t = now();
    if (t - failures.windowStart > 60_000) failures = { windowStart: t, count: 0 };
    failures.count += 1;
    if (failures.count > AUTH_FAILURES_PER_MINUTE) return res.status(429).json({ ok: false, error: "rate_limited" });
    return res.status(401).json({ ok: false, error: "unauthorized" });
  });
  const jsonBody = express.json({ limit: "64kb" });
  const sendBody = express.json({ limit: SEND_BODY_LIMIT }); // photos ride on the turn (B2); every other route keeps 64 kB
  router.use((req, res, next) => (req.path === "/send" ? sendBody : jsonBody)(req, res, next));

  const gatewayHeaders = { authorization: `Bearer ${gatewayToken}`, "content-type": "application/json" };

  async function invoke(tool, args) {
    const res = await fetchImpl(`${gatewayUrl}/tools/invoke`, {
      method: "POST",
      headers: gatewayHeaders,
      body: JSON.stringify({ tool, args }),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || j?.ok !== true) {
      const err = new Error(`gateway ${tool} failed (${res.status})`);
      err.toolError = j?.error?.type === "tool_error"; // the tool ran and refused (bad input), not an outage
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

  router.get("/status", (_req, res) => res.json({ ok: true, appSession: APP_SESSION_KEY }));

  router.get("/sessions", async (_req, res) => {
    try {
      const owners = ownersFromConfig(configPath);
      const rows = (await allSessions()).filter((r) => isReadable(r, owners));
      const sessions = rows
        .map((r) => ({ key: r.key, label: sessionLabel(r), channel: String(r.channel ?? ""), updatedAt: Number(r.updatedAt) || 0,
          status: String(r.status ?? ""), writable: r.key === APP_SESSION_KEY }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      if (!sessions.some((s) => s.key === APP_SESSION_KEY)) sessions.unshift({ key: APP_SESSION_KEY, label: "التطبيق", channel: "app", updatedAt: 0, status: "", writable: true });
      res.json({ ok: true, sessions });
    } catch (err) { fail(res, err, "sessions"); }
  });

  // ---- B1/B2 shared state: the reset ledger, the refs handed out, the roots a MEDIA: file may come from ----
  const ledger = createResetLedger(stateDir);
  const refs = createRefCache();
  const roots = mediaRoots(workspaceDir, stateDir);
  const mediaCtx = { workspaceDir, stateDir, roots };
  /** Transcript rows -> the app's rows: text (MEDIA: lines and attachment markers removed), media refs, id, reset boundaries. */
  const mapRows = (key, rows) => rows.filter((m) => m && (m.role === "user" || m.role === "assistant" || isResetRow(m))).map((m) => {
    if (isResetRow(m)) return { role: "system", kind: "reset", text: "", at: Number(m.timestamp) || 0, id: rowId(m), media: [] };
    const { text, media, messageId } = extractMedia(m, key, messageText(m));
    for (const it of media) if (it.ref && messageId) refs.put(key, messageId, it);
    const pub = media.map((it) => {
      if (it.kind === "link" || it.artifact) return publicMedia(it, true);
      const abs = resolveSource(it.file, mediaCtx);
      let size = null; let ok = false;
      try { const real = fs.realpathSync(abs); const st = fs.statSync(real); ok = st.isFile() && roots.some((r) => real.startsWith(`${r}/`)); size = ok ? st.size : null; } catch { /* missing */ }
      return publicMedia({ ...it, size }, ok);
    });
    return { role: m.role, text, at: Number(m.timestamp) || 0, id: rowId(m), media: pub, ...(m.role === "assistant" ? assistantMeta(m) : {}) };
  }).filter((m) => m.kind === "reset" || m.text.trim() !== "" || m.media.length > 0);

  router.get("/history", async (req, res) => {
    const key = String(req.query.key ?? APP_SESSION_KEY);
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
    const offsetRaw = req.query.offset;
    try {
      // The allowlist is decided by the key alone (app, main, the owner's direct WhatsApp chat), never by a listing.
      if (!isReadable({ key }, ownersFromConfig(configPath))) return res.status(404).json({ ok: false, error: "not_found" });
      const anchor = ["before", "around"].find((k) => req.query[k] !== undefined);
      if (anchor) {
        // B1: earlier rows (also across a reset) or a window around one message: an anchored read inside THIS conversation only
        const id = String(req.query[anchor]);
        if (!CURSOR_RE.test(id) || (anchor === "around" && id.includes("."))) return bad(res, "bad_request");
        if (needsCall(res)) return;
        const p = await anchoredPage(convoCtx, key, id, anchor);
        return res.json({ ok: true, key, messages: mapRows(key, p.messages), nextOffset: null, hasMore: false, earlier: p.earlier, found: p.found });
      }
      const args = { sessionKey: key, limit };
      if (offsetRaw !== undefined) args.offset = Math.max(Number.parseInt(String(offsetRaw), 10) || 0, 0);
      const h = await invoke("sessions_history", args);
      const raw = Array.isArray(h.messages) ? h.messages : [];
      const messages = mapRows(key, raw);
      // after «محادثة جديدة» the engine's default view starts at the reset row; the rows before it stay readable (anchored)
      const first = raw.find((m) => m && (m.role === "user" || m.role === "assistant" || isResetRow(m)));
      const earlier = h.hasMore !== true && key === APP_SESSION_KEY && first && isResetRow(first) && ledger.anchorFor(rowId(first)) ? rowId(first) : null;
      res.json({ ok: true, key, messages, nextOffset: Number.isInteger(h.nextOffset) ? h.nextOffset : null, hasMore: h.hasMore === true, earlier });
    } catch (err) { fail(res, err, "history"); }
  });

  router.post("/send", (req, res) => {
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const pics = parseImages(req.body?.images);
    if (pics.error) return res.status(400).json({ ok: false, error: pics.error });
    if ((!message && !pics.images.length) || message.length > MAX_MESSAGE_CHARS) return res.status(400).json({ ok: false, error: "bad_request" });
    if ([...runs.values()].some((r) => r.status === "running")) return res.status(409).json({ ok: false, error: "busy" });

    const id = crypto.randomUUID();
    const ctl = new AbortController();
    const run = { id, status: "running", text: "", error: null, startedAt: now(), firstTokenAt: null, finishedAt: null, abort: () => ctl.abort(),
      steps: [], stepsAt: 0, images: pics.images.length };
    runs.set(id, run);
    while (runs.size > MAX_RUNS_KEPT) runs.delete(runs.keys().next().value);

    const timer = setTimeout(() => ctl.abort(), RUN_TIMEOUT_MS);
    (async () => {
      await queue; // a model/thinking/fast change already under way applies BEFORE this turn starts (never mid-turn)
      const r = await fetchImpl(`${gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { ...gatewayHeaders, "x-openclaw-session-key": APP_SESSION },
        body: JSON.stringify({ model: "openclaw/default", stream: true, messages: [{ role: "user", content: turnContent(message, pics.images) }] }),
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
      .finally(() => { clearTimeout(timer); run.finishedAt = now(); });

    res.status(202).json({ ok: true, runId: id });
  });

  const latency = (r) => ({
    firstTokenMs: r.firstTokenAt == null ? null : r.firstTokenAt - r.startedAt,
    totalMs: r.finishedAt == null ? null : r.finishedAt - r.startedAt,
  });
  const view = (r) => ({ ok: true, runId: r.id, status: r.status, text: r.text, error: r.error, startedAt: r.startedAt, finishedAt: r.finishedAt, ...latency(r),
    steps: r.steps ?? [] });

  /** B1 tool progress: refreshed only while the app polls a running turn, at most every STEPS_EVERY_MS; names only. */
  const refreshSteps = (r) => {
    if (r.status !== "running" || r.stepsBusy || now() - r.stepsAt < STEPS_EVERY_MS) return;
    r.stepsBusy = true; r.stepsAt = now();
    invoke("sessions_history", { sessionKey: APP_SESSION_KEY, limit: 12, includeTools: true })
      .then((h) => { if (r.status === "running") r.steps = stepsFrom(h.messages, r.startedAt); })
      .catch(() => {}).finally(() => { r.stepsBusy = false; });
  };

  router.get("/runs/:id", (req, res) => {
    const r = runs.get(req.params.id);
    if (r) refreshSteps(r);
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

  // Settings writes (model / thinking / fast) run one at a time — two devices changing settings together never interleave
  // (e.g. a level validated against the old model landing on the new one). A new turn waits for the queue to drain.
  let queue = Promise.resolve();
  const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };
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
        describeApp(),
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

  // ---- B1/B2 routes: «محادثة جديدة», search, media ----
  const readableKey = (key) => isReadable({ key }, ownersFromConfig(configPath));
  const convoCtx = { gatewayCall, invoke, appKey: APP_SESSION_KEY, ledger, log, now, fail, turnRunning, readable: readableKey,
    labelOf: (key) => sessionLabel({ key }),
    readableKeys: async () => { const owners = ownersFromConfig(configPath); const keys = (await allSessions()).filter((r) => isReadable(r, owners)).map((r) => r.key);
      return [...new Set([APP_SESSION_KEY, MAIN_SESSION_KEY, ...keys])]; } };
  registerConvoRoutes(router, convoCtx);
  registerMediaRoute(router, { ...mediaCtx, readable: readableKey, gatewayCall, cache: refs, log,
    findMessage: async (key, messageId) => {
      if (!gatewayCall) return null;
      const r = await gatewayCall("chat.history", { sessionKey: key, messageId, limit: 1 });
      return (Array.isArray(r?.messages) ? r.messages : []).find((m) => rowId(m) === messageId) ?? null;
    } });

  // Anything else under /app/v1 ends here: it must never fall through to the gateway proxy (that would forward the app token).
  router.use((_req, res) => res.status(404).json({ ok: false, error: "not_found" }));
  // a body the parser refused (too large, not JSON) is answered in the bridge's own JSON shape, never as an HTML error page
  router.use((err, _req, res, _next) => res.status(err?.status === 413 ? 413 : 400).json({ ok: false, error: err?.status === 413 ? "too_large" : "bad_request" }));
  return router;
}
