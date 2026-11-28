// BASHT independent conversations (batch 4, P2-B4-1): the ONE place where thread ids, thread session keys, client message ids,
// the engine feature flag and the bridge's command filter are defined. Everything here REJECTS; nothing is ever normalised
// (no lowercasing, no trimming, no decoding): the engine lowercases unqualified keys and merges two conversations, and an
// uppercase qualified key hangs the request (lab E1). A value that does not match exactly is refused.
//
// Key form per method (plan v2.1 §3.2/§16): the bridge builds BOTH forms from a validated tid and never forwards a key it was given.
//   chat.send / chat.abort (write link)                         unqualified  app:owner | app:owner:<32 hex>
//   chat.history, sessions.describe/patch/list, models.list     qualified    agent:main:app:owner | agent:main:app:owner:<32 hex>
//   agent.wait                                                  runId only (= clientMsgId, a lowercase UUID)

export const LEGACY_TID = "legacy";
export const TID_RE = /^[0-9a-f]{32}$/;
/** A lowercase RFC-4122-shaped UUID (any version nibble): the app's clientMsgId, which is also the engine runId of a chat.send. */
export const CLIENT_MSG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const UNQUALIFIED_THREAD_KEY_RE = /^app:owner(?::[0-9a-f]{32})?$/;
export const QUALIFIED_THREAD_KEY_RE = /^agent:main:app:owner(?::[0-9a-f]{32})?$/;
const QUALIFIED_PREFIX = "agent:main:";
const LEGACY_UNQUALIFIED = "app:owner";
const LEGACY_QUALIFIED = "agent:main:app:owner";

/** "legacy" or a 32-lowercase-hex tid, exactly; anything else null. */
export function parseTid(v) {
  return typeof v === "string" && (v === LEGACY_TID || TID_RE.test(v)) ? v : null;
}

/** Both key forms of a valid tid, or null. The ONLY builder of thread keys. */
export function threadKeys(tid) {
  const t = parseTid(tid);
  if (t === null) return null;
  const unqualified = t === LEGACY_TID ? LEGACY_UNQUALIFIED : `${LEGACY_UNQUALIFIED}:${t}`;
  return { tid: t, unqualified, qualified: `${QUALIFIED_PREFIX}${unqualified}` };
}

/** The tid ("legacy" or hex) of a qualified app key the ENGINE reported (approvals, events, sessions.list rows), else null. */
export function threadOfKey(key) {
  if (typeof key !== "string" || !QUALIFIED_THREAD_KEY_RE.test(key)) return null;
  return key === LEGACY_QUALIFIED ? LEGACY_TID : key.slice(LEGACY_QUALIFIED.length + 1);
}

export const isClientMsgId = (v) => typeof v === "string" && CLIENT_MSG_ID_RE.test(v);

/**
 * The engine feature flag for independent conversations. ON only for the exact value "on" (the name and value the plan uses for the
 * API flag, §8); anything else, including unset, is OFF. With it off the engine behaves exactly as before batch 4: no write link,
 * no /threads routes (404 like an old engine), no capability ids, no extra fields.
 */
export const THREADS_FLAG = "BASHT_THREADS";
export function threadsEnabled(env = process.env) {
  return env?.[THREADS_FLAG] === "on";
}

/** Capability ids advertised in GET /status `features` ONLY while the flag is on (plan §3.4; mirrored in the API's ENGINE_FEATURES). */
export const THREAD_FEATURES = Object.freeze(["sessions.multi.v1", "send.ws.v1", "events.thread.v1"]);

/**
 * Definite refusals of the thread send paths (plan §3.3 N7, lab §4.8): nothing reached the engine, or the engine refused before
 * doing anything. The API may treat ONLY these as "not sent"; every other answer (502 outcome_unknown, any other status or body,
 * no answer at all) is UNKNOWN and must never be retried automatically.
 */
export const DEFINITE_REFUSALS = Object.freeze(["busy", "busy_unknown", "archived", "conflict", "cold", "not_written",
  "bad_request", "command_not_allowed", "too_large"]);

// Leading characters the gateway trims before it looks for a command (JS whitespace, which includes NBSP U+00A0 and BOM U+FEFF),
// plus every Unicode format character (\p{Cf}: RLM, LRM, ALM, ZWJ, ZWNJ, ZWSP, WJ, BOM…) as a conservative superset: the Arabic
// keyboard inserts RLM, and a mark the gateway does not trim today might be trimmed by a later version.
const LEADING_IGNORABLE = /^[\s ﻿\p{Cf}]+/u;

/**
 * Defence in depth for the write link (plan N5, corrected by lab L1(g)): refuse a message that would be read as a command if the
 * engine interpreted commands. Leading whitespace and format/bidi marks are stripped first; then a leading "/" is a slash command and
 * a leading "!" followed by ANYTHING (a space, the end, "مهم", "important") is a bash command, exactly as the gateway treats them.
 * Returns "command_not_allowed" or null. The write link also always sends suppressCommandInterpretation (D-B4-10 default), so the
 * engine would treat these as text anyway; this filter keeps that true even if the flag is ever dropped.
 */
export function commandRefusal(text) {
  if (typeof text !== "string") return null;
  const s = text.replace(LEADING_IGNORABLE, "");
  return s.startsWith("/") || s.startsWith("!") ? "command_not_allowed" : null;
}
