// BASHT write link (batch 4, P2-B4-1): a SECOND loopback WebSocket from the wrapper to its own gateway, used ONLY for `chat.send`
// and `chat.abort` of the app's conversations. It never carries anything else, and `chat.send` never goes over the existing admin
// link (src/gateway-link.js): that link stays read/approvals only, exactly as before.
//
// Why a separate connection: a write is not a read. Its failure semantics must say whether the frame could have reached the engine,
// and the admin link maps both "frame never written" and "socket dropped while waiting" to one code (`failInflight("link_down")`,
// gateway-link.js). Here (plan N2):
//   not_written  the frame was NOT written (link not up, socket not OPEN, send() threw, closed params refused, frame too large)  DEFINITE
//   ack_lost     the frame was written, then the socket closed before the answer                                                  UNKNOWN
//   ack_timeout  the frame was written, no answer within the ack timeout                                                          UNKNOWN
//   too_large    refused BEFORE writing: an image above hello `policy.attachments.maxImageBytes`, the images above `maxBytes`,
//                or the encoded frame above `policy.maxPayload` (an oversize frame makes the gateway close the socket with 1009
//                and no answer, lab L2: it would turn every in-flight write into ack_lost)                                     DEFINITE
//   bad_params   the closed params did not validate (nothing written)                                                          DEFINITE
// A gateway answer with ok:false is `refused: true` with the gateway's code/reason/message (classified by the bridge).
// Never retried here, never re-sent on reconnect, never sent through the CLI instead.
//
// Connection parameters: ONE named configuration object, WRITE_LINK_CONFIG below.
import crypto from "node:crypto";
import { CLIENT_MSG_ID_RE, UNQUALIFIED_THREAD_KEY_RE } from "./thread-keys.js";

/**
 * PENDING OWNER DECISION D-B4-10.
 *
 * The approved plan §4.4 said chat.send never goes on an admin connection. The P2-B4-1 lab (L1 a/b/c/f) showed that a write-only
 * (or write+approvals) connection is NOT equivalent to the app's HTTP path: its turns run with senderIsOwner:false, memory written
 * from them is recorded as untrusted and quarantines MEMORY.md (sticky), exec approvals fail without operator.approvals, and
 * /model and /compact still execute. The lab's recommendation, used here as the default until the owner decides:
 *   - a SEPARATE link (never the admin link) with [operator.write, operator.admin, operator.approvals];
 *   - every chat.send carries suppressCommandInterpretation:true (requires admin scope), so "/…" and "!…" reach the model as text;
 *   - client id "gateway-client", mode "backend" (the gateway's client id is a closed enum; webchat/Control UI need an origin);
 *   - no caps (caps do not change the tool list, L1(e)); methods closed to chat.send / chat.abort; params closed (validators below).
 * Lab evidence for this configuration: senderIsOwner:true, memory provenance "agent", exec approval registered and resolvable from
 * the admin link, idempotency unchanged (`alt-link.jsonl`, L1-alt matrix row 3 "on").
 * L1-alt (D-B4-10 options) found NO non-admin configuration that keeps owner identity, trusted memory, approvals AND command
 * suppression: suppressCommandInterpretation is admin-only, and the only non-admin owner path ("Option B": write+approvals plus a
 * PRODUCTION config write `commands.ownerAllowFrom += "gateway-client"`) leaves /status, /model, /think and /compact executable,
 * with safety resting on the bridge filter alone. If the owner chooses B, change ONLY this object (scopes [operator.write,
 * operator.approvals], suppressCommandInterpretation:false) and make the ownerAllowFrom write a separately approved change
 * (docs/BASHT_THREADS_RELEASE.md). Options 1/2 (no owner entry) are rejected: untrusted, sticky memory quarantine.
 */
export const WRITE_LINK_CONFIG = Object.freeze({
  profile: "A", // plan v2.2 `writeLinkProfile`; reported in /status (flag on)
  decision: "D-B4-10",
  decisionStatus: "PENDING OWNER DECISION",
  role: "operator",
  client: Object.freeze({ id: "gateway-client", mode: "backend" }),
  scopes: Object.freeze(["operator.write", "operator.admin", "operator.approvals"]),
  caps: Object.freeze([]),
  suppressCommandInterpretation: true,
});

export const WRITE_METHODS = Object.freeze(new Set(["chat.send", "chat.abort"]));
export const MAX_SEND_CHARS = 8000;
export const MAX_ATTACHMENTS = 8;
export const ACK_TIMEOUT_MS = 15_000;
// conservative fallbacks when the gateway's hello-ok omits a limit (the documented defaults)
export const DEFAULT_LIMITS = Object.freeze({ maxPayload: 25 * 1024 * 1024, maxBytes: 20 * 1024 * 1024, maxImageBytes: 6 * 1024 * 1024 });
const FRAME_HEADROOM = 4096; // the frame envelope may differ slightly from what is measured here: keep a margin
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]);
const FILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_TICK_MS = 15_000;
const PROTOCOL = 4;
const OPEN = 1;

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const ownData = (p) => Object.values(Object.getOwnPropertyDescriptors(p)).every((d) => "value" in d);
const str = (v, max = 200) => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const decodedBytes = (b64) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

function validAttachment(a) {
  return isPlain(a) && ownData(a) && Object.keys(a).sort().join(",") === "content,fileName,mimeType,type" && a.type === "image"
    && IMAGE_MIMES.has(a.mimeType) && typeof a.fileName === "string" && FILE_NAME_RE.test(a.fileName)
    && typeof a.content === "string" && a.content.length > 0 && a.content.length % 4 === 0 && B64_RE.test(a.content);
}

/** The closed params of chat.send (own data properties, exact key set, exact shapes). `config` decides the suppress flag. */
export function validChatSendParams(p, config = WRITE_LINK_CONFIG) {
  if (!isPlain(p) || !ownData(p)) return false;
  const want = ["idempotencyKey", "message", "sessionKey", ...(config.suppressCommandInterpretation ? ["suppressCommandInterpretation"] : [])];
  const keys = Object.keys(p).filter((k) => k !== "attachments").sort();
  if (keys.join(",") !== want.sort().join(",")) return false;
  if (config.suppressCommandInterpretation && p.suppressCommandInterpretation !== true) return false;
  if (typeof p.sessionKey !== "string" || !UNQUALIFIED_THREAD_KEY_RE.test(p.sessionKey)) return false;
  if (typeof p.idempotencyKey !== "string" || !CLIENT_MSG_ID_RE.test(p.idempotencyKey)) return false;
  if (typeof p.message !== "string" || p.message.length > MAX_SEND_CHARS) return false;
  if ("attachments" in p && !(Array.isArray(p.attachments) && p.attachments.length >= 1 && p.attachments.length <= MAX_ATTACHMENTS && p.attachments.every(validAttachment))) return false;
  if (!p.message.trim() && !p.attachments) return false;
  return true;
}

/** The closed params of chat.abort: the unqualified key (accepted by the gateway, lab L1) and the run id (= clientMsgId). */
export function validChatAbortParams(p) {
  return isPlain(p) && ownData(p) && Object.keys(p).sort().join(",") === "runId,sessionKey"
    && typeof p.sessionKey === "string" && UNQUALIFIED_THREAD_KEY_RE.test(p.sessionKey) && typeof p.runId === "string" && CLIENT_MSG_ID_RE.test(p.runId);
}

/** The connect params of the write link, built from the config object only. */
export function writeLinkConnectParams(config, token, clientVersion) {
  return {
    minProtocol: PROTOCOL, maxProtocol: PROTOCOL,
    client: { id: config.client.id, version: clientVersion, platform: process.platform, mode: config.client.mode },
    role: config.role, scopes: [...config.scopes], caps: [...config.caps], auth: { token },
  };
}

/** Size limits from hello-ok (re-read on every connect). */
export function limitsFromHello(hello) {
  const p = hello?.policy ?? {};
  const a = p.attachments ?? {};
  return {
    maxPayload: posInt(p.maxPayload) ?? DEFAULT_LIMITS.maxPayload,
    maxBytes: posInt(a.maxBytes) ?? DEFAULT_LIMITS.maxBytes,
    maxImageBytes: Math.min(posInt(a.maxImageBytes) ?? DEFAULT_LIMITS.maxImageBytes, posInt(a.maxBytes) ?? DEFAULT_LIMITS.maxBytes),
  };
}

/** null when the attachments fit the limits; else the reason (all checked BEFORE anything is written). */
export function attachmentsTooLarge(attachments, limits) {
  if (!attachments?.length) return null;
  let total = 0;
  for (const a of attachments) {
    const n = decodedBytes(a.content);
    if (n > limits.maxImageBytes) return "image_too_large";
    total += n;
  }
  return total > limits.maxBytes ? "images_too_large" : null;
}

/**
 * @param {{ url: string, token: string, log?: any, WebSocketImpl?: any, now?: () => number, config?: typeof WRITE_LINK_CONFIG,
 *           ackTimeoutMs?: number, clientVersion?: string, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout, random?: () => number }} o
 */
export function createGatewayWriteLink({ url, token, log, WebSocketImpl = globalThis.WebSocket, now = Date.now, config = WRITE_LINK_CONFIG,
  ackTimeoutMs = ACK_TIMEOUT_MS, clientVersion = "basht-bridge-write/1", setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random,
  connectTimeoutMs = CONNECT_TIMEOUT_MS }) {
  const epoch = crypto.randomBytes(6).toString("hex");
  let ws = null;
  let state = "off";
  let since = now();
  let lastError = null;
  let stopped = true;
  let attempt = 0;
  let seq = 0;
  let retryTimer = null;
  let watchdog = null;
  let tickMs = DEFAULT_TICK_MS;
  let limits = { ...DEFAULT_LIMITS };
  const inflight = new Map(); // id -> { resolve, reject, t } : ONLY frames that were written
  const listeners = new Set();

  const setState = (s, err) => {
    if (state === s) return;
    state = s; since = now();
    if (err !== undefined) lastError = err;
    log?.info?.("gateway-write-link", `${s}${err ? ` (${err})` : ""}`);
  };

  /** Every write still waiting for its answer when the socket ends: UNKNOWN (ack_lost), never "not written". */
  function loseInflight() {
    for (const [id, w] of inflight) { clearTimer(w.t); inflight.delete(id); w.reject(fail("ack_lost")); }
  }

  function dropped(reason) {
    clearTimer(watchdog);
    ws = null;
    loseInflight();
    if (stopped) { setState("off"); return; }
    setState("down", reason ?? "closed");
    clearTimer(retryTimer);
    const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]; attempt += 1;
    retryTimer = setTimer(connect, Math.round(base * (0.8 + random() * 0.4)));
    retryTimer?.unref?.();
  }

  function armWatchdog() {
    clearTimer(watchdog);
    watchdog = setTimer(() => { const s = ws; ws = null; try { s?.close(4000, "stale"); } catch { /* ignore */ } dropped("stale"); }, Math.round(tickMs * 2.5));
    watchdog?.unref?.();
  }

  // The handshake uses its own tiny request path (it is not a write).
  function handshake(sock) {
    const id = `h${++seq}`;
    return new Promise((resolve, reject) => {
      const t = setTimer(() => { inflight.delete(id); reject(fail("connect_timeout")); }, CONNECT_TIMEOUT_MS);
      t?.unref?.();
      inflight.set(id, { resolve, reject: (e) => reject(e?.code === "ack_lost" ? fail("closed") : e), t });
      try { sock.send(JSON.stringify({ type: "req", id, method: "connect", params: writeLinkConnectParams(config, token, clientVersion) })); }
      catch { clearTimer(t); inflight.delete(id); reject(fail("connect_failed")); }
    });
  }

  function connect() {
    if (stopped || ws) return;
    if (typeof WebSocketImpl !== "function") { setState("down", "no_websocket"); return; }
    if (state !== "up") setState("connecting");
    let sock;
    try { sock = new WebSocketImpl(url); } catch { dropped("connect_failed"); return; }
    ws = sock;
    let helloDone = false;
    let why = null;
    // m11: the whole handshake is bounded from the moment the socket exists, also when connect.challenge never arrives
    const connectTimer = setTimer(() => {
      if (helloDone || ws !== sock) return;
      ws = null; try { sock.close(); } catch { /* ignore */ }
      dropped("connect_timeout");
    }, connectTimeoutMs);
    connectTimer?.unref?.();
    sock.onclose = () => { clearTimer(connectTimer); if (ws === sock) dropped(why ?? "closed"); };
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
        else w.reject(Object.assign(new Error(str(f.error?.message, 300) ?? "gateway error"), { code: str(f.error?.code, 60) ?? "error", refused: true,
          reason: str(f.error?.details?.reason, 60), retryAfterMs: Number.isSafeInteger(f.error?.retryAfterMs) && f.error.retryAfterMs >= 0 ? Math.min(f.error.retryAfterMs, 60_000) : null }));
        return;
      }
      if (f?.type !== "event") return;
      if (f.event === "connect.challenge" && !helloDone) {
        handshake(sock).then((hello) => {
          const granted = Array.isArray(hello?.auth?.scopes) ? hello.auth.scopes : [];
          if (!config.scopes.every((s) => granted.includes(s))) { why = "scopes_not_granted"; try { sock.close(4001, "scopes"); } catch { /* ignore */ } return; }
          helloDone = true;
          clearTimer(connectTimer);
          limits = limitsFromHello(hello);
          tickMs = posInt(hello?.policy?.tickIntervalMs) || DEFAULT_TICK_MS;
          attempt = 0; lastError = null;
          setState("up");
          armWatchdog();
        }).catch((err) => { why = str(err?.code, 60) ?? "connect_refused"; try { sock.close(); } catch { /* ignore */ } });
        return;
      }
      if (helloDone && typeof f.event === "string") for (const fn of listeners) { try { fn(f.event, f.payload); } catch { /* a listener never breaks the link */ } }
    };
  }

  /** Write one frame and wait for its answer. Every refusal before the write is definite; after it, only ack / ack_lost / ack_timeout. */
  function write(method, params) {
    return new Promise((resolve, reject) => {
      if (state !== "up" || !ws || ws.readyState !== OPEN) return reject(fail("not_written"));
      const id = `w${++seq}`;
      const frame = JSON.stringify({ type: "req", id, method, params });
      if (Buffer.byteLength(frame) > limits.maxPayload - FRAME_HEADROOM) return reject(fail("too_large", { reason: "frame_too_large" }));
      const sock = ws;
      try { sock.send(frame); } catch { return reject(fail("not_written")); }
      // written: from here the engine may have it
      const t = setTimer(() => { inflight.delete(id); reject(fail("ack_timeout")); }, ackTimeoutMs);
      t?.unref?.();
      inflight.set(id, { resolve, reject, t });
    });
  }

  return {
    epoch,
    config,
    start() { if (!stopped) return; stopped = false; attempt = 0; connect(); },
    stop() {
      stopped = true; clearTimer(retryTimer); clearTimer(watchdog);
      const s = ws; ws = null; loseInflight();
      try { s?.close(1000, "stop"); } catch { /* ignore */ }
      setState("off");
    },
    kick() { if (!stopped && !ws) { clearTimer(retryTimer); attempt = 0; connect(); } },
    isUp: () => state === "up",
    status: () => ({ state, since, lastError: state === "up" ? null : lastError }),
    limits: () => ({ ...limits }),
    /** Gateway events seen on this connection (every operator link receives every session's chat events, lab L3). */
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /**
     * One chat.send. `{sessionKey (unqualified), message, idempotencyKey (= clientMsgId), attachments?}`; the suppress flag comes from
     * the config, never from the caller. Resolves with the gateway's ack payload.
     */
    chatSend({ sessionKey, message, idempotencyKey, attachments }) {
      const params = { sessionKey, message, idempotencyKey,
        ...(config.suppressCommandInterpretation ? { suppressCommandInterpretation: true } : {}),
        ...(attachments?.length ? { attachments } : {}) };
      if (!validChatSendParams(params, config)) return Promise.reject(fail("bad_params"));
      const big = attachmentsTooLarge(params.attachments, limits);
      if (big) return Promise.reject(fail("too_large", { reason: big }));
      return write("chat.send", params);
    },
    chatAbort({ sessionKey, runId }) {
      const params = { sessionKey, runId };
      if (!validChatAbortParams(params)) return Promise.reject(fail("bad_params"));
      return write("chat.abort", params);
    },
    /** Any other method is refused locally (nothing is written). */
    request(method) { return Promise.reject(fail(WRITE_METHODS.has(method) ? "use_typed_method" : "not_allowed")); },
  };
}
