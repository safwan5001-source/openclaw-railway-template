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
// middleware and the body phase once the body parser has produced the raw bytes.
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
 * The effective signing configuration from the environment. A secret shorter than 32 characters is ignored (one warning).
 * Mode: `BASHT_BRIDGE_SIGNING_MODE` = off | optional | required; default "optional" when a valid secret is set, "off" otherwise.
 * "optional"/"required" without a valid secret cannot be enforced: signing stays off and says so, so a typo can never lock the
 * owner out. A previous secret is only meaningful next to a current one.
 * @param {Record<string, string | undefined>} env
 * @param {(msg: string) => void} [warn]
 * @returns {{ secret: string | null, previousSecret: string | null, mode: "off" | "optional" | "required" }}
 */
export function signingConfigFromEnv(env, warn = () => {}) {
  const read = (name) => {
    const v = String(env?.[name] ?? "").trim();
    if (!v) return null;
    if (v.length < MIN_SECRET_LENGTH) { warn(`${name} is shorter than ${MIN_SECRET_LENGTH} characters and is ignored`); return null; }
    return v;
  };
  const secret = read("BASHT_BRIDGE_SIGNING_SECRET");
  let previousSecret = read("BASHT_BRIDGE_SIGNING_SECRET_PREVIOUS");
  if (previousSecret && !secret) { warn("BASHT_BRIDGE_SIGNING_SECRET_PREVIOUS is ignored without a valid BASHT_BRIDGE_SIGNING_SECRET"); previousSecret = null; }
  const asked = String(env?.BASHT_BRIDGE_SIGNING_MODE ?? "").trim().toLowerCase();
  let mode = secret ? "optional" : "off";
  if (asked) {
    if (!SIGNING_MODES.includes(asked)) warn(`BASHT_BRIDGE_SIGNING_MODE "${asked.slice(0, 20)}" is not off, optional or required: using ${mode}`);
    else if (asked !== "off" && !secret) warn(`BASHT_BRIDGE_SIGNING_MODE=${asked} needs a valid BASHT_BRIDGE_SIGNING_SECRET: signing stays off`);
    else mode = asked;
  }
  return { secret, previousSecret, mode };
}

/**
 * @param {{ secret?: string | null, previousSecret?: string | null, mode?: string, now?: () => number }} o
 *   now: milliseconds (the bridge's own clock). Without a valid secret the verifier is off whatever the mode says.
 */
export function createSigningVerifier({ secret, previousSecret, mode = "off", now = Date.now } = {}) {
  const secrets = [secret, previousSecret].filter((s) => typeof s === "string" && s.length >= MIN_SECRET_LENGTH);
  const effective = secrets.length && SIGNING_MODES.includes(mode) ? mode : "off";
  const nonces = new Map(); // nonce -> expiry (ms); insertion order = expiry order, because the TTL is constant

  /** Bounded replay memory (in memory only: a restart empties it, and the 60 s timestamp window bounds what could be replayed). */
  function takeNonce(nonce) {
    const t = now();
    for (const [n, until] of nonces) { if (until > t) break; nonces.delete(n); }
    if (nonces.has(nonce)) return false;
    nonces.set(nonce, t + NONCE_TTL_MS);
    while (nonces.size > NONCE_MAX_ENTRIES) nonces.delete(nonces.keys().next().value);
    return true;
  }

  return {
    mode: effective,
    get nonceCount() { return nonces.size; },
    /**
     * Header phase (before the body is read). `req`: { method, originalUrl, headers }.
     * @returns {{ ok: true, signed: boolean, contentSha256?: string } | { ok: false, reason: string }}
     *   signed:false = no signing header at all, accepted because the mode is "optional" (or "off").
     */
    checkHeaders(req) {
      if (effective === "off") return { ok: true, signed: false };
      const h = req.headers ?? {};
      const names = Object.values(SIGNING_HEADERS);
      if (!names.some((n) => h[n] !== undefined)) return effective === "required" ? { ok: false, reason: "missing" } : { ok: true, signed: false };
      // Malformed or incomplete headers are refused before any crypto work. A repeated header arrives joined with ", " and fails these shapes.
      const ts = h[SIGNING_HEADERS.timestamp];
      const nonce = h[SIGNING_HEADERS.nonce];
      const sha = h[SIGNING_HEADERS.contentSha256];
      const sig = h[SIGNING_HEADERS.signature];
      if (typeof ts !== "string" || !TS_RE.test(ts) || typeof nonce !== "string" || !NONCE_RE.test(nonce)
        || typeof sha !== "string" || !SHA_RE.test(sha) || typeof sig !== "string" || !SIG_RE.test(sig)) return { ok: false, reason: "malformed" };
      if (Math.abs(Math.floor(now() / 1000) - Number(ts)) > MAX_SKEW_SECONDS) return { ok: false, reason: "skew" };
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
