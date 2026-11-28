// BASHT gateway link (B0): ONE persistent loopback WebSocket from the wrapper to its own OpenClaw gateway.
//
// Why: every `openclaw gateway call` spawns a full Node process (~1.5 s CPU). That is fine for a rare settings write, not for
// approvals and live events. The gateway pushes what the app needs as WebSocket events; this module keeps one connection, turns
// the few events the app needs into small fixed records in a bounded in-memory ring, and offers a short allowlist of RPCs.
//
// Connection (verified against OpenClaw 2026.11.10, see docs/BASHT_APP_BRIDGE.md "B0"):
// - Gateway protocol v4 as documented in docs/gateway/protocol/handshake.md: wait for `connect.challenge`, send `connect`,
//   expect `hello-ok`. Node's built-in WebSocket; no extra dependency.
// - `client: { id: "gateway-client", mode: "backend" }` on direct loopback with the shared gateway token: the documented trusted
//   local backend path. No device identity, no pairing record, no device token; the gateway grants exactly the requested scopes.
// - Scopes `operator.read` + `operator.approvals` + `operator.admin`, cap `approvals`. Admin is needed because the gateway shows
//   gateway-owned approvals (turns from the app's HTTP endpoint, WhatsApp, cron) only to admin connections; without it the list is
//   empty and the approval is denied at once as "no-approval-route". The wrapper already holds the gateway token (full authority
//   through its CLI); this link adds no authority, and `request()` refuses every method outside LINK_METHODS below.
// - While this link is up it is an approval client: an exec that needs approval WAITS for an answer (up to the approval's own
//   expiry, 30 min by default) instead of being denied by `askFallback`. Nothing answers on its own: only a decision the owner
//   makes in the app (or Control UI / a chat channel) resolves it.
//
// Ring records carry fixed, trimmed fields only (no commands beyond a short preview, no paths, no env, no raw payloads).
import crypto from "node:crypto";
import { CLIENT_MSG_ID_RE, QUALIFIED_THREAD_KEY_RE, threadOfKey } from "./thread-keys.js";

export const APP_SESSION_KEY = "agent:main:app:owner";
export const LINK_SCOPES = Object.freeze(["operator.read", "operator.approvals", "operator.admin"]);
export const LINK_CAPS = Object.freeze(["approvals"]);
/**
 * The ONLY gateway methods this link will send. Reads, the one approval write, and `tts.speak` (BASHT's voice: it returns audio bytes
 * and writes nothing; its params are closed, see PARAM_VALIDATORS). Anything else is refused locally.
 */
export const LINK_METHODS = Object.freeze(new Set([
  "models.list", "sessions.describe",
  "exec.approval.list", "plugin.approval.list", "openclaw.approval.list", "approval.get", "approval.history", "approval.resolve",
  "tts.speak",
  "sessions.list", "cron.list", // read-only, fixed params: only to COUNT running work for GET /status (see src/app-bridge-runs.js)
]));
export const TTS_SPEAK_MAX_CHARS = 1500; // the same cap as POST /app/v1/speak
/**
 * Methods whose params the link checks itself before anything is sent (a closed shape). A method without an entry keeps the
 * gateway's own validation only. `tts.speak` takes `text` and nothing else: the gateway rejects any other param, and a voice, a
 * provider or a model must never ride along from this side.
 */
/** The ONLY params the link sends for the two counting reads (exact match, nothing else): active sessions (one row, we read `totalCount`) and compact cron jobs. */
export const SESSIONS_ACTIVE_PARAMS = Object.freeze({ activeOnly: true, limit: 1, includeGlobal: true, includeUnknown: true });
export const CRON_RUNNING_PARAMS = Object.freeze({ includeDisabled: true, limit: 200, compact: true, includeDeliveryPreviews: false });
/**
 * B4 (threads flag on only): the ONE read of the global one-run cap (plan N1). Every active session, up to 200 rows, so the bridge
 * can count the app's own keys. Its own closed validator: SESSIONS_ACTIVE_PARAMS (limit 1) stays exactly as it was.
 */
export const SESSIONS_CAP_PARAMS = Object.freeze({ activeOnly: true, limit: 200, includeGlobal: true, includeUnknown: true });
/** B4 (threads flag on only): reads the thread routes need, each with a closed validator below. Not in LINK_METHODS. */
export const THREAD_LINK_METHODS = Object.freeze(new Set(["chat.history", "agent.wait"]));
export const CHAT_HISTORY_MAX = 200;
export const AGENT_WAIT_MAX_MS = 2000;
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{6,100}$/;
// Own data properties only (an accessor could answer one value to this check and another to the serializer).
const sameParams = (expected) => {
  const want = Object.entries(expected);
  return (p) => isPlainObject(p) && Object.keys(p).length === want.length && want.every(([k, v]) => {
    const d = Object.getOwnPropertyDescriptor(p, k);
    return d !== undefined && "value" in d && d.value === v;
  });
};
const ownData = (p) => Object.values(Object.getOwnPropertyDescriptors(p)).every((d) => "value" in d);
const exactKeys = (p, required, optional = []) => {
  if (!isPlainObject(p) || !ownData(p)) return false;
  const ks = Object.keys(p);
  return required.every((k) => ks.includes(k)) && ks.every((k) => required.includes(k) || optional.includes(k));
};
const isCapList = sameParams(SESSIONS_CAP_PARAMS); // separate from the counting read on purpose: never widened by it
/** Closed params of the thread reads (only reachable with the threads flag on). Keys are the QUALIFIED form (§3.2). */
const THREAD_VALIDATORS = Object.freeze({
  "chat.history": (p) => exactKeys(p, ["sessionKey", "limit"], ["messageId"]) && typeof p.sessionKey === "string" && QUALIFIED_THREAD_KEY_RE.test(p.sessionKey)
    && Number.isSafeInteger(p.limit) && p.limit >= 1 && p.limit <= CHAT_HISTORY_MAX && (p.messageId === undefined || (typeof p.messageId === "string" && MESSAGE_ID_RE.test(p.messageId))),
  "agent.wait": (p) => exactKeys(p, ["runId", "timeoutMs"]) && typeof p.runId === "string" && CLIENT_MSG_ID_RE.test(p.runId)
    && Number.isSafeInteger(p.timeoutMs) && p.timeoutMs >= 0 && p.timeoutMs <= AGENT_WAIT_MAX_MS,
});
const PARAM_VALIDATORS = Object.freeze({
  "sessions.list": sameParams(SESSIONS_ACTIVE_PARAMS),
  // the bridge only ever describes an app key (qualified, exact): any other key is refused at the link (wrapper-level key check)
  "sessions.describe": (p) => exactKeys(p, ["key"]) && typeof p.key === "string" && QUALIFIED_THREAD_KEY_RE.test(p.key),
  "cron.list": sameParams(CRON_RUNNING_PARAMS),
  "tts.speak": (p) => isPlainObject(p) && Object.keys(p).length === 1 && typeof p.text === "string" && p.text.length >= 1 && p.text.length <= TTS_SPEAK_MAX_CHARS,
});
/**
 * The link's own allowlist + closed param check, exported so tests (and fakes standing in for the link) apply EXACTLY the same
 * rules: null when the request may be sent, else "not_allowed" (method) or "bad_params" (params). Nothing is sent either way.
 */
export function validateLinkRequest(method, params, { threads = false } = {}) {
  const threadRead = threads && THREAD_LINK_METHODS.has(method);
  if (!LINK_METHODS.has(method) && !threadRead) return "not_allowed";
  const ok = threadRead ? THREAD_VALIDATORS[method](params)
    : method === "sessions.list" && threads ? (PARAM_VALIDATORS[method](params) || isCapList(params))
      : !PARAM_VALIDATORS[method] || PARAM_VALIDATORS[method](params);
  return ok ? null : "bad_params";
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
export const APPROVAL_KINDS = Object.freeze({ exec: "exec", plugin: "plugin", openclaw: "system-agent" });
const LIST_METHOD = { exec: "exec.approval.list", plugin: "plugin.approval.list", "system-agent": "openclaw.approval.list" };
export const RING_SIZE = 500;
export const MAX_SUMMARY = 300;
const SYNC_RETRY_MS = [2_000, 5_000, 15_000, 30_000];
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_TICK_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000; // a caller may ask for longer than the default (tts.speak: 60 s), never unbounded
const SEEN_APPROVALS = 2_000;
const PROTOCOL = 4;

const str = (v, max = 200) => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : null;
};
const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/** Where an approval or run came from, as a label only (never the raw key: WhatsApp keys carry phone numbers). */
export function sessionKind(key) {
  const k = typeof key === "string" ? key : "";
  if (k === APP_SESSION_KEY) return "app";
  if (k === "agent:main:main") return "main";
  if (/:whatsapp:/i.test(k)) return "whatsapp";
  if (/:cron:/i.test(k)) return "cron";
  return k ? "other" : "unknown";
}

/** B4 (flag on): sessionKind, with every app conversation key (legacy or thread) labelled "app". */
export const threadSessionKind = (key) => (threadOfKey(key) !== null ? "app" : sessionKind(key));

/** A pending approval record (list item or `*.approval.requested` payload) in the bridge's fixed shape. Null if unusable. */
/**
 * B4: the conversation an approval belongs to, from the engine's `request.sessionKey` AT REQUEST TIME: "legacy" or a tid for an app
 * key, null for any other known session (WhatsApp, main, cron: not an app thread), "unknown" when the key is absent (approval.get /
 * approval.history rows carry none, lab E5). Never guessed as the legacy conversation.
 */
export function approvalThread(sessionKey) {
  if (typeof sessionKey !== "string" || !sessionKey) return "unknown";
  return threadOfKey(sessionKey);
}

export function approvalView(rec, kind, { threads = false } = {}) {
  const id = str(rec?.id, 128);
  if (!id || !Object.values(APPROVAL_KINDS).includes(kind)) return null;
  const r = rec.request && typeof rec.request === "object" ? rec.request : {};
  // exec: the command (preview first when the gateway made one); plugin / system-agent: their own title or description
  const summary = str(r.commandPreview, MAX_SUMMARY) ?? str(r.command, MAX_SUMMARY) ?? str(r.title, MAX_SUMMARY)
    ?? str(r.description, MAX_SUMMARY) ?? str(r.toolName, MAX_SUMMARY) ?? null;
  const decisions = Array.isArray(r.allowedDecisions) ? r.allowedDecisions : ["allow-once", "deny"];
  return {
    id, kind, summary, title: str(r.title, 120), host: str(r.host, 20), agentId: str(r.agentId, 64),
    // B4 (flag on): every app conversation is the app's own (BUG-7); flag off: exactly as before
    session: threads ? threadSessionKind(r.sessionKey) : sessionKind(r.sessionKey),
    isApp: threads ? threadOfKey(r.sessionKey) !== null : r.sessionKey === APP_SESSION_KEY,
    warning: str(r.warningText, 200),
    createdAt: int(rec.createdAtMs), expiresAt: int(rec.expiresAtMs),
    // the app offers allow-once and deny only (allow-always would mint a standing grant)
    decisions: ["allow-once", "deny"].filter((d) => decisions.includes(d)),
    // B4, threads flag on only (flag off: the shape is exactly as before)
    ...(threads ? { thread: approvalThread(r.sessionKey), severity: str(r.severity, 20), toolName: str(r.toolName, 64) } : {}),
  };
}

const kindOfEvent = (name) => {
  const m = /^(exec|plugin|openclaw)\.approval\.(requested|resolved)$/.exec(name);
  return m ? { kind: APPROVAL_KINDS[m[1]], phase: m[2] } : null;
};

/**
 * One gateway event as a ring record without id/at, or null when the app does not need it.
 * Fixed fields only. `chat.*` is reported for the app session alone.
 */
export function normalizeEvent(name, p, { threads = false, threadOfApproval } = {}) {
  if (!p || typeof p !== "object") return null;
  const ap = kindOfEvent(name);
  if (ap?.phase === "requested") {
    const v = approvalView(p, ap.kind, { threads });
    return v ? { type: "approval.requested", approval: v } : null;
  }
  if (ap?.phase === "resolved") {
    const id = str(p.id, 128);
    if (!id) return null;
    const d = ["allow-once", "allow-always", "deny"].includes(p.decision) ? p.decision : null;
    const out = { type: "approval.resolved", approvalId: id, kind: ap.kind, decision: d, session: (threads ? threadSessionKind : sessionKind)(p.request?.sessionKey) };
    // the resolved payload may lack the key: the one recorded when the approval was raised wins
    if (threads) out.thread = threadOfApproval?.(id) ?? approvalThread(p.request?.sessionKey);
    return out;
  }
  if (name === "chat" && p.sessionKey === APP_SESSION_KEY && (p.state === "final" || p.state === "error") && !threads) {
    return { type: p.state === "final" ? "chat.final" : "chat.error", session: "app", runId: str(p.runId, 100) };
  }
  // B4 (flag on): every app conversation's final/error, tagged with its thread ("legacy" or the tid); `session` stays "app"
  if (threads && name === "chat" && (p.state === "final" || p.state === "error")) {
    const thread = threadOfKey(p.sessionKey);
    if (thread !== null) return { type: p.state === "final" ? "chat.final" : "chat.error", session: "app", runId: str(p.runId, 100), thread };
  }
  if (name === "cron" && p.action === "finished") {
    const job = p.job && typeof p.job === "object" ? p.job : {};
    const status = str(p.status, 20) ?? str(job.state?.lastRunStatus, 20) ?? str(job.state?.lastStatus, 20);
    const failed = status !== null && !["ok", "success", "skipped"].includes(status);
    return { type: failed ? "cron.failed" : "cron.finished", jobId: str(p.jobId ?? job.id, 100), name: str(job.name, 80), status };
  }
  return null;
}

/**
 * @param {{ url: string, token: string, log?: any, WebSocketImpl?: any, now?: () => number, ringSize?: number,
 *           clientVersion?: string, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout, random?: () => number }} o
 */
export function createGatewayLink({ url, token, log, WebSocketImpl = globalThis.WebSocket, now = Date.now, ringSize = RING_SIZE,
  clientVersion = "basht-bridge/1", setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random, threads = false }) {
  const epoch = crypto.randomBytes(6).toString("hex");
  let nextId = now(); // ids keep increasing across wrapper restarts (seeded with the boot time), the epoch says "new ring"
  const ring = [];
  const waiters = new Set();
  const pending = new Map(); // approval id -> { kind, sessionKey, expiresAt }
  const seenApprovals = new Set();
  // B4: approval id -> the session key it was raised for (kept after it is decided, bounded): approval.history has no key (E5)
  const approvalKeys = new Map();
  const terminalRuns = new Set(); // B4: runIds whose chat.final/chat.error was already put in the ring (bounded)
  const noteApprovalKey = (id, key) => {
    if (!threads || typeof key !== "string" || !key) return;
    approvalKeys.delete(id); approvalKeys.set(id, key);
    if (approvalKeys.size > SEEN_APPROVALS) approvalKeys.delete(approvalKeys.keys().next().value);
  };
  const threadOfApproval = (id) => (approvalKeys.has(id) ? approvalThread(approvalKeys.get(id)) : null);
  let decorate = (e) => e;

  let ws = null;
  let state = "off"; // off | connecting | up | down
  let since = now();
  let lastUpAt = null;
  let downSince = null;
  let reconnects = 0;
  let attempt = 0;
  let lastError = null;
  let reqSeq = 0;
  const inflight = new Map();
  let retryTimer = null;
  let watchdog = null;
  let tickMs = DEFAULT_TICK_MS;
  let syncAttempt = 0;
  let approvalsSynced = false; // true only once EVERY approval list was read on the CURRENT connection (an empty map before that is "unknown", not zero)
  let syncRetry = null; // retry timer for a resync that could not read every approval list (backoff; cleared on drop/stop)
  let syncGen = 0; // bumps on every (re)connect and drop: a resync that finishes after its connection ended must not mark the next one synced
  let serverVersion = null; // hello-ok `server.version` of the current connection (an engine version label, nothing else)
  let stopped = true;

  const setState = (s, err) => {
    if (state === s) return;
    state = s; since = now();
    if (err !== undefined) lastError = err;
    log?.info?.("gateway-link", `${s}${err ? ` (${err})` : ""}`);
  };

  function push(rec) {
    if (!rec) return;
    const e = decorate({ id: ++nextId, at: now(), ...rec });
    ring.push(e);
    while (ring.length > ringSize) ring.shift();
    for (const w of waiters) w();
  }

  function remember(id) {
    seenApprovals.add(id);
    if (seenApprovals.size > SEEN_APPROVALS) seenApprovals.delete(seenApprovals.values().next().value);
  }

  function trackApproval(view, sessionKey) {
    pending.set(view.id, { kind: view.kind, sessionKey: sessionKey ?? null, expiresAt: view.expiresAt });
    noteApprovalKey(view.id, sessionKey);
    if (seenApprovals.has(view.id)) return;
    remember(view.id);
    push({ type: "approval.requested", approval: view });
  }

  function onEvent(name, payload) {
    const ap = kindOfEvent(name);
    if (ap?.phase === "requested") {
      const v = approvalView(payload, ap.kind, { threads });
      if (v) trackApproval(v, payload.request?.sessionKey);
      return;
    }
    if (ap?.phase === "resolved") {
      const id = str(payload?.id, 128);
      if (id) pending.delete(id);
    }
    const rec = normalizeEvent(name, payload, { threads, threadOfApproval });
    // B4 (flag on): the engine can emit a second `final` for one run (an engine status notice after the reply, BUG-2): one
    // chat.final / chat.error per run on /events, so the app is told (and pushes) once
    if (threads && rec && (rec.type === "chat.final" || rec.type === "chat.error") && rec.runId) {
      if (terminalRuns.has(rec.runId)) return;
      terminalRuns.add(rec.runId);
      if (terminalRuns.size > SEEN_APPROVALS) terminalRuns.delete(terminalRuns.values().next().value);
    }
    push(rec);
  }

  const send = (frame) => { try { ws?.send(JSON.stringify(frame)); return true; } catch { return false; } };

  function armWatchdog() {
    clearTimer(watchdog);
    watchdog = setTimer(() => { const s = ws; ws = null; try { s?.close(4000, "stale"); } catch { /* ignore */ } dropped("stale"); }, Math.round(tickMs * 2.5));
    watchdog?.unref?.();
  }

  function rpc(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = `l${++reqSeq}`;
      const t = setTimer(() => { inflight.delete(id); reject(Object.assign(new Error(`${method} timed out`), { code: "timeout" })); }, timeoutMs);
      t?.unref?.();
      inflight.set(id, { resolve, reject, t });
      if (!send({ type: "req", id, method, params: params ?? {} })) {
        clearTimer(t); inflight.delete(id); reject(Object.assign(new Error("link_down"), { code: "link_down" }));
      }
    });
  }

  function failInflight(code) {
    for (const [id, f] of inflight) { clearTimer(f.t); f.reject(Object.assign(new Error(code), { code })); inflight.delete(id); }
  }

  /** After (re)connecting: the pending approvals are read again, and any that arrived while the link was down enter the ring. */
  async function resync() {
    const gen = syncGen;
    // Only approvals known BEFORE this resync can be forgotten, and only for kinds whose list was actually read: one that
    // arrives as a live event while the lists are being read stays pending (it is simply not in an earlier list answer).
    const before = new Map([...pending].map(([id, p]) => [id, p.kind]));
    const seen = new Set();
    const read = new Set();
    for (const [kind, method] of Object.entries(LIST_METHOD)) {
      let rows;
      try { rows = await rpc(method, {}); } catch { continue; }
      read.add(kind);
      for (const r of Array.isArray(rows) ? rows : []) {
        const v = approvalView(r, kind, { threads });
        if (!v) continue;
        seen.add(v.id);
        trackApproval(v, r.request?.sessionKey);
      }
    }
    for (const [id, kind] of before) if (!seen.has(id) && read.has(kind) && pending.get(id)?.kind === kind) pending.delete(id);
    if (gen !== syncGen || state !== "up") return;
    if (read.size === Object.keys(LIST_METHOD).length) { approvalsSynced = true; syncAttempt = 0; return; }
    // A list could not be read: stay "unknown" but try again (backoff), so a transient failure does not block releases until the next reconnect.
    clearTimer(syncRetry);
    const delay = SYNC_RETRY_MS[Math.min(syncAttempt, SYNC_RETRY_MS.length - 1)]; syncAttempt += 1;
    syncRetry = setTimeout(() => { if (gen === syncGen && state === "up") resync().catch(() => {}); }, delay);
    syncRetry.unref?.();
  }

  function dropped(reason) {
    clearTimer(watchdog);
    ws = null;
    syncGen += 1; approvalsSynced = false; syncAttempt = 0; clearTimer(syncRetry);
    failInflight("link_down");
    if (stopped) { setState("off"); return; }
    if (state === "up") { downSince = now(); push({ type: "gateway.down" }); }
    lastError = reason ?? lastError;
    setState("down", lastError);
    schedule();
  }

  function schedule(delayMs) {
    clearTimer(retryTimer);
    if (stopped) return;
    const base = delayMs ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt += 1;
    retryTimer = setTimer(connect, Math.round(base * (0.8 + random() * 0.4)));
    retryTimer?.unref?.();
  }

  function connect() {
    if (stopped || ws) return;
    if (typeof WebSocketImpl !== "function") { setState("down", "no_websocket"); return; }
    if (state !== "up") setState(state === "off" ? "connecting" : state);
    let sock;
    try { sock = new WebSocketImpl(url); } catch { lastError = "connect_failed"; setState("down", lastError); schedule(); return; }
    ws = sock;
    let helloDone = false;
    let why = null; // why THIS attempt ended
    const connectTimer = setTimer(() => { if (!helloDone) { why = "connect_timeout"; try { sock.close(); } catch { /* ignore */ } } }, CONNECT_TIMEOUT_MS);
    connectTimer?.unref?.();
    const closed = () => {
      clearTimer(connectTimer);
      if (ws !== sock) return;
      dropped(why ?? "closed");
    };
    sock.onclose = closed;
    sock.onerror = () => { why ??= "socket_error"; };
    sock.onmessage = (m) => {
      if (ws !== sock) return;
      let f;
      try { f = JSON.parse(typeof m.data === "string" ? m.data : String(m.data)); } catch { return; }
      if (helloDone) armWatchdog();
      if (f?.type === "res") {
        const w = inflight.get(f.id);
        if (!w) return;
        clearTimer(w.t); inflight.delete(f.id);
        if (f.ok) w.resolve(f.payload);
        else w.reject(Object.assign(new Error(str(f.error?.message, 200) ?? "gateway error"), { code: str(f.error?.code, 60) ?? "error", refused: true,
          reason: str(f.error?.details?.reason, 60), retryAfterMs: int(f.error?.details?.retryAfterMs) }));
        return;
      }
      if (f?.type !== "event") return;
      if (f.event === "connect.challenge" && !helloDone) {
        rpc("connect", {
          minProtocol: PROTOCOL, maxProtocol: PROTOCOL,
          client: { id: "gateway-client", version: clientVersion, platform: process.platform, mode: "backend" },
          role: "operator", scopes: [...LINK_SCOPES], caps: [...LINK_CAPS], auth: { token },
        }, CONNECT_TIMEOUT_MS).then((hello) => {
          helloDone = true;
          clearTimer(connectTimer);
          const granted = Array.isArray(hello?.auth?.scopes) ? hello.auth.scopes : [];
          if (!LINK_SCOPES.every((s) => granted.includes(s))) {
            why = "scopes_not_granted"; // e.g. a gateway that requires pairing for this client: never run half-authorized
            try { sock.close(4001, "scopes"); } catch { /* ignore */ }
            return;
          }
          tickMs = int(hello?.policy?.tickIntervalMs) || DEFAULT_TICK_MS;
          serverVersion = typeof hello?.server?.version === "string" && /^[0-9A-Za-z._+-]{1,40}$/.test(hello.server.version) ? hello.server.version : null;
          attempt = 0;
          const downFor = downSince ? now() - downSince : null;
          lastUpAt = now(); downSince = null; lastError = null;
          reconnects += 1;
          push({ type: "gateway.up", downForMs: downFor });
          syncGen += 1; approvalsSynced = false; syncAttempt = 0; clearTimer(syncRetry);
          setState("up");
          armWatchdog();
          resync().catch(() => {});
        }).catch((err) => {
          why = err?.code === "UNAVAILABLE" ? "gateway_starting" : str(err?.code, 60) ?? "connect_refused";
          if (err?.retryAfterMs) attempt = 0;
          try { sock.close(); } catch { /* ignore */ }
        });
        return;
      }
      if (helloDone && typeof f.event === "string") onEvent(f.event, f.payload);
    };
  }

  return {
    epoch,
    start() { if (!stopped) return; stopped = false; attempt = 0; connect(); },
    stop() {
      stopped = true; clearTimer(retryTimer); clearTimer(watchdog);
      const s = ws; ws = null; failInflight("link_down");
      try { s?.close(1000, "stop"); } catch { /* ignore */ }
      setState("off");
      for (const w of waiters) w();
    },
    /** Connect now instead of waiting for the backoff (e.g. right after the wrapper started the gateway). */
    kick() { if (!stopped && !ws) { clearTimer(retryTimer); attempt = 0; connect(); } },
    isUp: () => state === "up",
    status: () => ({ state, since, lastUpAt, reconnects: Math.max(0, reconnects - 1), lastError: state === "up" ? null : lastError, pendingApprovals: pending.size }),
    /** True only once every approval list was read on the CURRENT connection; before that `status().pendingApprovals` is not authoritative. */
    approvalsSynced: () => state === "up" && approvalsSynced,
    /** The engine version the gateway reported in hello-ok, or null (unknown / link never up). Costs nothing: no request is made. */
    serverVersion: () => serverVersion,
    /**
     * One allowlisted RPC over the link. Rejects with code "not_allowed" off the list, "bad_params" when the method's closed params
     * do not match (nothing is sent), "link_down" when the link is not up, "timeout" after `timeoutMs` (default 15 s, at most 120 s).
     * A timeout only stops WAITING: the gateway may still finish the work (a provider call is still billed), so callers must not
     * retry a call that costs money.
     */
    request(method, params, { timeoutMs } = {}) {
      const refused = validateLinkRequest(method, params, { threads });
      if (refused === "not_allowed") return Promise.reject(Object.assign(new Error(`${method} is not allowed on the link`), { code: "not_allowed" }));
      if (refused) return Promise.reject(Object.assign(new Error(`${method}: params not allowed`), { code: "bad_params" }));
      if (state !== "up") return Promise.reject(Object.assign(new Error("link_down"), { code: "link_down" }));
      const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_REQUEST_TIMEOUT_MS) : REQUEST_TIMEOUT_MS;
      return rpc(method, params, t);
    },
    /** Records with id > after (oldest first, at most `limit`). `truncated`: some records after `after` already left the ring. */
    events(after, limit = 100) {
      const a = Number.isSafeInteger(after) ? after : 0;
      const out = ring.filter((e) => e.id > a).slice(0, Math.max(1, Math.min(limit, 200)));
      const oldest = ring[0]?.id ?? null;
      return { epoch, latest: ring.at(-1)?.id ?? nextId, oldest, truncated: a > 0 && oldest !== null && a < oldest - 1, events: out };
    },
    /** Resolves when a record newer than `after` exists, after `ms`, or on `signal` abort. */
    waitForEvents(after, ms, signal) {
      if ((ring.at(-1)?.id ?? 0) > after || ms <= 0) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => { clearTimer(t); waiters.delete(done); signal?.removeEventListener?.("abort", done); resolve(); };
        const t = setTimer(done, ms);
        waiters.add(done);
        signal?.addEventListener?.("abort", done, { once: true });
      });
    },
    /** Latest expiry of a pending approval for this session (ms), or null. Lets a turn that waits on an approval outlive its timer. */
    approvalDeadline(sessionKey) {
      let max = null;
      const t = now();
      for (const p of pending.values()) if (p.sessionKey === sessionKey && p.expiresAt && p.expiresAt > t) max = Math.max(max ?? 0, p.expiresAt);
      return max;
    },
    /** Kind of a pending approval this link has seen (exec / plugin / system-agent), or null. */
    pendingKind: (id) => pending.get(id)?.kind ?? null,
    /** B4: the thread an approval was raised in (from its request.sessionKey at that time), or "unknown". Flag off: always null. */
    approvalThreadOf: (id) => (threads ? threadOfApproval(id) ?? "unknown" : null),
    threads,
    forgetApproval: (id) => { pending.delete(id); },
    /** The bridge adds facts only it knows (e.g. whether the app was watching when a reply finished). */
    setDecorator(fn) { decorate = typeof fn === "function" ? fn : (e) => e; },
  };
}
