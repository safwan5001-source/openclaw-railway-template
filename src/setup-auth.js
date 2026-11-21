// Access control for the public wrapper: the /setup login, failed-login throttling, cross-site (CSRF) protection and
// the rule for when the wrapper may attach the gateway token to a proxied request.
//
// Security model (see docs/SECURITY_REVIEW.md):
//  - SETUP_PASSWORD (HTTP Basic) is the only credential the wrapper accepts from the internet.
//  - The wrapper attaches `Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>` to a proxied request ONLY when that request
//    itself carries the valid setup password. Anonymous requests reach the gateway with their own credentials (or none),
//    so the gateway's own auth decides. /hooks/* never gets the token (hooks have their own token).
//  - Only FAILED logins are throttled (per client and globally), so normal use of the setup pages never locks the
//    operator out, and wrong-password guessing through the proxy path is throttled exactly like /setup.
import crypto from "node:crypto";
import net from "node:net";

const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest();

/** Parses `Authorization: Basic ...`. Returns the password, or null when the header is not Basic credentials. */
export function basicPassword(header) {
  if (typeof header !== "string") return null;
  const m = header.match(/^\s*basic\s+([A-Za-z0-9+/=._~-]+)\s*$/i);
  if (!m) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  return idx >= 0 ? decoded.slice(idx + 1) : "";
}

/** Constant-time comparison of the Basic password against the expected setup password. */
export function isValidSetupPassword(header, expected) {
  if (!expected) return false;
  const password = basicPassword(header);
  if (password === null) return false;
  return crypto.timingSafeEqual(sha256(password), sha256(expected));
}

/**
 * Key used to throttle failed logins. Behind Railway every connection comes from the edge proxy, so the socket address
 * is shared by all clients; the edge's X-Real-IP is used instead (the same trust proxy-headers.js already applies).
 * A spoofed header can only spread an attacker over more keys, which the global ceiling still bounds.
 */
export function clientKey(req, railwayPublicDomain) {
  if (railwayPublicDomain) {
    const real = req.headers?.["x-real-ip"];
    if (typeof real === "string" && net.isIP(real.trim())) return real.trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

/** Fixed-window counter of FAILED logins, per key and global. Memory is bounded by maxKeys. */
export function createFailureLimiter({
  windowMs = 15 * 60_000,
  maxPerKey = 10,
  maxGlobal = 200,
  maxKeys = 10_000,
  now = Date.now,
} = {}) {
  const perKey = new Map();
  let global = { start: 0, count: 0 };
  const fresh = (entry, t) => (!entry || t - entry.start >= windowMs ? { start: t, count: 0 } : entry);

  return {
    windowMs,
    isBlocked(key) {
      const t = now();
      global = fresh(global, t);
      const e = perKey.get(key);
      const perKeyCount = e && t - e.start < windowMs ? e.count : 0;
      return perKeyCount >= maxPerKey || global.count >= maxGlobal;
    },
    recordFailure(key) {
      const t = now();
      global = fresh(global, t);
      global.count++;
      const e = fresh(perKey.get(key), t);
      e.count++;
      perKey.delete(key);
      perKey.set(key, e);
      while (perKey.size > maxKeys) perKey.delete(perKey.keys().next().value);
    },
    recordSuccess(key) {
      perKey.delete(key);
    },
    sweep() {
      const t = now();
      for (const [k, e] of perKey) if (t - e.start >= windowMs) perKey.delete(k);
    },
    size() {
      return perKey.size;
    },
  };
}

/**
 * Classifies a request's setup credentials: "ok" | "none" (no Basic credentials) | "invalid" | "blocked".
 * Failures are recorded; "none" is not a failure (browsers always try once without credentials).
 */
export function authenticateSetupRequest(req, { password, limiter, railwayPublicDomain }) {
  const key = clientKey(req, railwayPublicDomain);
  if (basicPassword(req.headers?.authorization) === null) return "none";
  if (limiter.isBlocked(key)) return "blocked";
  if (isValidSetupPassword(req.headers.authorization, password)) {
    limiter.recordSuccess(key);
    return "ok";
  }
  limiter.recordFailure(key);
  return "invalid";
}

const REALM = 'Basic realm="OpenClaw Setup"';

/** Express middleware protecting /setup and /logs. */
export function createRequireSetupAuth({ password, limiter, railwayPublicDomain }) {
  return function requireSetupAuth(req, res, next) {
    if (!password) {
      return res
        .status(500)
        .type("text/plain")
        .send("SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.");
    }
    const result = authenticateSetupRequest(req, { password, limiter, railwayPublicDomain });
    if (result === "ok") return next();
    if (result === "blocked") {
      res.set("Retry-After", String(Math.ceil(limiter.windowMs / 1000)));
      return res.status(429).type("text/plain").send("Too many failed logins. Try again later.");
    }
    res.set("WWW-Authenticate", REALM);
    return res.status(401).type("text/plain").send(result === "none" ? "Auth required" : "Invalid password");
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF guard for state-changing requests. Browsers re-send cached Basic credentials on cross-site form posts, so an
 * unsafe request is only accepted when the browser says it is same-origin. Non-browser clients (no Origin and no
 * Sec-Fetch-Site) are unaffected.
 */
export function isCrossSiteUnsafeRequest(req, railwayPublicDomain) {
  if (SAFE_METHODS.has(String(req.method).toUpperCase())) return false;
  const site = req.headers?.["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers?.origin;
  if (origin === undefined) return false;
  if (typeof origin !== "string" || origin === "null") return true;
  let host;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return true;
  }
  const allowed = [req.headers?.host, railwayPublicDomain]
    .filter((h) => typeof h === "string" && h)
    .map((h) => h.trim().toLowerCase());
  return !allowed.includes(host);
}

export function rejectCrossSiteRequests({ railwayPublicDomain }) {
  return function csrfGuard(req, res, next) {
    if (isCrossSiteUnsafeRequest(req, railwayPublicDomain)) {
      return res.status(403).type("text/plain").send("Cross-site request refused.");
    }
    return next();
  };
}

/** Headers for the admin pages and API: no framing, no referrer leaks, no caching of secrets. */
export function setupSecurityHeaders(req, res, next) {
  res.set("X-Frame-Options", "DENY");
  res.set("Content-Security-Policy", "frame-ancestors 'none'");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Content-Type-Options", "nosniff");
  if (String(req.originalUrl || "").startsWith("/setup/api")) res.set("Cache-Control", "no-store");
  next();
}

/** True when the wrapper may attach the gateway token: never for /hooks/*, otherwise only for authenticated requests. */
export function mayInjectGatewayToken(url, setupAuthResult) {
  if (typeof url === "string" && url.startsWith("/hooks/")) return false;
  return setupAuthResult === "ok";
}
