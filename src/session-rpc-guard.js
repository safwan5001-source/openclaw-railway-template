// BASHT wrapper-level session-key check (plan v2.1 §3.2: "today there is no key check at the wrapper level", server.js
// appBridgeGatewayCall). Every gateway RPC the app bridge makes through the wrapper (CLI or persistent link) passes this check
// first. It REJECTS keys of any other shape (never normalises them) and closes the params of the two session writes.
//
// - Writes and per-session reads (sessions.describe, sessions.patch, sessions.reset, models.list, sessions.usage, tools.effective):
//   the qualified app key only (agent:main:app:owner or agent:main:app:owner:<32 lowercase hex>); sessions.reset only the legacy
//   app key with reason "new" (the only reset the bridge makes).
// - Reads of the owner's readable conversations (chat.history, sessions.search, artifacts.download): the qualified app keys, the
//   main session and the owner-direct WhatsApp key SHAPE. Whether a WhatsApp key belongs to an owner is decided by the bridge's
//   isReadable (it knows the owners); this layer only refuses shapes the bridge can never produce.
// - sessions.patch: exactly one change per call, from a closed set: {thinkingLevel}, {fastMode}, {model}, or a restore
//   {archived:false, expectedSessionId}. Nothing else (no label, no archive, no pin, no delete) can ride along.
import { QUALIFIED_THREAD_KEY_RE } from "./thread-keys.js";

const MAIN_KEY = "agent:main:main";
const LEGACY_APP_KEY = "agent:main:app:owner";
// the same exact shape as src/app-bridge.js WHATSAPP_DIRECT_KEY (owner check happens in the bridge)
const WHATSAPP_DIRECT_KEY = /^agent:main:whatsapp:(?:(?!(?:direct|group|channel|thread):)[^:]+:)?direct:([^:]+)$/i;
const MODEL_REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const ownKeys = (p) => Object.keys(p).sort().join(",");
// own data properties only: an accessor could answer one value to this check and another to the serializer
const dataOnly = (p) => Object.values(Object.getOwnPropertyDescriptors(p)).every((d) => "value" in d);

export const isAppKey = (k) => typeof k === "string" && QUALIFIED_THREAD_KEY_RE.test(k);
export const isReadShapeKey = (k) => isAppKey(k) || k === MAIN_KEY || (typeof k === "string" && WHATSAPP_DIRECT_KEY.test(k));

const APP_KEY_METHODS = { "sessions.describe": "key", "sessions.patch": "key", "sessions.reset": "key", "models.list": "sessionKey",
  "sessions.usage": "key", "tools.effective": "sessionKey" };
const READ_KEY_METHODS = { "chat.history": "sessionKey", "artifacts.download": "sessionKey" };

function patchOk(p) {
  const rest = Object.keys(p).filter((k) => k !== "key").sort().join(",");
  if (rest === "thinkingLevel") return p.thinkingLevel === null || (typeof p.thinkingLevel === "string" && /^[a-z0-9_-]{1,40}$/i.test(p.thinkingLevel));
  if (rest === "fastMode") return p.fastMode === null || typeof p.fastMode === "boolean";
  if (rest === "model") return p.model === null || (typeof p.model === "string" && MODEL_REF.test(p.model));
  if (rest === "archived,expectedSessionId") return p.archived === false && typeof p.expectedSessionId === "string" && SESSION_ID.test(p.expectedSessionId);
  return false;
}

/** true when `params` of `method` name only session keys this bridge can legitimately send (and, for writes, only closed changes). */
export function validateSessionRpc(method, params) {
  const keyField = APP_KEY_METHODS[method] ?? READ_KEY_METHODS[method];
  const multi = method === "sessions.search";
  if (!keyField && !multi) return true; // a method without a session key (cron.*, memory.*, usage.cost, …)
  if (!isPlain(params) || !dataOnly(params)) return false;
  if (multi) {
    const ks = params.sessionKeys;
    return Array.isArray(ks) && ks.length >= 1 && ks.length <= 200 && ks.every(isReadShapeKey);
  }
  const key = params[keyField];
  if (method === "models.list" || method === "tools.effective") {
    if (key !== undefined && !isAppKey(key)) return false;
    return true;
  }
  if (READ_KEY_METHODS[method] ? !isReadShapeKey(key) : !isAppKey(key)) return false;
  if (method === "sessions.reset") return key === LEGACY_APP_KEY && ownKeys(params) === "key,reason" && params.reason === "new";
  if (method === "sessions.patch") return patchOk(params);
  if (method === "sessions.describe") return ownKeys(params) === "key";
  return true;
}
