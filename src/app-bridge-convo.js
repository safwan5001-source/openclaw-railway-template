// BASHT app bridge — chat basics (B1): tool progress of a running turn, «محادثة جديدة» (reset), earlier messages after a reset,
// and search across the owner's readable conversations. Wired in by src/app-bridge.js.
//
// - Steps: while an app turn runs, the bridge reads the app session's newest transcript rows (the `sessions_history` tool, HTTP,
//   cheap) at most every STEPS_EVERY_MS, only while the app is polling that turn, and keeps tool NAMES only (never arguments or
//   results).
// - New conversation: `sessions.reset {key: app session, reason: "new"}` (operator.admin, run by the wrapper's CLI with params the
//   bridge builds). OpenClaw keeps the transcript (same session id) and starts a fresh context; its default history projection
//   then begins at the reset row, while earlier rows stay readable by an ANCHORED `chat.history` read (messageId). The bridge
//   records, per reset it made, the last message before it (`<stateDir>/app-bridge/resets.json`, ids only, 0600), so the app can
//   page back into the earlier conversation. Nothing is deleted.
// - Search: `sessions.search` limited to the readable session keys, results filtered again and shaped (snippet without file refs).
import fs from "node:fs";
import path from "node:path";
import { splitAttachedMarkers, splitMediaLines } from "./app-bridge-media.js";

const safeStrOf = (v, max) => { const t = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim(); return t ? t.slice(0, max) : null; };

export const STEPS_EVERY_MS = 1500;
const MAX_STEPS = 8;
const MAX_RESETS_KEPT = 50;
export const PAGE = 40; // messages per earlier page
export const MAX_QUERY = 200;
const ID_RE = /^[A-Za-z0-9_-]{6,100}$/;
const TOOL_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Tool names (in order) of a running turn, from transcript rows written since `startedAt`. A step is `done` once a later row exists. */
export function stepsFrom(messages, startedAt) {
  const rows = (Array.isArray(messages) ? messages : []).filter((m) => (Number(m?.timestamp) || 0) >= startedAt - 2000);
  const steps = [];
  const doneIds = new Set(rows.filter((m) => m?.role === "toolResult" && typeof m.toolCallId === "string").map((m) => m.toolCallId));
  rows.forEach((m, i) => {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) return;
    for (const p of m.content) {
      if (p?.type !== "toolCall" || typeof p.name !== "string" || !TOOL_RE.test(p.name)) continue;
      const later = rows.slice(i + 1).some((x) => x?.role === "assistant");
      steps.push({ tool: p.name, done: (typeof p.id === "string" && doneIds.has(p.id)) || later });
    }
  });
  return steps.slice(-MAX_STEPS);
}

/** The reset ledger: [{resetId, anchorId, at}] newest last. Ids only. Never throws. */
export function createResetLedger(stateDir) {
  const file = stateDir ? path.join(stateDir, "app-bridge", "resets.json") : null;
  const read = () => {
    if (!file) return [];
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(j) ? j.filter((r) => ID_RE.test(String(r?.resetId)) && ID_RE.test(String(r?.anchorId))) : [];
    } catch { return []; }
  };
  return {
    list: read,
    anchorFor(resetId) { return read().findLast((r) => r.resetId === resetId)?.anchorId ?? null; },
    /** Appends one entry; `supersedes` (a reset id) is removed: that reset's conversation was empty and is now covered by this one. */
    add(entry, supersedes = null) {
      if (!file) return false;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const rows = [...read().filter((r) => !supersedes || r.resetId !== supersedes), entry].slice(-MAX_RESETS_KEPT);
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
        fs.renameSync(tmp, file);
        return true;
      } catch { return false; }
    },
  };
}

const rowId = (m) => (typeof m?.__openclaw?.id === "string" && ID_RE.test(m.__openclaw.id) ? m.__openclaw.id : null);
export const isResetRow = (m) => m?.__openclaw?.kind === "reset";

/** A search snippet the app may show: text only, no MEDIA: lines, attachment markers or absolute paths. */
export function cleanSnippet(s) {
  let t = splitAttachedMarkers(splitMediaLines(String(s ?? "")).text).text;
  t = t.replace(/MEDIA:\s*\S+/g, "📎").replace(/(^|[\s(])(?:\/|~\/)[^\s)]{2,}/g, "$1…");
  return safeStrOf(t.replace(/\s+/g, " "), 300) ?? "";
}

/**
 * Registers POST /new and GET /search. ctx: { gatewayCall, invoke, appKey, resetState: {active} (shared with /send), readableKeys() -> Promise<string[]>, readable(key),
 * labelOf(key), turnRunning(), ledger, log, now, fail(res, err, what) }
 */
export function registerConvoRoutes(router, ctx) {
  const needsCall = (res) => { if (ctx.gatewayCall) return false; res.status(503).json({ ok: false, error: "not_available" }); return true; };
  // ONE exclusion shared with /send (ctx.resetState): while a reset is under way no turn is accepted, and a reset never starts
  // while a turn runs — so the context is never reset under a message the bridge already accepted.
  const lock = ctx.resetState;

  router.post("/new", async (_req, res) => {
    try { await reset(res); } finally { res.locals?.resetSettled?.(); } // app-bridge holds the settings queue until here
  });
  async function reset(res) {
    if (needsCall(res)) return;
    if (lock.active || ctx.turnRunning()) return res.status(409).json({ ok: false, error: "busy" });
    lock.active = true;
    try {
      const d = await ctx.gatewayCall("sessions.describe", { key: ctx.appKey });
      if (d?.session?.hasActiveRun === true) return res.status(409).json({ ok: false, error: "busy" });
      // the newest row before the reset: earlier messages are read later by anchoring on it
      const before = await ctx.invoke("sessions_history", { sessionKey: ctx.appKey, limit: 3 });
      const rows = Array.isArray(before?.messages) ? before.messages : [];
      const last = rows.at(-1) ?? null;
      let anchorId = rowId(last);
      // two resets with nothing said between them: the new reset takes over the older one's anchor, and the older (empty)
      // conversation's ledger entry is dropped, so paging back never returns the same conversation twice
      const supersedes = last && isResetRow(last) ? rowId(last) : null;
      if (supersedes) anchorId = ctx.ledger.anchorFor(supersedes) ?? null;
      if (ctx.turnRunning()) return res.status(409).json({ ok: false, error: "busy" }); // re-checked right before the reset
      const r = await ctx.gatewayCall("sessions.reset", { key: ctx.appKey, reason: "new" });
      if (r?.ok === false || (r?.key && r.key !== ctx.appKey)) return res.status(400).json({ ok: false, error: "rejected" });
      const after = await ctx.invoke("sessions_history", { sessionKey: ctx.appKey, limit: 3 }).catch(() => null);
      const resetRow = (Array.isArray(after?.messages) ? after.messages : []).findLast(isResetRow);
      const resetId = rowId(resetRow);
      const kept = !!(resetId && anchorId) && ctx.ledger.add({ resetId, anchorId, at: ctx.now() }, supersedes);
      res.json({ ok: true, at: Number(resetRow?.timestamp) || ctx.now(), earlier: kept });
    } catch (err) {
      if (err?.refused) return res.status(400).json({ ok: false, error: "rejected" });
      ctx.fail(res, err, "new");
    } finally { lock.active = false; }
  }

  let searches = [];
  router.get("/search", async (req, res) => {
    if (needsCall(res)) return;
    const q = typeof req.query.q === "string" ? req.query.q.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
    if (!q || q.length > MAX_QUERY) return res.status(400).json({ ok: false, error: "bad_request" });
    const t = ctx.now();
    searches = searches.filter((s) => t - s < 60_000);
    if (searches.length >= 30) return res.status(429).json({ ok: false, error: "rate_limited" });
    searches.push(t);
    try {
      const keys = (await ctx.readableKeys()).slice(0, 200);
      const r = await ctx.gatewayCall("sessions.search", { query: q, sessionKeys: keys, limit: 20 });
      const results = (Array.isArray(r?.results) ? r.results : [])
        .filter((x) => typeof x?.sessionKey === "string" && keys.includes(x.sessionKey) && ctx.readable(x.sessionKey))
        .filter((x) => x.role === "user" || x.role === "assistant")
        .map((x) => ({ key: x.sessionKey, label: ctx.labelOf(x.sessionKey), messageId: ID_RE.test(String(x.messageId)) ? x.messageId : null,
          role: x.role, at: Number(x.timestamp) || 0, snippet: cleanSnippet(x.snippet) }))
        .filter((x) => x.messageId && x.snippet);
      res.json({ ok: true, results });
    } catch (err) {
      if (err?.refused) return res.status(400).json({ ok: false, error: "rejected" });
      ctx.fail(res, err, "search");
    }
  });
  return { reset };
}

/** A cursor for earlier rows: "<resetId>" (a reset this bridge made) or "<messageId>.<resetId>" (older than that message, inside
 * the conversation that ended with that reset) or "<messageId>" alone. Ids only; checked by the caller with CURSOR_RE. */
export const CURSOR_RE = /^[A-Za-z0-9_-]{6,100}(?:\.[A-Za-z0-9_-]{6,100})?$/;

/**
 * Earlier / surrounding rows by an anchored `chat.history` read (CLI) inside ONE conversation key.
 * - mode "before": rows strictly older than the cursor's message (or, for a reset this bridge made, the conversation before it, up
 *   to and including the message it recorded). OpenClaw's anchored read stays inside one reset segment, so when a segment is
 *   exhausted the next cursor is the previous reset in the ledger (if any).
 * - mode "around": a window around one message (search results).
 * Returns {messages (raw rows), earlier (next cursor | null), found}.
 */
export async function anchoredPage(ctx, key, cursor, mode) {
  const [first, segPart] = String(cursor).split(".");
  let anchor = first; let include = false; let seg = segPart ?? null;
  if (mode === "before" && key === ctx.appKey && !segPart) {
    const a = ctx.ledger.anchorFor(first);
    if (a) { anchor = a; include = true; seg = first; }
  }
  const r = await ctx.gatewayCall("chat.history", { sessionKey: key, messageId: anchor, limit: 2 * PAGE + 1 });
  const rows = Array.isArray(r?.messages) ? r.messages : [];
  const at = rows.findIndex((m) => rowId(m) === anchor);
  if (at < 0) return { messages: [], earlier: null, found: false };
  const messages = mode === "around" ? rows : rows.slice(0, include ? at + 1 : at);
  let earlier = null;
  const oldest = messages.map(rowId).find(Boolean);
  // more rows in this segment? OpenClaw says so itself (anchor.hasOlder: the window does not start at the transcript's first
  // message); counting raw rows instead offered an empty extra page when tool rows filled the window. Older engines: the count.
  const hasOlder = typeof r?.anchor?.hasOlder === "boolean" ? r.anchor.hasOlder : at >= PAGE;
  if (hasOlder && oldest) earlier = seg ? `${oldest}.${seg}` : oldest;
  else if (seg && key === ctx.appKey) { // this segment is done: the conversation before the previous reset, if the bridge made it
    const list = ctx.ledger.list(); const i = list.findIndex((x) => x.resetId === seg);
    const done = i >= 0 ? list[i].anchorId : null;
    // skip entries that point at the conversation just returned (ledgers written before empty resets were collapsed)
    let j = i - 1;
    while (j >= 0 && list[j].anchorId === done) j--;
    earlier = i > 0 && j >= 0 ? list[j].resetId : null;
  }
  return { messages, earlier, found: true };
}

export { rowId };
