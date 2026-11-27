// BASHT app bridge: the VOICE IDENTITY GUARD for POST /app/v1/speak (see docs/BASHT_APP_BRIDGE.md, "Voice").
//
// Why it exists: the gateway RPC `tts.speak` knows nothing about the agent block `agents.entries.main.tts`. It is agent-less: it
// speaks with the GLOBAL `tts` block alone, and when that block is missing or different it does not fail: it silently uses another
// default voice with no instructions. That would be BASHT speaking in a voice nobody approved.
//
// What the gateway really does (OpenClaw 2026.11.10, src/tts/tts-config + tts-settings; mirrored here, not guessed):
//   - the agent's effective block is mergeDeep(global `tts`, agent `tts`): the agent's keys win, objects merge key by key;
//   - provider ids are trimmed and lower-cased, "edge" is "microsoft"; blocked keys (__proto__, …) are dropped;
//   - a provider's settings are `providers[<id>]` (keys normalised the same way), or the legacy top-level `<id>: {…}` entry;
//   - the speaker voice has aliases (speakerVoice / voice / voiceName, speakerVoiceId / voiceId) that are unified;
//   - a TTS preferences file (config `prefsPath`, else env OPENCLAW_TTS_PREFS, else <state dir>/settings/tts.json) can override the
//     provider, the persona and the auto mode for everyone; a persona can carry its own provider settings.
// So the guard computes BOTH effective identities the way the gateway does — the agent's (merged) and the one `tts.speak` would use
// (global only) — and answers "match" only when they are equal and nothing else (a persona, the preferences file) can change them.
// Anything it cannot be sure of fails closed as "mismatch".
//
// The config is read fresh on every call (small file; an operator edit applies without a restart). Nothing secret or textual leaves
// this module: a state, the effective provider id, a short sha256 prefix of the canonicalised identity, and warning CODES. Never the
// instructions, never a key, never a path.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Every state `evaluateVoiceGuard` can answer with. */
export const VOICE_STATES = Object.freeze(["match", "no_global", "mismatch", "global_only", "no_agent_block", "unknown"]);

/**
 * Every `reason` token /speak and /status emit. The set is a shared contract with the app (src/fixtures/voice-contract.json: the
 * tests compare both ways). Free text never goes into a reason.
 */
export const REASONS = Object.freeze({
  IDENTITY_MISMATCH: "identity_mismatch", TOOL_DENIED: "tool_denied", UNCONFIGURED: "unconfigured", PROVIDER_ERROR: "provider_error",
  LINK_DOWN: "link_down", TIMEOUT: "timeout", BAD_AUDIO: "bad_audio", ENGINE_ERROR: "engine_error", IN_FLIGHT: "in_flight",
  PER_MINUTE: "per_minute", TEXT_REJECTED: "text_rejected", TOOL_PATH_ONLY: "tool_path_only", TOOL_PATH_UNAVAILABLE: "tool_path_unavailable",
  NO_TTS_CONFIG: "no_tts_config", CONFIG_UNREADABLE: "config_unreadable",
});
/** `voice.speak` values of GET /status (shared contract). */
export const SPEAK_STATES = Object.freeze(["ready", "degraded", "unconfigured", "mismatch", "unknown"]);
/** `features` of GET /status (shared contract): each one names a capability this bridge really has. */
export const FEATURES = Object.freeze(["voice.speak.v2", "voice.transcribe.v1", "voice.status.v1", "signing.v1"]);

// Keys that look like credentials, removed (at any depth) BEFORE comparing, hashing or logging: apiKey, api_key, token, secret,
// password, key, authorization, headers, credentials, and anything ending in Key / Token / Secret / Password (accessKey, authToken…).
const SECRET_KEY_EXACT = /^(key|api[_-]?key|token|secret|password|authorization|headers?|credentials?)$/i;
const SECRET_KEY_SUFFIX = /(key|token|secret|password)$/i;
export const isSecretKey = (k) => SECRET_KEY_EXACT.test(k) || SECRET_KEY_SUFFIX.test(k);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

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

/** The gateway's deep merge: objects merge key by key (blocked keys dropped), anything else (arrays, null, scalars) is replaced. */
function sanitize(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (!BLOCKED_KEYS.has(k)) out[k] = isObj(v) ? sanitize(v) : v;
  return out;
}
export function mergeDeep(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = sanitize(base);
  for (const [k, v] of Object.entries(over)) {
    if (BLOCKED_KEYS.has(k) || v === undefined) continue;
    out[k] = isObj(v) ? (isObj(out[k]) ? mergeDeep(out[k], v) : sanitize(v)) : v;
  }
  return out;
}

// ---- provider ids ----
/** Ids that are an ALIAS of another provider at runtime (resolved by the provider registry, not by the config): we cannot tell which settings they pick up. */
const RUNTIME_ALIASES = new Set(["azure", "cli"]);
const PLAIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * A provider id the way the gateway normalises it (trim, lower-case, "edge" = "microsoft", blocked keys refused), or undefined.
 * Used for the config AND for the `provider` the gateway answers with, so the two are compared in the same form.
 */
export function normalizeSpeechProviderId(v) {
  const id = str(v)?.toLowerCase();
  if (!id || BLOCKED_KEYS.has(id)) return undefined;
  return id === "edge" ? "microsoft" : id;
}
/** A normalised id the guard can trust: a plain token that is not a registry alias. Anything else fails closed. */
const isCanonicalId = (id) => typeof id === "string" && PLAIN_ID.test(id) && !RUNTIME_ALIASES.has(id);

// ---- one tts block, resolved like resolveTtsConfig ----
const RESERVED = new Set(["auto", "enabled", "maxTextLength", "mode", "modelOverrides", "persona", "personas", "prefsPath", "provider", "providers", "summaryModel", "timeoutMs"]);

/** The speaker-voice aliases of a provider's settings, unified exactly like the gateway (voice == speakerVoice == voiceName …). */
function withSpeakerSelectionCompat(cfg) {
  const t = isObj(cfg) ? { ...cfg } : {};
  const speakerVoice = str(t.speakerVoice), speakerVoiceId = str(t.speakerVoiceId), voice = str(t.voice), voiceName = str(t.voiceName), voiceId = str(t.voiceId);
  const s = speakerVoice ?? (speakerVoiceId ? undefined : voice ?? voiceName);
  const c = speakerVoiceId ?? (speakerVoice ? undefined : voiceId);
  if (s) { t.speakerVoice = s; t.voice = s; t.voiceName = s; }
  if (c) { t.speakerVoiceId = c; t.voiceId = c; }
  return t;
}

/** `providers[…]` first, then the legacy top-level `<id>: {…}` entries of the block; every entry through the voice-alias compat. */
function providerConfigs(block) {
  const out = {};
  if (isObj(block.providers)) for (const [k, v] of Object.entries(block.providers)) out[normalizeSpeechProviderId(k) ?? k] = withSpeakerSelectionCompat(v);
  for (const [k, v] of Object.entries(block)) {
    if (RESERVED.has(k) || !isObj(v)) continue;
    const id = normalizeSpeechProviderId(k) ?? k;
    out[id] ??= withSpeakerSelectionCompat(v);
  }
  return out;
}

/** Persona keys that do NOT reach the provider request (lab-verified: label and description only describe the persona). */
const HARMLESS_PERSONA_KEYS = new Set(["label", "description", "id"]);
const personaAffects = (p) => !isObj(p) || Object.keys(p).some((k) => !HARMLESS_PERSONA_KEYS.has(k));
const personaId = (v) => str(v)?.toLowerCase();

/** What an effective block selects, as an identity: provider + that provider's settings (secrets removed). */
function identityOf(block) {
  const provider = normalizeSpeechProviderId(block.provider);
  if (!provider) return null;
  const own = providerConfigs(block)[provider];
  return { provider, providerConfig: stripSecrets(isObj(own) ? own : {}) };
}

/** Does the personas map of an effective block hold a persona that can change what the provider is asked to do? */
function anyPersonaAffects(block) {
  return isObj(block.personas) && Object.values(block.personas).some(personaAffects);
}

/** A short, stable fingerprint of an identity (first 12 hex chars of sha256 over the canonical text): enough to tell two apart in a log. */
export const identityHash = (id) => crypto.createHash("sha256").update(canonicalize(id)).digest("hex").slice(0, 12);

/**
 * The identity of one `tts` block as a single block would resolve it (provider + provider settings, no merging with anything).
 * Kept for callers and tests that look at one block: null when the block names no provider.
 */
export function voiceIdentity(block) {
  return isObj(block) ? identityOf(block) : null;
}

function prefsTts(prefs) {
  return isObj(prefs) && isObj(prefs.tts) ? prefs.tts : {};
}

/** Warnings about the global block and the preferences files (never a refusal by themselves). Codes only. */
function warningsFor(globalBlock, merged, prefsList) {
  const w = [];
  const auto = isObj(globalBlock) ? globalBlock.auto : undefined;
  if (auto !== undefined && auto !== null && auto !== false && !(typeof auto === "string" && auto.trim().toLowerCase() === "off")) w.push("global_auto_enabled");
  if ((isObj(globalBlock) && globalBlock.prefsPath !== undefined) || (isObj(merged) && merged.prefsPath !== undefined)) w.push("global_prefs_path");
  for (const p of prefsList) {
    const t = prefsTts(p);
    const onAuto = (t.auto !== undefined && t.auto !== null && String(t.auto).trim().toLowerCase() !== "off") || t.enabled === true;
    if (str(t.provider) || Object.hasOwn(t, "persona") || onAuto) { w.push("prefs_file_overrides"); break; }
  }
  return w;
}

/**
 * Does a preferences file change what this side speaks? The file overrides the provider and the persona for everyone, so any provider
 * other than the configured one, or any persona that is not harmless, is a different voice than the approved one.
 */
function prefsOverride(prefs, configuredProvider, block) {
  const t = prefsTts(prefs);
  const pp = str(t.provider) ? normalizeSpeechProviderId(t.provider) : undefined;
  if (str(t.provider) && pp !== configuredProvider) return true;
  const pid = personaId(t.persona);
  if (pid) {
    const entry = isObj(block.personas) ? Object.entries(block.personas).find(([k]) => personaId(k) === pid)?.[1] : undefined;
    if (entry === undefined || personaAffects(entry)) return true; // an unknown persona is not "no persona": fail closed
  }
  return false;
}

/**
 * @param {any} cfg the parsed openclaw.json
 * @param {{ agentPrefs?: any, globalPrefs?: any }} [prefs] parsed preferences files, as the agent side and the RPC side would read them
 * @returns {{ state: "match"|"no_global"|"mismatch"|"global_only"|"no_agent_block"|"unknown", provider?: string, hash?: string, globalHash?: string, warnings: string[] }}
 *   provider: the effective (normalised) provider id the approved voice uses, for comparing with what the gateway answers with.
 *   hash: identity of the agent's effective block; globalHash only on a mismatch.
 */
export function evaluateVoiceGuard(cfg, { agentPrefs, globalPrefs } = {}) {
  if (!isObj(cfg)) return { state: "unknown", warnings: [] };
  const agentBlock = cfg.agents?.entries?.main?.tts;
  const globalBlock = isObj(cfg.tts) ? cfg.tts : {};
  const hasAgentBlock = isObj(agentBlock) && Object.keys(agentBlock).length > 0;
  const merged = hasAgentBlock ? mergeDeep(globalBlock, agentBlock) : globalBlock;
  const warnings = warningsFor(globalBlock, merged, [agentPrefs, globalPrefs].filter(Boolean));
  const agent = identityOf(merged);
  const global = identityOf(globalBlock);
  if (!hasAgentBlock) return global ? { state: "global_only", provider: global.provider, hash: identityHash(global), warnings } : { state: "no_agent_block", warnings };
  if (!agent) return { state: "no_agent_block", warnings };
  if (!global) return { state: "no_global", provider: agent.provider, hash: identityHash(agent), warnings };
  // From here both sides name a provider. Everything that could make the two speak differently is a mismatch.
  const globalHasPersona = !!personaId(globalBlock.persona) || (isObj(globalBlock.personas) && Object.keys(globalBlock.personas).length > 0);
  const canonical = isCanonicalId(agent.provider) && isCanonicalId(global.provider);
  const different = !canonical || canonicalize(agent) !== canonicalize(global) || globalHasPersona || anyPersonaAffects(merged)
    || prefsOverride(agentPrefs, agent.provider, merged) || prefsOverride(globalPrefs, global.provider, globalBlock);
  return different
    ? { state: "mismatch", provider: agent.provider, hash: identityHash(agent), globalHash: identityHash(global), warnings }
    : { state: "match", provider: agent.provider, hash: identityHash(agent), warnings };
}

// ---- the preferences file ----
const resolveUserPath = (p) => (p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : path.resolve(p));

/**
 * The preferences file one side reads: its own config `prefsPath`, else env OPENCLAW_TTS_PREFS, else <state dir>/settings/tts.json.
 * (The gateway can also keep a machine-wide path in its state database; that one is not visible from here.)
 */
export function prefsPathFor(block, { env = process.env, stateDir } = {}) {
  const own = isObj(block) ? str(block.prefsPath) : undefined;
  if (own) return resolveUserPath(own);
  const fromEnv = str(env?.OPENCLAW_TTS_PREFS);
  if (fromEnv) return resolveUserPath(fromEnv);
  return stateDir ? path.join(stateDir, "settings", "tts.json") : null;
}

/** A preferences file, read-only. Missing, unreadable or malformed = no preferences (the gateway then uses its configured defaults too). */
function readPrefs(file) {
  if (!file) return {};
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObj(j) ? j : {};
  } catch { return {}; }
}

/**
 * The guard for the config file at `configPath`, read fresh, with the preferences files the gateway would read next to it.
 * An unreadable or malformed config is state "unknown". Never throws. Never returns the content of any file.
 * @param {string} configPath
 * @param {{ env?: Record<string, string | undefined>, stateDir?: string }} [o] stateDir: the engine's state dir (the gateway's config dir)
 */
export function readVoiceGuard(configPath, { env = process.env, stateDir } = {}) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!isObj(cfg)) return { state: "unknown", warnings: [] };
    const globalBlock = isObj(cfg.tts) ? cfg.tts : {};
    const agentBlock = cfg.agents?.entries?.main?.tts;
    const merged = isObj(agentBlock) && Object.keys(agentBlock).length ? mergeDeep(globalBlock, agentBlock) : globalBlock;
    const dir = stateDir ?? str(env?.OPENCLAW_STATE_DIR) ?? path.dirname(configPath);
    return evaluateVoiceGuard(cfg, {
      agentPrefs: readPrefs(prefsPathFor(merged, { env, stateDir: dir })),
      globalPrefs: readPrefs(prefsPathFor(globalBlock, { env, stateDir: dir })),
    });
  } catch {
    return { state: "unknown", warnings: [] };
  }
}

/**
 * `voice.speak` of GET /app/v1/status, from the guard and the link: a member of SPEAK_STATES, with a short `reason` code
 * (a member of REASONS) when it is not ready. `toolPath`: the tool path of /speak is available (the wrapper gave a state dir).
 * @returns {{ speak: "ready"|"degraded"|"unconfigured"|"mismatch"|"unknown", reason?: string }}
 */
export function speakStatus(guard, { linkUp = false, toolPath = true } = {}) {
  switch (guard?.state) {
    case "match":
      return linkUp ? { speak: "ready" } : { speak: "degraded", reason: REASONS.LINK_DOWN };
    case "no_global": // the agent's voice is not (yet) mirrored in the global block: only the tool path can speak it
    case "global_only": // no agent block to compare with: the link path is never used
      return toolPath ? { speak: "degraded", reason: REASONS.TOOL_PATH_ONLY } : { speak: "unconfigured", reason: REASONS.TOOL_PATH_UNAVAILABLE };
    case "mismatch":
      return { speak: "mismatch", reason: REASONS.IDENTITY_MISMATCH };
    case "no_agent_block":
      return { speak: "unconfigured", reason: REASONS.NO_TTS_CONFIG };
    default:
      return { speak: "unknown", reason: REASONS.CONFIG_UNREADABLE };
  }
}
