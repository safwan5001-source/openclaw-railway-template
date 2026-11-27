// BASHT app bridge (C2 + C4): the ONLY surface the BASHT app (safwan-smart-assistant) uses to talk to this engine.
//
//   GET  /app/v1/status            -> { ok, appSession }
//   GET  /app/v1/sessions          -> the conversations the app may read (allowlist below), newest first
//   GET  /app/v1/history?key=...   -> one allowed conversation's messages (text only, no tool payloads)
//   POST /app/v1/send { message }  -> starts ONE owner turn in the app's own session; returns { runId } at once
//   GET  /app/v1/runs/:id          -> that turn's live text and status (the app polls it)
//   POST /app/v1/runs/:id/stop     -> stops that turn
//
// Trust model
// - Off unless BASHT_APP_TOKEN (>= 32 chars) is set. The app holds only that token; it never sees OPENCLAW_GATEWAY_TOKEN
//   or SETUP_PASSWORD. The bridge calls the loopback gateway itself, with a FIXED set of operations:
//   `sessions_list` / `sessions_history` (read) and `/v1/chat/completions` on ONE session key (write). Nothing else.
// - The app is the owner's own client, so its turns are owner turns (same agent, same shared memory, same tool policy and
//   approval rules as the Control UI). They run in their own session (`app:owner`), separate from the WhatsApp chat.
// - Reads are limited to the owner's own conversations: the app session, the main session and the owner's direct WhatsApp
//   chat(s) (owners from commands.ownerAllowFrom). Group chats and other people's chats are never listed or read.
// - A turn keeps running if the phone goes away: the bridge, not the phone, holds the upstream request.
import crypto from "node:crypto";
import fs from "node:fs";
import express from "express";
import { whatsAppOwnersFrom } from "../patches/whatsapp-owner.mjs";

export const APP_SESSION = "app:owner";
export const APP_SESSION_KEY = "agent:main:app:owner";
export const MAIN_SESSION_KEY = "agent:main:main";
export const MIN_TOKEN_LENGTH = 32;
export const MAX_MESSAGE_CHARS = 8000;
const MAX_RUNS_KEPT = 20;
const RUN_TIMEOUT_MS = 15 * 60_000;
const READ_TIMEOUT_MS = 15_000;
const AUTH_FAILURES_PER_MINUTE = 20;

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

/** Reads the SSE stream of /v1/chat/completions, calling onText with the growing text. Resolves when [DONE]. */
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
 *           fetchImpl?: typeof fetch, now?: () => number }} opts
 * @returns {import("express").Router | null} null when the bridge is not enabled
 */
export function createAppBridge({ token, gatewayUrl, gatewayToken, configPath, log, fetchImpl = fetch, now = Date.now }) {
  const appToken = String(token ?? "").trim();
  if (appToken.length < MIN_TOKEN_LENGTH) return null;
  const router = express.Router();
  const runs = new Map(); // runId -> { id, status, text, error, startedAt, finishedAt, abort }
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
  router.use(express.json({ limit: "64kb" }));

  const gatewayHeaders = { authorization: `Bearer ${gatewayToken}`, "content-type": "application/json" };

  async function invoke(tool, args) {
    const res = await fetchImpl(`${gatewayUrl}/tools/invoke`, {
      method: "POST",
      headers: gatewayHeaders,
      body: JSON.stringify({ tool, args }),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || j?.ok !== true) throw new Error(`gateway ${tool} failed (${res.status})`);
    return j.result?.details ?? {};
  }

  const fail = (res, err, what) => {
    log?.warn?.("app-bridge", `${what}: ${err?.message ?? err}`);
    res.status(502).json({ ok: false, error: "engine_unavailable" });
  };

  router.get("/status", (_req, res) => res.json({ ok: true, appSession: APP_SESSION_KEY }));

  router.get("/sessions", async (_req, res) => {
    try {
      const owners = ownersFromConfig(configPath);
      const d = await invoke("sessions_list", { limit: 100 });
      const rows = (Array.isArray(d.sessions) ? d.sessions : []).filter((r) => isReadable(r, owners));
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
      // Re-check against the live list: a key is readable only if it is the app session or listed AND allowed.
      if (key !== APP_SESSION_KEY) {
        const owners = ownersFromConfig(configPath);
        const d = await invoke("sessions_list", { limit: 100 });
        const row = (Array.isArray(d.sessions) ? d.sessions : []).find((r) => r.key === key);
        if (!row || !isReadable(row, owners)) return res.status(404).json({ ok: false, error: "not_found" });
      }
      const args = { sessionKey: key, limit };
      if (offsetRaw !== undefined) args.offset = Math.max(Number.parseInt(String(offsetRaw), 10) || 0, 0);
      const h = await invoke("sessions_history", args);
      const messages = (Array.isArray(h.messages) ? h.messages : [])
        .filter((m) => m && (m.role === "user" || m.role === "assistant"))
        .map((m) => ({ role: m.role, text: messageText(m), at: Number(m.timestamp) || 0 }))
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
    const run = { id, status: "running", text: "", error: null, startedAt: now(), finishedAt: null, abort: () => ctl.abort() };
    runs.set(id, run);
    while (runs.size > MAX_RUNS_KEPT) runs.delete(runs.keys().next().value);

    const timer = setTimeout(() => ctl.abort(), RUN_TIMEOUT_MS);
    (async () => {
      const r = await fetchImpl(`${gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { ...gatewayHeaders, "x-openclaw-session-key": APP_SESSION },
        body: JSON.stringify({ model: "openclaw/default", stream: true, messages: [{ role: "user", content: message }] }),
        signal: ctl.signal,
      });
      if (!r.ok || !r.body) throw new Error(`chat ${r.status}`);
      run.text = await readCompletionStream(r.body, (t) => { run.text = t; });
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

  const view = (r) => ({ ok: true, runId: r.id, status: r.status, text: r.text, error: r.error, startedAt: r.startedAt, finishedAt: r.finishedAt });

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

  return router;
}
