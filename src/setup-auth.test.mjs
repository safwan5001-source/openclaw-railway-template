import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateSetupRequest,
  basicPassword,
  clientKey,
  createFailureLimiter,
  isCrossSiteUnsafeRequest,
  isValidSetupPassword,
  mayInjectGatewayToken,
} from "./setup-auth.js";

const basic = (user, pw) => `Basic ${Buffer.from(`${user}:${pw}`).toString("base64")}`;

test("basic auth: parses credentials and compares the password only", () => {
  assert.equal(basicPassword(basic("any", "s3cret:with:colons")), "s3cret:with:colons");
  assert.equal(basicPassword("Bearer abc"), null);
  assert.equal(basicPassword(undefined), null);
  assert.equal(basicPassword("Basic"), null);
  assert.ok(isValidSetupPassword(basic("x", "pw-1"), "pw-1"));
  assert.ok(!isValidSetupPassword(basic("x", "pw-2"), "pw-1"));
  assert.ok(!isValidSetupPassword(basic("x", ""), ""), "an empty expected password never authenticates");
  assert.ok(!isValidSetupPassword("Bearer pw-1", "pw-1"));
});

test("client key: Railway edge X-Real-IP when behind Railway, socket address otherwise", () => {
  const req = { headers: { "x-real-ip": "203.0.113.9" }, socket: { remoteAddress: "10.0.0.1" } };
  assert.equal(clientKey(req, "app.up.railway.app"), "203.0.113.9");
  assert.equal(clientKey(req, ""), "10.0.0.1", "header ignored without Railway");
  assert.equal(clientKey({ headers: { "x-real-ip": "not-an-ip" }, socket: { remoteAddress: "10.0.0.1" } }, "d"), "10.0.0.1");
});

test("limiter: only failures count; per-key and global ceilings; window expiry; bounded memory", () => {
  let t = 0;
  const lim = createFailureLimiter({ windowMs: 1000, maxPerKey: 3, maxGlobal: 5, maxKeys: 4, now: () => t });
  for (let i = 0; i < 3; i++) lim.recordFailure("a");
  assert.ok(lim.isBlocked("a"));
  assert.ok(!lim.isBlocked("b"));
  lim.recordFailure("b");
  lim.recordFailure("c");
  assert.ok(lim.isBlocked("zzz"), "global ceiling reached (5 failures)");
  t = 1001;
  assert.ok(!lim.isBlocked("a") && !lim.isBlocked("zzz"), "window expired");
  const wide = createFailureLimiter({ windowMs: 1000, maxPerKey: 1, maxGlobal: 100, maxKeys: 4, now: () => t });
  for (const k of ["k1", "k2", "k3", "k4", "k5", "k6"]) wide.recordFailure(k);
  assert.ok(wide.size() <= 4, "key map is bounded");
  assert.ok(wide.isBlocked("k6"));
  wide.recordSuccess("k6");
  assert.ok(!wide.isBlocked("k6"), "a successful login clears that client's failures");
});

test("authenticateSetupRequest: none / ok / invalid / blocked; 'none' is not a failure", () => {
  const limiter = createFailureLimiter({ maxPerKey: 2, maxGlobal: 100 });
  const opts = { password: "right", limiter, railwayPublicDomain: "" };
  const req = (authorization) => ({ headers: authorization ? { authorization } : {}, socket: { remoteAddress: "1.2.3.4" } });
  for (let i = 0; i < 10; i++) assert.equal(authenticateSetupRequest(req(), opts), "none");
  assert.equal(authenticateSetupRequest(req("Bearer gateway-token"), opts), "none", "a gateway bearer is not a setup login");
  assert.equal(authenticateSetupRequest(req(basic("u", "right")), opts), "ok");
  assert.equal(authenticateSetupRequest(req(basic("u", "w1")), opts), "invalid");
  assert.equal(authenticateSetupRequest(req(basic("u", "w2")), opts), "invalid");
  assert.equal(authenticateSetupRequest(req(basic("u", "right")), opts), "blocked", "locked before the password is even checked");
});

test("CSRF: unsafe cross-site browser requests are refused; same-origin and non-browser clients pass", () => {
  const r = (method, headers) => ({ method, headers: { host: "app.example", ...headers } });
  assert.ok(!isCrossSiteUnsafeRequest(r("GET", { origin: "https://evil.example" })), "safe methods pass");
  assert.ok(isCrossSiteUnsafeRequest(r("POST", { origin: "https://evil.example" })));
  assert.ok(isCrossSiteUnsafeRequest(r("POST", { origin: "null" })));
  assert.ok(isCrossSiteUnsafeRequest(r("POST", { "sec-fetch-site": "cross-site" })));
  assert.ok(isCrossSiteUnsafeRequest(r("POST", { "sec-fetch-site": "same-site", origin: "https://app.example" })));
  assert.ok(!isCrossSiteUnsafeRequest(r("POST", { origin: "https://app.example", "sec-fetch-site": "same-origin" })));
  assert.ok(!isCrossSiteUnsafeRequest(r("POST", {})), "curl / scripts without Origin are not CSRF");
  assert.ok(!isCrossSiteUnsafeRequest({ method: "POST", headers: { host: "internal:8080", origin: "https://pub.up.railway.app" } }, "pub.up.railway.app"));
  assert.ok(isCrossSiteUnsafeRequest(r("POST", { origin: "not a url" })));
});

test("token injection: only for authenticated requests and never for /hooks/*", () => {
  assert.equal(mayInjectGatewayToken("/tools/invoke", "none"), false);
  assert.equal(mayInjectGatewayToken("/tools/invoke", "invalid"), false);
  assert.equal(mayInjectGatewayToken("/tools/invoke", "ok"), true);
  assert.equal(mayInjectGatewayToken("/hooks/agent", "ok"), false);
});
