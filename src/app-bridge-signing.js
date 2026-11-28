// BASHT app bridge: request signing "basht-bridge-v1" (verifier side). See docs/BASHT_APP_BRIDGE.md, "Signing".
//
// Why: the bearer BASHT_APP_TOKEN is one static secret that travels with every request. A signature adds, per request: proof that the
// caller holds a second secret (the token alone is no longer enough), a timestamp and a one-time nonce (a captured request cannot be
// replayed), and a hash of the exact body (a captured signature cannot be reused for another body, method or URL).
//
// Headers (all four, or none):
//   X-Basht-Timestamp       unix seconds
//   X-Basht-Nonce           [A-Za-z0-9_-]{16,64}, never reused
//   X-Basht-Content-SHA256  lowercase hex sha256 of the exact request body bytes (sha256 of "" when there is no body)
//   X-Basht-Signature       "v1=" + lowercase hex HMAC-SHA256(secret, canonical)
// canonical = join("\n", ["basht-bridge-v1", METHOD (uppercase), request-target, timestamp, nonce, content-sha256])
// request-target = the URL exactly as received (path and query, e.g. /app/v1/history?key=x), i.e. express `req.originalUrl`.
//
// This module is pure: no express, no I/O, an injectable clock. The router (src/app-bridge.js) runs the header phase in its auth
// middleware and the body phase once the body parser has produced the raw bytes. The verifier only ANSWERS (ok / reason); what a
// failure means is the router's call: "required" refuses it (401 bad_signature, counted in the failed-auth limiter), "optional"
// processes the request as UNSIGNED (never as verified), logs the reason and remembers it for /status, so a mistyped secret can
// never lock the owner out.
import crypto from "node:crypto";

export const SIGNING_SPEC = "basht-bridge-v1";
export const MIN_SECRET_LENGTH = 32;
export const MAX_SKEW_SECONDS = 60;
export const NONCE_TTL_MS = 180_000; // > 2 x the skew window: a nonce outlives every timestamp that could still be accepted
export const NONCE_MAX_ENTRIES = 10_000;
export const SIGNING_MODES = Object.freeze(["off", "optional", "required"]);
export const SIGNING_HEADERS = Object.freeze({
  timestamp: "x-basht-timestamp", nonce: "x-basht-nonce", contentSha256: "x-basht-content-sha256", signature: "x-basht-signature",
});

const TS_RE = /^\d{1,12}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const SIG_RE = /^v1=[0-9a-f]{64}$/;

export const sha256Hex = (buf) => crypto.createHash("sha256").update(buf ?? Buffer.alloc(0)).digest("hex");

/** The exact text that is signed. `target` is the request target as received; `contentSha256` the hex hash of the body bytes. */
export function canonicalString({ method, target, timestamp, nonce, contentSha256 }) {
  return [SIGNING_SPEC, String(method).toUpperCase(), target, String(timestamp), nonce, contentSha256].join("\n");
}

/** "v1=" + hex(HMAC-SHA256(secret, canonical)). The client side uses the same function; the tests use it to build requests. */
export function signCanonical(secret, canonical) {
  return `v1=${crypto.createHmac("sha256", secret).update(canonical).digest("hex")}`;
}

/** Constant-time equality of two strings (equal length is required first: timingSafeEqual throws otherwise). */
function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * The signing configuration from the environment.
 *
 * Secrets: at least 32 characters after trimming; a shorter value is not a secret (one warning, it is never echoed).
 * Mode (`BASHT_BRIDGE_SIGNING_MODE`): `off` | `optional` | `required`. `off` is EXPLICIT only: an unset mode is `optional`, and an
 * unrecognised value is `optional` too with the warning `mode_invalid` (a typo never enables `required` and never silently disables).
 * `required` is never degraded: without a usable secret it is returned as `required` together with `secretError`
 * (`secret_missing` | `secret_invalid` | `previous_only`), and the router then fails closed (503 signing_unavailable) instead of
 * accepting unsigned requests. `optional` without a usable secret has nothing to verify and accepts unsigned requests (status says so).
 * A previous secret only exists next to a current one.
 * @param {Record<string, string | undefined>} env
 * @param {(msg: string) => void} [warn]
 * @returns {{ secret: string | null, previousSecret: string | null, mode: "off" | "optional" | "required",
 *            secretError: "secret_missing" | "secret_invalid" | "previous_only" | null, warnings: string[] }}
 */
export function signingConfigFromEnv(env, warn = () => {}) {
  const raw = (name) => String(env?.[name] ?? "").trim();
  const cur = raw("BASHT_BRIDGE_SIGNING_SECRET");
  const prev = raw("BASHT_BRIDGE_SIGNING_SECRET_PREVIOUS");
  const curOk = cur.length >= MIN_SECRET_LENGTH;
  const prevOk = prev.length >= MIN_SECRET_LENGTH;
  if (cur && !curOk) warn(`BASHT_BRIDGE_SIGNING_SECRET is shorter than ${MIN_SECRET_LENGTH} characters: it is not a usable secret`);
  if (prev && !prevOk) warn(`BASHT_BRIDGE_SIGNING_SECRET_PREVIOUS is shorter than ${MIN_SECRET_LENGTH} characters and is ignored`);
  if (prevOk && !curOk) warn("BASHT_BRIDGE_SIGNING_SECRET_PREVIOUS is ignored without a valid BASHT_BRIDGE_SIGNING_SECRET");
  const warnings = [];
  const asked = raw("BASHT_BRIDGE_SIGNING_MODE").toLowerCase();
  let mode = "optional";
  if (asked) {
    if (SIGNING_MODES.includes(asked)) mode = asked;
    else { warnings.push("mode_invalid"); warn(`BASHT_BRIDGE_SIGNING_MODE "${asked.slice(0, 20)}" is not off, optional or required: using optional`); }
  }
  const secretError = curOk ? null : cur ? "secret_invalid" : prevOk ? "previous_only" : "secret_missing";
  if (mode === "required" && secretError) {
    warn(`BASHT_BRIDGE_SIGNING_MODE=required but the signing secret is unusable (${secretError}): every /app/v1 route except GET /status answers 503 signing_unavailable until it is fixed`);
  }
  return { secret: curOk ? cur : null, previousSecret: curOk && prevOk ? prev : null, mode, secretError, warnings };
}

/** Requests whose timestamp is older than the process start by more than this are refused (restart fence). */
export const BOOT_FENCE_SECONDS = 2;

/**
 * @param {{ secret?: string | null, previousSecret?: string | null, mode?: string, secretError?: string | null, warnings?: string[],
 *           now?: () => number, bootEpoch?: number }} o
 *   now: milliseconds (the bridge's own clock). bootEpoch: unix seconds of this process's start (default: now at creation).
 *   An unrecognised mode is "optional" with the warning `mode_invalid`. Without any option the verifier is "off".
 */
export function createSigningVerifier({ secret, previousSecret, mode = "off", secretError, warnings = [], now = Date.now, bootEpoch } = {}) {
  const valid = (x) => typeof x === "string" && x.length >= MIN_SECRET_LENGTH;
  const haveSecret = valid(secret);
  // the previous secret only exists next to a current one (a rotation window); alone it would enforce signing with a retired key
  const secrets = haveSecret ? [secret, ...(valid(previousSecret) ? [previousSecret] : [])] : [];
  const modeOk = SIGNING_MODES.includes(mode);
  const configured = modeOk ? mode : "optional";
  const allWarnings = [...new Set([...warnings, ...(modeOk ? [] : ["mode_invalid"])])];
  const why = haveSecret ? null : secretError ?? (secret ? "secret_invalid" : valid(previousSecret) ? "previous_only" : "secret_missing");
  const active = haveSecret && configured !== "off";
  const failClosed = configured === "required" && !haveSecret; // never degraded to accepting unsigned requests
  // Replay protection is deliberately modest: see the comment on `takeNonce`. The restart fence below closes replay of requests
  // captured before this process started; it is not durable protection.
  const boot = Number.isFinite(bootEpoch) ? Math.floor(bootEpoch) : Math.floor(now() / 1000);
  const nonces = new Map(); // nonce -> expiry (ms); insertion order = expiry order, because the TTL is constant

  /**
   * Bounded replay memory. IN MEMORY AND PER PROCESS, NOT DURABLE: a restart empties it, and several replicas would not share it
   * (a single replica is assumed). What bounds a replay is the timestamp window (<= 60 s) and, across a restart, the boot fence
   * (a request stamped before this process started is refused). The bearer token stays the primary credential: signing is a second
   * factor, not an anti-replay guarantee across restarts or replicas.
   */
  function takeNonce(nonce) {
    const t = now();
    for (const [n, until] of nonces) { if (until > t) break; nonces.delete(n); }
    if (nonces.has(nonce)) return false;
    nonces.set(nonce, t + NONCE_TTL_MS);
    while (nonces.size > NONCE_MAX_ENTRIES) nonces.delete(nonces.keys().next().value);
    return true;
  }

  return {
    mode: configured,
    active,
    failClosed,
    bootEpoch: boot,
    get nonceCount() { return nonces.size; },
    /** What /status shows (never a secret): the mode, whether it is verifying, why not, the warnings and the replay protection in force. */
    status() {
      return {
        mode: configured, active,
        ...(!haveSecret && configured === "required" ? { error: why } : {}),
        ...(!haveSecret && configured === "optional" ? { reason: why } : {}),
        warnings: allWarnings,
        replayProtection: "memory+boot_fence",
      };
    },
    /**
     * Header phase (before the body is read). `req`: { method, originalUrl, headers }.
     * @returns {{ ok: true, signed: boolean, contentSha256?: string } | { ok: false, reason: string }}
     *   signed:false = no signing header at all, accepted because the mode is "optional" (or "off"). ok:false = headers present but not
     *   valid (or absent in "required"); in "optional" the router treats that request as unsigned.
     */
    checkHeaders(req) {
      if (!active) return { ok: true, signed: false }; // off, or nothing to verify with ("required" without a secret never gets here: the router fails closed)
      const h = req.headers ?? {};
      const names = Object.values(SIGNING_HEADERS);
      if (!names.some((n) => h[n] !== undefined)) return configured === "required" ? { ok: false, reason: "missing" } : { ok: true, signed: false };
      // Malformed or incomplete headers are refused before any crypto work. A repeated header arrives joined with ", " and fails these shapes.
      const ts = h[SIGNING_HEADERS.timestamp];
      const nonce = h[SIGNING_HEADERS.nonce];
      const sha = h[SIGNING_HEADERS.contentSha256];
      const sig = h[SIGNING_HEADERS.signature];
      if (typeof ts !== "string" || !TS_RE.test(ts) || typeof nonce !== "string" || !NONCE_RE.test(nonce)
        || typeof sha !== "string" || !SHA_RE.test(sha) || typeof sig !== "string" || !SIG_RE.test(sig)) return { ok: false, reason: "malformed" };
      if (Math.abs(Math.floor(now() / 1000) - Number(ts)) > MAX_SKEW_SECONDS) return { ok: false, reason: "skew" };
      // restart fence: the nonce memory died with the previous process, so anything stamped before this one started is not accepted
      if (Number(ts) < boot - BOOT_FENCE_SECONDS) return { ok: false, reason: "before_boot" };
      const canonical = canonicalString({ method: req.method, target: req.originalUrl, timestamp: ts, nonce, contentSha256: sha });
      // every secret is tried, without stopping at the first hit: current then previous (rotation)
      let valid = false;
      for (const s of secrets) valid = safeEqual(signCanonical(s, canonical), sig) || valid;
      if (!valid) return { ok: false, reason: "signature" };
      // the nonce is spent only by a request whose signature is genuine: garbage cannot burn real nonces
      if (!takeNonce(nonce)) return { ok: false, reason: "replay" };
      return { ok: true, signed: true, contentSha256: sha };
    },
    /** Body phase: the bytes the router actually read must hash to what was signed. `body`: Buffer, or undefined/empty when none. */
    checkBody(expectedSha256, body) {
      return safeEqual(sha256Hex(body), expectedSha256);
    },
  };
}
