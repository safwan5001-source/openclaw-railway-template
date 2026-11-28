// BASHT app bridge, independent conversations (batch 4, P2-B4-1): the ENGINE CONTRACT. Mounted by src/app-bridge.js under /app/v1
// ONLY while BASHT_THREADS=on (src/thread-keys.js). With the flag off none of this exists: /threads/* is 404 like an old engine.
//
//   GET  /threads/:tid/history?limit=&before=           rows of one conversation (chat.history over the link, qualified key)
//   GET  /threads/:tid/media?msg=&ref=                   one image/file of one message of that conversation
//   POST /threads/:tid/send {message, images?, clientMsgId}               one owner turn via chat.send on the WRITE link
//   GET  /threads/:tid/sends/:clientMsgId?since=         read-only reconciliation: was "<K>:user" received? agent.wait K
//   POST /threads/:tid/sends/:clientMsgId/resend {message, images?, originalAt, sessionSha256, previousRefusal?}   owner button only
//   GET  /threads/:tid/runs/:runId                       live text/status of one run (events; history + agent.wait after a restart)
//   POST /threads/:tid/runs/:runId/abort                 chat.abort {unqualified key, runId}
//   GET/POST /threads/:tid/{model,thinking,fast}         per-conversation settings (sessions.describe / sessions.patch)
//   GET  /threads/state?tids=a,b                         engine state of ≤100 conversations (archived, active run, last activity)
//   POST /threads/:tid/restore                           an archived conversation back to active (explicit owner action)
//   POST /threads/search {q, tids[]}                     sessions.search over the given conversations; results carry tid, never a key
//
// `tid` is "legacy" (the existing app conversation, agent:main:app:owner) or 32 lowercase hex. The bridge builds the keys itself
// (src/thread-keys.js) and never forwards one it was given. Nothing here is retried, and nothing is ever re-sent on its own.
import crypto from "node:crypto";
import { mediaHandler, parseImages } from "./app-bridge-media.js";
import { stepsFrom } from "./app-bridge-convo.js";
import { CHAT_HISTORY_MAX, SESSIONS_CAP_PARAMS } from "./gateway-link.js";
import { CLIENT_MSG_ID_RE, DEFINITE_REFUSALS, commandRefusal, isClientMsgId, parseTid, threadKeys, threadOfKey } from "./thread-keys.js";

export const RECENT_ACCEPT_MS = 3_000;   // an accepted send this recent counts as busy (ack -> visible in activeOnly took 105 ms, L1)
export const RESEND_WINDOW_MS = 24 * 60 * 60_000;
export const RECONCILE_PAGE = 200;
export const RECONCILE_MAX_PAGES = 10;
/**
 * Review I3: `since` may come from the API's clock (after a bridge restart there is no in-memory record), which can be ahead of the
 * engine's row times. Reconciliation only counts as complete once it has read back past `since - RECONCILE_SKEW_MS`.
 */
export const RECONCILE_SKEW_MS = 15 * 60_000;
export const HISTORY_MAX_LIMIT = 100; // the advertised maximum of GET /threads/:tid/history
export const ALREADY_SENT = "already_sent"; // NOT a definite refusal: the id was used before and may well have been sent
export const NEVER_RESEND = Object.freeze(["conflict", "command_not_allowed", "bad_request", "too_large"]);
const CAP_READ_TIMEOUT_MS = 4_000;
const READ_TIMEOUT_MS = 15_000;
const MAX_LIVE_RUNS = 50;
const MAX_SEND_RECORDS = 500;
const MAX_MESSAGE_CHARS = 8000;
const MAX_SEARCH_TIDS = 500;
const SEARCH_BATCH = 100;
const SEARCH_LIMIT = 20;
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{6,100}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MIME_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic", "image/heif": "heif" };

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const str = (v, max = 200) => (typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : null);
const intOr = (v, d) => { const n = Number.parseInt(String(v ?? ""), 10); return Number.isSafeInteger(n) ? n : d; };

/** The user row's idempotency tag "<K>:user" (chat.send writes it; lab E6/L1), as K, or null. */
export function userRowRunId(m) {
  if (m?.role !== "user") return null;
  const tag = m.idempotencyKey ?? m.__openclaw?.idempotencyKey;
  const k = typeof tag === "string" && tag.endsWith(":user") ? tag.slice(0, -5) : null;
  return k && CLIENT_MSG_ID_RE.test(k) ? k : null;
}
/** A reply row's run id when it is a chat.send run (= clientMsgId), else null (HTTP rows carry chatcmpl_… ids). */
export const assistantRunId = (m) => (m?.role === "assistant" && typeof m.__openclaw?.runId === "string" && CLIENT_MSG_ID_RE.test(m.__openclaw.runId) ? m.__openclaw.runId : null);
/** The first reply row of a run the ENGINE resumed after a restart (lab L5): `continuation.source === "restart"`. */
export const isResumedRow = (m) => m?.role === "assistant" && m.__openclaw?.continuation?.source === "restart";

/**
 * The answer a thread send gives for one failure, from the closed list (src/thread-keys.js DEFINITE_REFUSALS) or 502
 * outcome_unknown. Anything not recognised here is UNKNOWN: it may have reached the engine. Never `engine_unavailable`.
 */
export function classifySendError(err) {
  const c = err?.code;
  if (c === "bad_params") return { status: 400, error: "bad_request" };
  if (c === "too_large") return { status: 413, error: "too_large", reason: str(err.reason, 40) };
  if (c === "not_written") return { status: 503, error: "not_written" };
  if (c === "ack_lost" || c === "ack_timeout") return { status: 502, error: "outcome_unknown", reason: c };
  if (err?.refused) {
    const msg = String(err.message ?? "");
    if (c === "INVALID_REQUEST" && (err.reason === "chat-request-conflict" || /chat-request-conflict/.test(msg))) return { status: 409, error: "conflict" };
    if (c === "INVALID_REQUEST" && /\bis archived\b/i.test(msg)) return { status: 409, error: "archived" };
    if (c === "UNAVAILABLE" && /\bTRANSCRIPT_COLD\b/.test(`${msg} ${err.reason ?? ""}`)) return { status: 409, error: "cold" };
    if (c === "INVALID_REQUEST" && /exceeds size limit/i.test(msg)) return { status: 413, error: "too_large", reason: "engine_limit" };
    return { status: 502, error: "outcome_unknown", reason: "engine_refused" };
  }
  return { status: 502, error: "outcome_unknown", reason: "exception" };
}

/**
 * The global one-run cap (plan N1): ONE mutex around check-then-send for EVERY send path (legacy HTTP /send, thread send, resend),
 * and one check inside it:
 *   1. a legacy HTTP turn this bridge holds is running                         -> busy ("legacy")
 *   2. a send was accepted less than RECENT_ACCEPT_MS ago                       -> busy (its thread)
 *   3. ONE closed read `sessions.list SESSIONS_CAP_PARAMS` over the admin link; any active app key -> busy (its thread).
 *      The read failed, or is incomplete (totalCount above the rows, hasMore)   -> busy_unknown (fail closed)
 * cron and WhatsApp never count, as today.
 */
export function createSendGate({ link, now = Date.now, legacyRunning = () => false, recentAcceptMs = RECENT_ACCEPT_MS }) {
  let chain = Promise.resolve();
  let lastAccepted = null;
  const busy = (thread) => ({ ok: false, status: 409, error: "busy", busyThread: thread });
  const unknown = { ok: false, status: 503, error: "busy_unknown" };
  return {
    /** fn runs alone: the next send's check starts only after this one has been answered (accepted or refused). */
    exclusive(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; },
    async check() {
      if (legacyRunning()) return busy("legacy");
      if (lastAccepted && now() - lastAccepted.at < recentAcceptMs) return busy(lastAccepted.thread);
      if (!link?.isUp?.()) return unknown;
      let r;
      try { r = await link.request("sessions.list", { ...SESSIONS_CAP_PARAMS }, { timeoutMs: CAP_READ_TIMEOUT_MS }); } catch { return unknown; }
      const rows = r?.sessions;
      if (!Array.isArray(rows) || !Number.isSafeInteger(r.totalCount) || r.totalCount < 0 || r.totalCount > rows.length || r.hasMore === true) return unknown;
      for (const row of rows) { const t = threadOfKey(row?.key); if (t !== null) return busy(t); }
      return { ok: true };
    },
    noteAccepted(thread) { lastAccepted = { at: now(), thread }; },
  };
}

/** Live state of the runs this bridge started, from the write link's chat events (deltaText/final/error/aborted, lab L3). */
export function createThreadRuns({ writeLink, now = Date.now, messageText }) {
  const runs = new Map();
  writeLink?.onEvent?.((name, p) => {
    if (name !== "chat" || !p || typeof p.runId !== "string") return;
    const r = runs.get(p.runId);
    if (!r || p.sessionKey !== r.qualified) return;
    if (p.state === "status") r.phase = str(p.phase, 40);
    else if (p.state === "delta" && typeof p.deltaText === "string") { r.firstTokenAt ??= now(); r.text = p.replace === true ? p.deltaText : r.text + p.deltaText; }
    else if (p.state === "final") { r.status = "done"; r.finishedAt = now(); const t = p.message ? messageText(p.message) : ""; if (t) r.text = t; }
    else if (p.state === "aborted") { r.status = "stopped"; r.finishedAt = now(); }
    else if (p.state === "error") {
      r.status = "error"; r.finishedAt = now();
      r.errorCode = /\bis archived\b/i.test(String(p.errorMessage ?? "")) ? "archived" : p.errorKind === "rate_limit" ? "rate_limited" : null;
    }
  });
  return {
    start(runId, tid, qualified) {
      if (runs.has(runId)) return runs.get(runId);
      const r = { runId, tid, qualified, status: "running", text: "", phase: null, startedAt: now(), firstTokenAt: null, finishedAt: null, errorCode: null, steps: [], stepsAt: 0 };
      runs.set(runId, r);
      while (runs.size > MAX_LIVE_RUNS) runs.delete(runs.keys().next().value);
      return r;
    },
    get: (runId) => runs.get(runId) ?? null,
    drop: (runId) => { runs.delete(runId); },
  };
}

/** Bounded serial queues by key; an entry is removed once its last job settled (review m1). */
export function createKeyedSerial() {
  const queues = new Map();
  const run = (key, fn) => {
    const p = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = p.catch(() => {});
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return p;
  };
  run.size = () => queues.size;
  return run;
}

/**
 * The rows of ONE turn K in a history page (review/Codex): from K's user row up to (not including) the next user row. The engine's
 * restart-resume input is hidden from history (lab L5), so a later user row always starts a later turn.
 */
export function turnSegment(rows, K) {
  const at = Array.isArray(rows) ? rows.findIndex((m) => userRowRunId(m) === K) : -1;
  if (at < 0) return null;
  const rest = rows.slice(at + 1);
  const next = rest.findIndex((m) => m?.role === "user");
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * Read-only reconciliation of one clientMsgId K in one conversation (plan §4.1): pages chat.history back until a row older than
 * `since` (or the start), looking for the user row tag "<K>:user", and asks agent.wait {runId:K, timeoutMs:0}. Never sends anything.
 * `complete` is false when the history could not be read back far enough: callers must fail closed.
 */
export async function reconcile(link, qualified, K, since) {
  if (!link?.isUp?.()) return { complete: false, found: false, wait: null };
  let found = false; let complete = false; let anchor = null;
  try {
    for (let page = 0; page < RECONCILE_MAX_PAGES && !found && !complete; page++) {
      const r = await link.request("chat.history", { sessionKey: qualified, limit: RECONCILE_PAGE, ...(anchor ? { messageId: anchor } : {}) }, { timeoutMs: READ_TIMEOUT_MS });
      let rows = Array.isArray(r?.messages) ? r.messages : null;
      if (!rows) break;
      if (anchor) { const at = rows.findIndex((m) => m?.__openclaw?.id === anchor); if (at < 0) break; rows = rows.slice(0, at); }
      if (rows.some((m) => userRowRunId(m) === K)) { found = true; break; }
      const oldest = rows.find((m) => typeof m?.__openclaw?.id === "string");
      const oldestAt = Number(rows[0]?.timestamp);
      if (Number.isFinite(oldestAt) && oldestAt < since - RECONCILE_SKEW_MS) { complete = true; break; } // read back past the original send, with skew margin
      // more rows before these? an anchored page must SAY so (anchor.hasOlder); not knowing is incomplete, never "nothing older"
      const more = anchor ? (typeof r?.anchor?.hasOlder === "boolean" ? r.anchor.hasOlder : null) : r?.hasMore === true || rows.length >= RECONCILE_PAGE;
      if (more === null) break;
      if (!more) { complete = true; break; }
      if (!oldest || !MESSAGE_ID_RE.test(oldest.__openclaw.id)) break;
      anchor = oldest.__openclaw.id;
    }
  } catch { return { complete: false, found, wait: null }; }
  let wait = null;
  try {
    const w = await link.request("agent.wait", { runId: K, timeoutMs: 0 }, { timeoutMs: READ_TIMEOUT_MS });
    wait = str(w?.status, 20);
  } catch (err) {
    if (!err?.refused) return { complete: false, found, wait: null }; // no answer: unknown, fail closed
  }
  return { complete: found || complete, found, wait };
}

/**
 * ctx: { router, link, writeLink, gatewayCall, now, log, boot(), gate, mapRows(key, rows), messageText, models: {mapModel, modelRef, levelIds},
 *        media: { ...mediaCtx, cache, gatewayCall } }
 */
export function registerThreadRoutes(router, ctx) {
  const { link, writeLink, gatewayCall, now = Date.now, log, gate } = ctx;
  const runs = createThreadRuns({ writeLink, now, messageText: ctx.messageText });
  const sends = new Map(); // clientMsgId -> { tid, at, sessionSha256, bodySha256 }: this process only (the API holds the durable record)
  const remember = (K, rec) => { sends.set(K, rec); while (sends.size > MAX_SEND_RECORDS) sends.delete(sends.keys().next().value); };
  const reply = (res, status, error, extra = {}) => res.status(status).json({ ok: false, error, ...extra });
  const bad = (res, reason) => reply(res, 400, "bad_request", reason ? { reason } : {});
  const linkDown = (res) => reply(res, 503, link ? "link_down" : "not_available");
  // the tid exactly as it appears in the raw path: a percent-encoded tid is refused, never decoded (review m8)
  const keysOf = (req, res) => {
    const raw = String(req.path ?? "").split("/")[2];
    const k = raw === req.params.tid ? threadKeys(req.params.tid) : null;
    if (!k) bad(res, "bad_tid");
    return k;
  };
  const legacyBusy = (k) => k.tid === "legacy" && ctx.legacyResetActive?.() === true; // «محادثة جديدة» of the legacy conversation under way (m5)
  const failRead = (res, err, what) => {
    if (err?.code === "link_down") return linkDown(res);
    log?.warn?.("app-bridge", `threads ${what}: ${err?.code ?? err?.message ?? err}`);
    return reply(res, 502, "engine_unavailable");
  };

  async function describe(qualified) {
    const d = await link.request("sessions.describe", { key: qualified }, { timeoutMs: READ_TIMEOUT_MS });
    if (!d || typeof d !== "object" || !("session" in d)) throw Object.assign(new Error("describe: unexpected shape"), { code: "bad_shape" });
    const s = d.session;
    if (s !== null && (typeof s !== "object" || s.key !== qualified)) throw Object.assign(new Error("describe: unexpected session"), { code: "bad_shape" });
    return s; // null = a conversation that has never had a turn (lab L1: {session:null})
  }

  /** The shared body checks of send and resend. Returns {message, attachments, bodySha256} or answers 400/413 itself. */
  function parseBody(req, res, k) {
    const message = typeof req.body?.message === "string" ? req.body.message : "";
    const pics = parseImages(req.body?.images);
    if (pics.error) {
      if (pics.error === "image_too_large" || pics.error === "images_too_large") { reply(res, 413, "too_large", { reason: pics.error }); return null; }
      bad(res, pics.error); return null;
    }
    if ((!message.trim() && !pics.images.length) || message.length > MAX_MESSAGE_CHARS) { bad(res, "bad_message"); return null; }
    if (commandRefusal(message)) { reply(res, 400, "command_not_allowed"); return null; }
    const attachments = pics.images.map((im, i) => ({ type: "image", mimeType: im.mime, fileName: `image-${i + 1}.${MIME_EXT[im.mime]}`, content: im.data }));
    const bodySha256 = sha256(JSON.stringify([k.tid, message, pics.images.map((im) => sha256(im.data))]));
    return { message, attachments, bodySha256 };
  }

  /** chat.send once over the write link and answer with the closed contract. Must run inside gate.exclusive. */
  async function dispatch(res, k, K, body, sessionSha256, extra = {}) {
    let ack;
    // the live record exists BEFORE the write: terminal events that arrive while the ack is still awaited (or after an ack
    // timeout) are not lost (review I2). A definite refusal removes it again.
    const existed = runs.get(K) !== null;
    runs.start(K, k.tid, k.qualified);
    try {
      ack = await writeLink.chatSend({ sessionKey: k.unqualified, message: body.message, idempotencyKey: K, attachments: body.attachments });
    } catch (err) {
      const c = classifySendError(err);
      if (c.error === "outcome_unknown") gate.noteAccepted(k.tid); // it may be running: it counts for the one-run cap
      else if (!existed) runs.drop(K);
      log?.warn?.("app-bridge", `thread send: ${c.error}${c.reason ? ` (${c.reason})` : ""}`);
      return reply(res, c.status, c.error, c.reason ? { reason: c.reason } : {});
    }
    try {
      gate.noteAccepted(k.tid);
      const status = ["started", "in_flight", "ok"].includes(ack?.status) ? ack.status : null;
      let sha = sessionSha256;
      if (!sha) { try { const s = await describe(k.qualified); sha = s?.sessionId ? sha256(s.sessionId) : null; } catch { sha = null; } }
      remember(K, { tid: k.tid, at: sends.get(K)?.at ?? now(), sessionSha256: sha, bodySha256: body.bodySha256 });
      if (!status) return reply(res, 502, "outcome_unknown", { reason: "unexpected_ack" });
      return res.status(202).json({ ok: true, runId: K, thread: k.tid, ack: status, boot: ctx.boot(), sessionSha256: sha, ...extra });
    } catch {
      return reply(res, 502, "outcome_unknown", { reason: "exception" }); // written and acknowledged, but the answer could not be built
    }
  }

  router.post("/threads/search", async (req, res) => {
    const q = typeof req.body?.q === "string" ? req.body.q.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
    const tids = req.body?.tids;
    if (!q || q.length > 200 || !Array.isArray(tids) || !tids.length || tids.length > MAX_SEARCH_TIDS) return bad(res);
    const keys = [];
    for (const t of tids) { const k = threadKeys(t); if (!k) return bad(res, "bad_tid"); if (!keys.some((x) => x.tid === k.tid)) keys.push(k); }
    if (!gatewayCall) return reply(res, 503, "not_available");
    try {
      const results = [];
      let i = 0;
      for (; i < keys.length && results.length < SEARCH_LIMIT; i += SEARCH_BATCH) {
        const batch = keys.slice(i, i + SEARCH_BATCH);
        const byKey = new Map(batch.map((k) => [k.qualified, k.tid]));
        const r = await gatewayCall("sessions.search", { query: q, sessionKeys: [...byKey.keys()], limit: SEARCH_LIMIT });
        for (const x of Array.isArray(r?.results) ? r.results : []) {
          const tid = byKey.get(x?.sessionKey);
          if (!tid || (x.role !== "user" && x.role !== "assistant") || !MESSAGE_ID_RE.test(String(x.messageId))) continue;
          const snippet = ctx.cleanSnippet(x.snippet);
          if (snippet) results.push({ tid, messageId: x.messageId, role: x.role, at: Number(x.timestamp) || 0, snippet });
        }
      }
      res.json({ ok: true, results: results.slice(0, SEARCH_LIMIT), truncated: i < keys.length });
    } catch (err) {
      if (err?.refused) return reply(res, 400, "rejected");
      failRead(res, err, "search");
    }
  });

  router.get("/threads/:tid/history", async (req, res) => {
    const k = keysOf(req, res); if (!k) return;
    const limit = Math.min(Math.max(intOr(req.query.limit, 50), 1), HISTORY_MAX_LIMIT);
    const before = req.query.before === undefined ? null : String(req.query.before);
    if (before !== null && !MESSAGE_ID_RE.test(before)) return bad(res, "bad_cursor");
    if (!link?.isUp?.()) return linkDown(res);
    try {
      // an anchored window spans both sides of the anchor: ask for 2*limit+1, never above the link's own cap (review I1)
      const r = await link.request("chat.history", { sessionKey: k.qualified, limit: before ? Math.min(2 * limit + 1, CHAT_HISTORY_MAX) : limit, ...(before ? { messageId: before } : {}) },
        { timeoutMs: READ_TIMEOUT_MS });
      let rows = Array.isArray(r?.messages) ? r.messages : [];
      let found = true;
      if (before) { const at = rows.findIndex((m) => m?.__openclaw?.id === before); found = at >= 0; rows = found ? rows.slice(Math.max(0, at - limit), at) : []; }
      const messages = ctx.mapRows(k.qualified, rows);
      const oldest = rows.find((m) => typeof m?.__openclaw?.id === "string" && MESSAGE_ID_RE.test(m.__openclaw.id))?.__openclaw.id ?? null;
      const more = before ? r?.anchor?.hasOlder === true || rows.length >= limit : r?.hasMore === true || rows.length >= limit;
      res.json({ ok: true, thread: k.tid, messages, earlier: more && oldest ? oldest : null, found });
    } catch (err) { failRead(res, err, "history"); }
  });

  const media = mediaHandler({ ...ctx.media, readable: () => true,
    findMessage: async (key, messageId) => {
      const r = await link.request("chat.history", { sessionKey: key, messageId, limit: 1 }, { timeoutMs: READ_TIMEOUT_MS });
      return (Array.isArray(r?.messages) ? r.messages : []).find((m) => m?.__openclaw?.id === messageId) ?? null;
    } }, (req) => threadKeys(req.params.tid)?.qualified);
  router.get("/threads/:tid/media", (req, res) => {
    const k = keysOf(req, res); if (!k) return undefined;
    if (!link?.isUp?.()) return linkDown(res);
    return media(req, res);
  });

  router.post("/threads/:tid/send", async (req, res) => {
    const k = keysOf(req, res); if (!k) return;
    const K = req.body?.clientMsgId;
    if (!isClientMsgId(K)) return bad(res, "bad_client_msg_id");
    const body = parseBody(req, res, k); if (!body) return;
    // the normal send path NEVER calls the engine again for an id it has seen (the API turns a repeat into a status read)
    if (sends.has(K)) return reply(res, 409, ALREADY_SENT);
    await gate.exclusive(async () => {
      const c = await gate.check();
      if (!c.ok) return reply(res, c.status, c.error, c.busyThread ? { busyThread: c.busyThread } : {});
      if (legacyBusy(k)) return reply(res, 409, "busy", { busyThread: "legacy" });
      // after a bridge restart the in-memory record is gone: ask the ENGINE whether this id already ran (in any conversation, m3)
      let w;
      try { w = await link.request("agent.wait", { runId: K, timeoutMs: 0 }, { timeoutMs: READ_TIMEOUT_MS }); } catch { return reply(res, 503, "not_written", { reason: "precheck_failed" }); }
      if (w?.status === "ok" || w?.status === "error") return reply(res, 409, ALREADY_SENT);
      let s;
      try { s = await describe(k.qualified); } catch { return reply(res, 503, "not_written", { reason: "precheck_failed" }); }
      if (s?.archived === true) return reply(res, 409, "archived");
      const sessionSha256 = s?.sessionId ? sha256(s.sessionId) : null;
      remember(K, { tid: k.tid, at: now(), sessionSha256, bodySha256: body.bodySha256 });
      return dispatch(res, k, K, body, sessionSha256);
    });
  });

  router.get("/threads/:tid/sends/:clientMsgId", async (req, res) => {
    const k = keysOf(req, res); if (!k) return;
    const K = req.params.clientMsgId;
    if (!isClientMsgId(K)) return bad(res, "bad_client_msg_id");
    const since = intOr(req.query.since, NaN);
    if (!Number.isSafeInteger(since) || since < 0) return bad(res, "bad_since");
    const r = await reconcile(link, k.qualified, K, since);
    // agent.wait is global to the engine: its answer is reported only for a run found in THIS conversation (review m2)
    res.json({ ok: true, thread: k.tid, runId: K, found: r.found, complete: r.complete, wait: r.found ? r.wait : null, boot: ctx.boot() });
  });

  router.post("/threads/:tid/sends/:clientMsgId/resend", async (req, res) => {
    const k = keysOf(req, res); if (!k) return;
    const K = req.params.clientMsgId;
    if (!isClientMsgId(K)) return bad(res, "bad_client_msg_id");
    const body = parseBody(req, res, k); if (!body) return;
    const notAllowed = (reason) => reply(res, 409, "resend_not_allowed", { reason });
    const originalAt = req.body?.originalAt;
    const expected = req.body?.sessionSha256;
    const previous = req.body?.previousRefusal;
    if (!Number.isSafeInteger(originalAt) || originalAt <= 0) return bad(res, "bad_original_at");
    if (expected !== null && !(typeof expected === "string" && SHA256_RE.test(expected))) return bad(res, "bad_session");
    if (previous !== undefined && previous !== null && typeof previous !== "string") return bad(res, "bad_refusal");
    if (typeof previous === "string" && NEVER_RESEND.includes(previous)) return notAllowed("refusal_final");
    const rec = sends.get(K);
    if (rec && rec.tid !== k.tid) return notAllowed("other_thread");
    if (rec && rec.bodySha256 !== body.bodySha256) return reply(res, 409, "conflict");
    const at = Math.min(originalAt, rec?.at ?? originalAt);
    if (now() - at > RESEND_WINDOW_MS || originalAt > now() + 60_000) return notAllowed("window");
    await gate.exclusive(async () => {
      const c = await gate.check();
      if (!c.ok) return reply(res, c.status, c.error, c.busyThread ? { busyThread: c.busyThread } : {});
      if (legacyBusy(k)) return reply(res, 409, "busy", { busyThread: "legacy" });
      let s;
      try { s = await describe(k.qualified); } catch { return notAllowed("precheck_failed"); }
      if (s?.archived === true) return reply(res, 409, "archived");
      // the bridge's OWN comparison (lab L10: the chat.send sessionId param does not guard): same engine session as at the original send
      const current = s?.sessionId ? sha256(s.sessionId) : null;
      const want = rec ? rec.sessionSha256 : expected;
      if (current !== want) return notAllowed("session_changed");
      const r = await reconcile(link, k.qualified, K, at);
      if (!r.complete) return notAllowed("reconcile_incomplete");
      if (r.found || r.wait === "ok" || r.wait === "error") return notAllowed("already_received");
      return dispatch(res, k, K, body, current, { resent: true });
    });
  });

  router.get("/threads/:tid/runs/:runId", async (req, res) => {
    const k = keysOf(req, res); if (!k) return;
    const K = req.params.runId;
    if (!isClientMsgId(K)) return bad(res, "bad_run_id");
    const live = runs.get(K);
    if (live && live.tid !== k.tid) return reply(res, 404, "not_found");
    if (!link?.isUp?.() && !live) return linkDown(res);
    // The engine's own record: history rows tagged with K (bounded to K's turn), the resumed run, and agent.wait {timeoutMs:0}.
    // Read for every poll of a finished or unknown run, and at most every 1.5 s for a live one, whose terminal event may have been
    // missed (a write-link drop/reconnect, an ack timeout): the engine then decides, never the stale cache (review I2).
    let rows = null; let wait = null;
    if (link?.isUp?.() && (!live || live.status !== "running" || now() - live.stepsAt >= 1500)) {
      try {
        const h = await link.request("chat.history", { sessionKey: k.qualified, limit: 50 }, { timeoutMs: READ_TIMEOUT_MS });
        rows = Array.isArray(h?.messages) ? h.messages : [];
        if (live) live.stepsAt = now();
      } catch { rows = null; }
      try { wait = str((await link.request("agent.wait", { runId: K, timeoutMs: 0 }, { timeoutMs: READ_TIMEOUT_MS }))?.status, 20); } catch { wait = null; }
    }
    if (!live && rows === null) return reply(res, 502, "engine_unavailable"); // could not read: never reported as "no such run"
    const seg = rows ? turnSegment(rows, K) : null;
    // m2: with no live record, a run is reported only when K's own user row is in THIS conversation (agent.wait is engine-global)
    if (!live && seg === null) return reply(res, 404, "not_found");
    const after = seg ?? [];
    const own = after.filter((m) => assistantRunId(m) === K);
    // the continuation run of THIS turn only (Codex): the first restart-continued reply inside K's segment, and only its own rows
    const first = after.find((m) => isResumedRow(m) && m.__openclaw?.runId !== K);
    const resumedId = first ? first.__openclaw.runId : null;
    const resumedRows = resumedId ? after.filter((m) => m.role === "assistant" && m.__openclaw?.runId === resumedId) : [];
    const resumed = resumedRows.length ? { runId: str(resumedId, 100), text: ctx.messageText(resumedRows.at(-1)) } : null;
    if (live && live.status === "running") {
      if (rows) live.steps = stepsFrom(after, 0);
      if (wait === "ok" || wait === "error") {
        live.status = wait === "ok" ? "done" : "error"; live.finishedAt = now();
        if (own.length) live.text = ctx.messageText(own.at(-1));
      } else if (resumed) { live.status = "unknown"; live.finishedAt = now(); } // K was interrupted; the engine continued it in another run
    }
    const status = live ? live.status : wait === "ok" ? "done" : wait === "error" ? "error" : "unknown";
    const text = live ? live.text : own.length ? ctx.messageText(own.at(-1)) : "";
    res.json({ ok: true, runId: K, thread: k.tid, status, text: ctx.cleanLiveText(text, { streaming: status === "running" }), phase: live?.phase ?? null,
      steps: live ? live.steps : stepsFrom(after, 0), startedAt: live?.startedAt ?? null, finishedAt: live?.finishedAt ?? null,
      ...(live?.errorCode ? { errorCode: live.errorCode } : {}),
      // the engine continued this turn in a NEW run after a restart (lab L5): shown as what it is, never re-executed by the bridge
      interrupted: resumed !== null, resumed, boot: ctx.boot() });
  });

  router.post("/threads/:tid/runs/:runId/abort", async (req, res) => {
    const k = keysOf(req, res); if (!k) return;
    const K = req.params.runId;
    if (!isClientMsgId(K)) return bad(res, "bad_run_id");
    try {
      const r = await writeLink.chatAbort({ sessionKey: k.unqualified, runId: K });
      res.json({ ok: true, aborted: r?.aborted === true });
    } catch (err) {
      if (err?.refused) return reply(res, 400, "rejected");
      const c = classifySendError(err);
      reply(res, c.status, c.error, c.reason ? { reason: c.reason } : {});
    }
  });

  // ---- per-conversation settings: one write at a time per key; a change while a run is active is refused (it would be overwritten) ----
  const keyed = createKeyedSerial();
  // m5: the legacy conversation's settings share the legacy routes' ONE queue (which also forgets the legacy describe cache)
  const serialFor = (k, fn) => (k.tid === "legacy" && ctx.legacySerial ? ctx.legacySerial(fn) : keyed(k.qualified, fn));
  const needCall = (res) => { if (gatewayCall && link) return false; reply(res, 503, "not_available"); return true; };
  async function modelsFor(qualified) {
    const r = await gatewayCall("models.list", { agentId: "main", sessionKey: qualified, view: "default", includeDetails: true });
    if (!Array.isArray(r?.models)) throw new Error("models.list: no models array");
    const seen = new Set();
    return r.models.map(ctx.models.mapModel).filter((m) => m && !seen.has(m.id) && seen.add(m.id));
  }
  const settingsView = (k, s) => ({
    ok: true, thread: k.tid, started: s !== null,
    model: s ? { id: ctx.models.modelRef(s.modelProvider, s.model), source: s.modelOverrideSource === "user" ? "override" : s.modelOverrideSource === "auto" ? "fallback" : "default" }
      : { id: null, source: "default" },
    thinking: s ? { level: str(s.thinkingLevel, 40), default: str(s.thinkingDefault, 40), levels: ctx.models.levelIds(s.thinkingLevels) } : { level: null, default: null, levels: [] },
    fast: s ? { enabled: typeof s.effectiveFastMode === "boolean" ? s.effectiveFastMode : null, source: str(s.effectiveFastModeSource, 40) } : { enabled: null, source: null },
    archived: s?.archived === true,
  });
  for (const what of ["model", "thinking", "fast"]) {
    router.get(`/threads/:tid/${what}`, async (req, res) => {
      const k = keysOf(req, res); if (!k) return;
      if (needCall(res)) return;
      try { res.json(settingsView(k, await describe(k.qualified))); } catch (err) { failRead(res, err, what); }
    });
  }
  router.post("/threads/:tid/model", (req, res) => {
    const k = keysOf(req, res); if (!k) return undefined;
    if (needCall(res)) return undefined;
    const want = typeof req.body?.model === "string" ? req.body.model.trim() : "";
    if (!want || want.length > 200) return bad(res);
    return serialFor(k, async () => {
      try {
        const s = await describe(k.qualified);
        if (s === null) return reply(res, 409, "not_started"); // a new conversation runs on the default model until its first turn
        if (s.hasActiveRun === true) return reply(res, 409, "busy");
        if (want !== "default") {
          const row = (await modelsFor(k.qualified)).find((m) => m.id === want);
          if (!row) return bad(res, "unknown_model");
          if (!row.available) return bad(res, "model_unavailable"); // m6: as the legacy route
          if (!row.selectable) return bad(res, "model_not_selectable");
        }
        await gatewayCall("sessions.patch", { key: k.qualified, model: want === "default" ? null : want });
        res.json(settingsView(k, await describe(k.qualified)));
      } catch (err) { if (err?.refused) return reply(res, 400, "rejected"); failRead(res, err, "model patch"); }
      return undefined;
    });
  });
  router.post("/threads/:tid/thinking", (req, res) => {
    const k = keysOf(req, res); if (!k) return undefined;
    if (needCall(res)) return undefined;
    const level = typeof req.body?.level === "string" ? req.body.level.trim() : "";
    if (!level || level.length > 40) return bad(res);
    return serialFor(k, async () => {
      try {
        const s = await describe(k.qualified);
        if (s === null) return reply(res, 409, "not_started");
        if (s.hasActiveRun === true) return reply(res, 409, "busy");
        if (level !== "default" && !ctx.models.levelIds(s.thinkingLevels).includes(level)) return bad(res, "unsupported_level");
        await gatewayCall("sessions.patch", { key: k.qualified, thinkingLevel: level === "default" ? null : level });
        res.json({ ok: true, thread: k.tid, thinking: { level: level === "default" ? null : level } });
      } catch (err) { if (err?.refused) return reply(res, 400, "rejected"); failRead(res, err, "thinking patch"); }
      return undefined;
    });
  });

  const FAST = { on: true, off: false, default: null };
  router.post("/threads/:tid/fast", (req, res) => {
    const k = keysOf(req, res); if (!k) return undefined;
    if (needCall(res)) return undefined;
    const mode = typeof req.body?.mode === "string" ? req.body.mode.trim() : "";
    if (!Object.hasOwn(FAST, mode)) return bad(res);
    return serialFor(k, async () => {
      try {
        const s = await describe(k.qualified);
        if (s === null) return reply(res, 409, "not_started");
        if (s.hasActiveRun === true) return reply(res, 409, "busy");
        if (mode === "on") {
          const row = (await modelsFor(k.qualified)).find((m) => m.id === ctx.models.modelRef(s.modelProvider, s.model));
          if (!row?.supportsFastMode) return bad(res, "fast_mode_unsupported");
        }
        await gatewayCall("sessions.patch", { key: k.qualified, fastMode: FAST[mode] });
        res.json({ ok: true, thread: k.tid, fast: { mode } });
      } catch (err) { if (err?.refused) return reply(res, 400, "rejected"); failRead(res, err, "fast patch"); }
      return undefined;
    });
  });

  // GET /threads/state?tids=a,b,…: engine-side state of up to 100 conversations the API names (archived, active run, last activity).
  // Read over the link with sessions.describe (it answers for archived keys too, lab E7); a conversation that cannot be read is
  // `unknown`, never "not archived".
  router.get("/threads/state", async (req, res) => {
    const raw = typeof req.query.tids === "string" ? req.query.tids.split(",") : [];
    if (!raw.length || raw.length > 100) return bad(res);
    const keys = [];
    for (const t of raw) { const k = threadKeys(t); if (!k) return bad(res, "bad_tid"); if (!keys.some((x) => x.tid === k.tid)) keys.push(k); }
    if (!link?.isUp?.()) return linkDown(res);
    const out = {};
    for (let i = 0; i < keys.length; i += 5) {
      await Promise.all(keys.slice(i, i + 5).map(async (k) => {
        try {
          const s = await describe(k.qualified);
          out[k.tid] = s === null ? { exists: false } : { exists: true, archived: s.archived === true, archiveReason: str(s.archiveReason, 40),
            lastActivityAt: Number.isSafeInteger(s.lastActivityAt) ? s.lastActivityAt : null, hasActiveRun: s.hasActiveRun === true };
        } catch { out[k.tid] = { unknown: true }; }
      }));
    }
    res.json({ ok: true, threads: out });
  });

  router.post("/threads/:tid/restore", (req, res) => {
    const k = keysOf(req, res); if (!k) return undefined;
    if (needCall(res)) return undefined;
    return serialFor(k, async () => {
      try {
        const s = await describe(k.qualified);
        if (s === null) return reply(res, 404, "not_found");
        if (s.archived !== true) return res.json({ ok: true, thread: k.tid, restored: false });
        // restore needs expectedSessionId (lab P3); a session replaced meanwhile is refused by the gateway (session-changed)
        await gatewayCall("sessions.patch", { key: k.qualified, archived: false, expectedSessionId: String(s.sessionId ?? "") });
        res.json({ ok: true, thread: k.tid, restored: true });
      } catch (err) { if (err?.refused) return reply(res, 409, "rejected"); failRead(res, err, "restore"); }
      return undefined;
    });
  });

  return { runs, sends, definiteRefusals: DEFINITE_REFUSALS, parseTid, keyed };
}
