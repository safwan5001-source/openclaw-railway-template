// BASHT app bridge: the VOICE IDENTITY GUARD for POST /app/v1/speak (see docs/BASHT_APP_BRIDGE.md, "Voice").
//
// Why it exists: the gateway RPC `tts.speak` knows nothing about the agent block `agents.entries.main.tts`. It speaks with the GLOBAL
// `tts` block, and when that block is missing or different it does not fail: it silently uses another default voice with no
// instructions. That would be BASHT speaking in a voice nobody approved. So before every RPC speak the bridge checks that the global
// block has the SAME identity as the agent block (provider + that provider's settings: model, voice, instructions, …), and refuses
// when it does not.
//
// The config is read fresh on every call (the file is small; an operator edit applies without a restart). Nothing secret or textual
// leaves this module: the result carries a state, a short hash prefix of the canonicalised identity, and warning CODES. Never the
// instructions, never a key, never a path.
import crypto from "node:crypto";
import fs from "node:fs";

/** Every state `evaluateVoiceGuard` can answer with. */
export const VOICE_STATES = Object.freeze(["match", "no_global", "mismatch", "global_only", "no_agent_block", "unknown"]);

// Keys that look like credentials, removed (at any depth) BEFORE comparing, hashing or logging: apiKey, api_key, token, secret,
// password, key, authorization, headers, credentials, and anything ending in Key / Token / Secret / Password (accessKey, authToken…).
const SECRET_KEY_EXACT = /^(key|api[_-]?key|token|secret|password|authorization|headers?|credentials?)$/i;
const SECRET_KEY_SUFFIX = /(key|token|secret|password)$/i;
export const isSecretKey = (k) => SECRET_KEY_EXACT.test(k) || SECRET_KEY_SUFFIX.test(k);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A deep copy of `v` without secret-looking keys (arrays keep their order; non-plain values pass through as JSON would see them). */
export function stripSecrets(v) {
  if (Array.isArray(v)) return v.map(stripSecrets);
  if (!isObj(v)) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (!isSecretKey(k)) out[k] = stripSecrets(x);
  return out;
}

/** JSON with object keys sorted at every depth: two configs that differ only in key order canonicalise to the same text. */
export function canonicalize(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(",")}}`;
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * The identity of a `tts` block: its provider and that provider's own settings (secrets removed), or null when the block names no
 * provider. Other fields of the block (auto, prefsPath, persona, …) are not part of the identity: they are not the voice.
 */
export function voiceIdentity(block) {
  if (!isObj(block)) return null;
  const provider = typeof block.provider === "string" ? block.provider.trim() : "";
  if (!provider) return null;
  const providers = isObj(block.providers) ? block.providers : {};
  const own = Object.hasOwn(providers, provider) && isObj(providers[provider]) ? providers[provider] : {};
  return { provider, providerConfig: stripSecrets(own) };
}

/** A short, stable fingerprint of an identity (first 12 hex chars of sha256 over the canonical text): enough to tell two apart in a log. */
export const identityHash = (id) => crypto.createHash("sha256").update(canonicalize(id)).digest("hex").slice(0, 12);

/**
 * Warnings about the GLOBAL block (never a refusal): `auto` other than off would make the engine speak replies on its own, and
 * `prefsPath` points the engine at a mutable preferences file that could change the voice behind the bridge's back.
 */
function globalWarnings(globalBlock) {
  const warnings = [];
  if (!isObj(globalBlock)) return warnings;
  const auto = globalBlock.auto;
  if (auto !== undefined && auto !== null && auto !== false && !(typeof auto === "string" && auto.trim().toLowerCase() === "off")) warnings.push("global_auto_enabled");
  if (globalBlock.prefsPath !== undefined) warnings.push("global_prefs_path");
  return warnings;
}

/**
 * @param {any} cfg the parsed openclaw.json
 * @returns {{ state: "match"|"no_global"|"mismatch"|"global_only"|"no_agent_block"|"unknown", hash?: string, globalHash?: string, warnings: string[] }}
 *   hash: identity of the agent block (of the global block for global_only); globalHash only on a mismatch.
 */
export function evaluateVoiceGuard(cfg) {
  if (!isObj(cfg)) return { state: "unknown", warnings: [] };
  const agentBlock = cfg.agents?.entries?.main?.tts;
  const globalBlock = cfg.tts;
  const warnings = globalWarnings(globalBlock);
  const agent = voiceIdentity(agentBlock);
  const global = voiceIdentity(globalBlock);
  if (!agent && !global) return { state: "no_agent_block", warnings };
  if (!agent) return { state: "global_only", hash: identityHash(global), warnings };
  if (!global) return { state: "no_global", hash: identityHash(agent), warnings };
  return canonicalize(agent) === canonicalize(global)
    ? { state: "match", hash: identityHash(agent), warnings }
    : { state: "mismatch", hash: identityHash(agent), globalHash: identityHash(global), warnings };
}

/** The guard for the config file at `configPath`, read fresh. An unreadable or malformed file is state "unknown". Never throws. */
export function readVoiceGuard(configPath) {
  try {
    return evaluateVoiceGuard(JSON.parse(fs.readFileSync(configPath, "utf8")));
  } catch {
    return { state: "unknown", warnings: [] };
  }
}

/**
 * `voice.speak` of GET /app/v1/status, from the guard and the link: "ready" | "degraded" | "unconfigured" | "mismatch" | "unknown",
 * with a short `reason` code when it is not ready. `toolPath`: the tool path of /speak is available (the wrapper gave a state dir).
 * @returns {{ speak: "ready"|"degraded"|"unconfigured"|"mismatch"|"unknown", reason?: string }}
 */
export function speakStatus(guard, { linkUp = false, toolPath = true } = {}) {
  switch (guard?.state) {
    case "match":
    case "global_only":
      return linkUp ? { speak: "ready" } : { speak: "degraded", reason: "link_down" };
    case "no_global": // the agent's voice is not (yet) mirrored in the global block: only the tool path can speak it
      return toolPath ? { speak: "degraded", reason: "tool_path_only" } : { speak: "unconfigured", reason: "tool_path_unavailable" };
    case "mismatch":
      return { speak: "mismatch", reason: "identity_mismatch" };
    case "no_agent_block":
      return { speak: "unconfigured", reason: "no_tts_config" };
    default:
      return { speak: "unknown", reason: "config_unreadable" };
  }
}
