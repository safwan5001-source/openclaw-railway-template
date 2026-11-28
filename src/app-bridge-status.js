// BASHT app bridge: the additive, cheap, read-only pieces of GET /app/v1/status that are not voice (batch 3).
// Nothing here calls the gateway or writes; it reads the one environment value named below and (B4, flag on) the gateway config file.
import fs from "node:fs";
import { MAX_IMAGE_BYTES, MAX_IMAGES, MAX_IMAGES_TOTAL_BYTES, MAX_INLINE_BYTES, MAX_MEDIA_BYTES } from "./app-bridge-media.js";

/**
 * Capability ids this engine has beyond the voice contract. They are appended after `FEATURES` (src/app-bridge-voice.js, shared with
 * the app through src/fixtures/voice-contract.json) in `features` of GET /status; they are NOT part of that fixture.
 */
export const EXTRA_FEATURES = Object.freeze([
  "history.images.v1", // image messages stay in /history
  "media.inline.v1", // inline image blocks are served through /media
  "media.guard.v1", // protected-path guard on downloads
  "runs.runId.v1", // additive runId on user rows of /history
  "errorCode.rate_limited.v1", // additive errorCode "rate_limited" on a failed run
]);

const GUARD_ID = "basht-resume-guard";
/**
 * B4 (flag on only): is the D-B4-9 resume guard CONFIGURED in the gateway config (a load path ending in the guard file, its entry
 * enabled, conversation access granted)? A boolean read of the config file, nothing else (no path or setting is returned); null when
 * the config cannot be read. "Configured" is not "loaded": `openclaw plugins list` stays the release-gate check.
 */
export function resumeGuardConfigured(configPath) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { return null; }
  const paths = cfg?.plugins?.load?.paths;
  const entry = cfg?.plugins?.entries?.[GUARD_ID];
  return Array.isArray(paths) && paths.some((p) => typeof p === "string" && p.endsWith(`/${GUARD_ID}.mjs`))
    && entry?.enabled === true && entry?.hooks?.allowConversationAccess === true && cfg?.plugins?.enabled !== false;
}

const COMMIT_RE = /^[0-9a-f]{7,40}$/;

/**
 * The deployed build's git commit: the first 12 characters of RAILWAY_GIT_COMMIT_SHA (set by Railway at build time), or null when it is
 * missing or is not 7 to 40 lowercase hex characters (anything else, spaces and uppercase included, is refused, never repaired).
 * No other environment value is read, and nothing but those hex characters is ever returned.
 */
export function wrapperCommit(env = process.env) {
  const v = env?.RAILWAY_GIT_COMMIT_SHA;
  return typeof v === "string" && COMMIT_RE.test(v) ? v.slice(0, 12) : null;
}

/** The attachment limits the bridge really enforces, read from the constants of src/app-bridge-media.js (never copied). */
export function attachmentLimits() {
  return {
    maxImages: MAX_IMAGES, maxImageBytes: MAX_IMAGE_BYTES, maxTotalImageBytes: MAX_IMAGES_TOTAL_BYTES,
    maxFileBytes: MAX_MEDIA_BYTES, maxInlineBytes: MAX_INLINE_BYTES,
  };
}
