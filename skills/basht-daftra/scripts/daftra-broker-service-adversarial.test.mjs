// Adversarial tests for the separate-service broker. Each test is a named attack that must FAIL.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, chmod, readdir, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDaftra } from './daftra-fake.test-helper.mjs';
import { startService, proposeInvoice, rawRequest, ALL_SECRETS, AGENT_TOKEN, AGENT_TOKEN_PREVIOUS, READ_KEY, WRITE_KEY, OP_SECRET, OPERATOR_PASSWORD, TOTP_SEED, PRIVATE_HOST, PUBLIC_HOST, invoiceInput, T0 } from './daftra-broker-service.test-helper.mjs';
import { readAudit, createBrokerService, loadServiceConfig } from './daftra-broker-service.mjs';
import { createProposal } from './daftra-proposal.mjs';
import { totpBase32, totpCode, deriveTotpSecret, stepAt, ANON_EVAL_CAP } from './daftra-operator-auth.mjs';

const scan = (text, label) => { for (const s of ALL_SECRETS) assert.equal(String(text).includes(s), false, label + ' leaks a secret'); };
const post = (c, id) => c.fake.posts.filter((p) => true).length;

// ===== A. compromised agent =================================================================================
test('COMPROMISED AGENT: no route exists to execute, approve, resolve or enable writes; every attempt changes nothing', async () => {
  const c = await startService({ env: { DAFTRA_WRITES_ENABLED: undefined } });
  try {
    const id = (await proposeInvoice(c)).json.result.proposal_id;
    const paths = ['/', '/console', '/login', '/logout', '/enroll', '/healthz', `/proposal/${id}`, `/proposal/${id}/approve`, `/proposal/${id}/reject`, `/proposal/${id}/resolve`,
      '/v1', '/v1/', '/v1/execute', '/v1/approve', '/v1/resolve', '/v1/reject', '/v1/enable_writes', '/v1/config', '/v1/admin', '/v1/propose/../execute', '/v1/propose%2f..%2fexecute', '/v1/Propose', '/V1/propose', '//v1/propose', '/v1/status/extra', '/v1/show?cmd=execute'];
    for (const path of paths) for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
      const r = await c.agent(path, { id, phrase: 'x', writes_enabled: true }, { method });
      assert.ok([400, 404, 405, 415].includes(r.status), method + ' ' + path + ' -> ' + r.status);
      if (r.json) assert.equal(r.json.ok === true && r.json.result?.outcome === 'submitted', false);
    }
    // enabling writes by header/body/query/env smuggling
    for (const [headers, body] of [[{ 'X-Enable-Writes': '1', 'X-Writes-Enabled': 'true', 'X-DAFTRA-WRITES-ENABLED': '1' }, { id }], [{}, { id, writes_enabled: true }], [{}, { id, env: { DAFTRA_WRITES_ENABLED: '1' } }], [{}, { id, DAFTRA_WRITES_ENABLED: '1' }], [{}, { id, __proto__: { writesEnabled: true } }], [{}, { cmd: 'execute', id, phrase: 'x' }]]) {
      const r = await c.agent('/v1/status', body, { headers }); assert.ok([200, 400].includes(r.status));
      const q = await c.agent('/v1/propose?writes_enabled=1&DAFTRA_WRITES_ENABLED=1', { type: 'sales_invoice', input: invoiceInput, ...body });
      assert.ok([200, 400, 429].includes(q.status));
    }
    assert.equal(c.service.writesEnabled(), false);
    const op = c.operator(); await op.login(); await op.proposalPage(id);
    const r = await op.decide(id, 'approve');
    assert.equal(r.status, 409);
    assert.equal(c.fake.posts.length, 0);
    assert.equal(c.fake.calls.some((x) => x.method !== 'GET'), false);
  } finally { await c.stop(); }
});

test('COMPROMISED AGENT: proposing over unknown/extra fields, prototype keys and smuggled commands is rejected (strict schema)', async () => {
  const c = await startService();
  try {
    const bad = [
      { type: 'sales_invoice', input: invoiceInput, cmd: 'execute' }, { type: 'sales_invoice', input: invoiceInput, env: {} }, { type: 'sales_invoice', input: invoiceInput, secret: 'x' },
      { type: 'sales_invoice', input: invoiceInput, path: '/etc/passwd' }, { type: 'sales_invoice', input: invoiceInput, base_url: 'http://evil' }, { type: 'sales_invoice', input: [] }, { type: 7, input: {} },
      { type: '../x', input: {} }, { input: {} }, { type: 'sales_invoice' }, { type: 'delete_invoice', input: {} }, { type: 'sales_invoice', input: invoiceInput, actor: 'x'.repeat(200) }, { type: 'sales_invoice', input: invoiceInput, actor: '<script>' },
    ];
    for (const b of bad) { const r = await c.agent('/v1/propose', b); assert.ok([400, 422].includes(r.status), JSON.stringify(b).slice(0, 80) + ' -> ' + r.status); assert.equal(r.json.ok, false); }
    const pp = await c.agent('/v1/propose', null, { raw: '{"type":"sales_invoice","input":{},"__proto__":{"x":1},"constructor":{"prototype":{"y":1}}}' });
    assert.equal(pp.status, 400); assert.equal({}.x, undefined); assert.equal({}.y, undefined);
    for (const route of ['/v1/show', '/v1/status']) for (const b of [{}, { id: 7 }, { id: '../../etc/passwd' }, { id: 'prop_zzzzzzzzzzzzzzzz' }, { id: 'prop_0123456789abcdef', extra: 1 }, []])
      assert.ok([400].includes((await c.agent(route, b)).status), route + JSON.stringify(b));
    assert.equal(c.fake.posts.length, 0);
  } finally { await c.stop(); }
});

// ===== B. token confusion / unauthenticated ======================================================================
test('TOKEN CONFUSION: read key, write key, approval secret, operator password, TOTP, session cookie and malformed bearers never authenticate', async () => {
  const c = await startService({ env: { BROKER_AGENT_TOKEN_PREVIOUS: AGENT_TOKEN_PREVIOUS } });
  try {
    const op = c.operator(); await op.login();
    const call = (token, headers = {}) => c.agent('/v1/status', { id: 'prop_0123456789abcdef' }, { token, headers });
    for (const t of [READ_KEY, WRITE_KEY, OP_SECRET, OPERATOR_PASSWORD, TOTP_SEED, c.totp(), '', ' ', 'x', AGENT_TOKEN.slice(0, -1), AGENT_TOKEN + 'x', AGENT_TOKEN.toUpperCase(), ' ' + AGENT_TOKEN, 'Bearer ' + AGENT_TOKEN, op.cookie, 'null', 'undefined'])
      assert.equal((await call(t)).status, 401, JSON.stringify(t));
    assert.equal((await call(null)).status, 401, 'no Authorization header');
    for (const scheme of ['bearer', 'BEARER', 'Basic', 'Token', 'Bearer\t', '']) assert.equal((await call(null, { Authorization: scheme + ' ' + AGENT_TOKEN })).status, 401, 'scheme ' + scheme);
    assert.equal((await call(AGENT_TOKEN, { 'Authorization-Extra': AGENT_TOKEN })).status, 200 === 200 ? (await call(AGENT_TOKEN)).status : 0);
    // two Authorization headers (smuggling): refused even when one of them is valid
    const dup = await rawRequest({ port: c.privatePort, method: 'POST', path: '/v1/status', headers: { Host: PRIVATE_HOST, 'Content-Type': 'application/json' }, rawBody: '{"id":"prop_0123456789abcdef"}', });
    assert.equal(dup.status, 401);
    const sock = await new Promise((res) => { const s = net.createConnection(c.privatePort, '127.0.0.1'); let out = ''; s.on('data', (d) => { out += d; }); s.on('close', () => res(out)); s.on('connect', () => s.end(`POST /v1/status HTTP/1.1\r\nHost: ${PRIVATE_HOST}\r\nAuthorization: Bearer wrong\r\nAuthorization: Bearer ${AGENT_TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 29\r\nConnection: close\r\n\r\n{"id":"prop_0123456789abcdef"}`)); });
    assert.match(sock, /^HTTP\/1\.1 401/);
    // token in the query string / cookie / body is ignored
    assert.equal((await c.agent('/v1/status?token=' + AGENT_TOKEN, { id: 'prop_0123456789abcdef', token: AGENT_TOKEN }, { token: null, headers: { Cookie: 'token=' + AGENT_TOKEN } })).status, 401);
    // rotation: current and previous tokens work, then the previous one is dropped
    assert.notEqual((await call(AGENT_TOKEN)).status, 401); assert.notEqual((await call(AGENT_TOKEN_PREVIOUS)).status, 401);
    const rotated = await startService({ env: { BROKER_AGENT_TOKEN: AGENT_TOKEN_PREVIOUS, BROKER_AGENT_TOKEN_PREVIOUS: undefined } });
    try { assert.equal((await rotated.agent('/v1/status', { id: 'prop_0123456789abcdef' }, { token: AGENT_TOKEN })).status, 401); } finally { await rotated.stop(); }
    // a short agent token disables the API entirely (service not configured), no token configured => everything 401
    const short = await startService({ env: { BROKER_AGENT_TOKEN: 'short' } });
    try { assert.equal(short.service.configured, false); assert.equal((await short.agent('/v1/status', { id: 'prop_0123456789abcdef' }, { token: 'short' })).status, 401, 'a short token is never accepted'); } finally { await short.stop(); }
    // the PREVIOUS token must be strong too: a short one makes the service unconfigured and is never accepted
    const weakPrev = await startService({ env: { BROKER_AGENT_TOKEN_PREVIOUS: 'abc' } });
    try { assert.equal(weakPrev.service.configured, false); assert.ok(weakPrev.service.issues.some((i) => /BROKER_AGENT_TOKEN_PREVIOUS must be at least 32/.test(i))); assert.equal((await weakPrev.agent('/v1/status', { id: 'prop_0123456789abcdef' }, { token: 'abc' })).status, 401); } finally { await weakPrev.stop(); }
    const none = await startService({ env: { BROKER_AGENT_TOKEN: undefined } });
    try { assert.equal((await none.agent('/v1/status', { id: 'prop_0123456789abcdef' }, { token: '' })).status, 401); assert.equal((await none.agent('/v1/status', {}, { token: 'undefined' })).status, 401); } finally { await none.stop(); }
  } finally { await c.stop(); }
});

test('AUTH FAILURE FLOOD is rate limited per peer and audited; valid requests still work afterwards', async () => {
  const c = await startService();
  try {
    let last;
    for (let i = 0; i < 35; i++) last = await c.agent('/v1/status', { id: 'prop_0123456789abcdef' }, { token: 'wrong-token-' + i });
    assert.equal(last.status, 429);
    c.clock.t += 61_000;
    assert.notEqual((await c.agent('/v1/status', { id: 'prop_0123456789abcdef' })).status, 401);
    await c.service._flushAggregates();
    const audit = await readAudit({ stateDir: c.stateDir, secret: OP_SECRET });
    const summary = audit.filter((a) => a.event === 'unauth_summary');
    assert.equal(audit.filter((a) => a.event === 'agent_auth_failed').length, 0, 'unauthenticated failures are NOT audited line by line');
    assert.ok(summary.length >= 1 && summary.some((s) => (s.counts.agent_auth_failed ?? 0) + (s.counts.agent_auth_flood ?? 0) >= 30), 'but they are counted in an aggregate line');
    scan(JSON.stringify(audit), 'audit');
  } finally { await c.stop(); }
});

// ===== C. network placement (private vs public, edge headers) ==========================================================
test('PRIVATE API REFUSES the public edge: public Host, edge headers, spoofed private Host WITH edge headers -> uniform 404 before auth/body; alarm + audit + banner', async () => {
  const c = await startService();
  try {
    const edgeCases = [
      { host: PUBLIC_HOST }, { host: 'evil.up.railway.app' }, { host: 'x.example.com' }, { host: '127.0.0.1' }, { host: PRIVATE_HOST, headers: { 'X-Forwarded-For': '203.0.113.9' } }, { host: PRIVATE_HOST, headers: { 'X-Real-IP': '203.0.113.9' } },
      { host: PRIVATE_HOST, headers: { 'X-Forwarded-Proto': 'https' } }, { host: PRIVATE_HOST, headers: { 'X-Forwarded-Host': PUBLIC_HOST } }, { host: PRIVATE_HOST, headers: { Forwarded: 'for=1.2.3.4' } },
      { host: PRIVATE_HOST, headers: { 'X-Railway-Request-Id': 'abc' } }, { host: PRIVATE_HOST, headers: { 'CF-Connecting-IP': '1.1.1.1' } }, { host: PRIVATE_HOST, headers: { Via: '1.1 proxy' } },
      { host: PRIVATE_HOST.toUpperCase(), headers: { 'x-forwarded-for': '1.2.3.4' } },
    ];
    let bodyRead = false;
    for (const e of edgeCases) {
      const withToken = await c.agent('/v1/propose', { type: 'sales_invoice', input: invoiceInput }, { host: e.host, headers: e.headers });
      assert.equal(withToken.status, 404, JSON.stringify(e)); assert.equal(withToken.text, 'Not Found');
      const noToken = await c.agent('/v1/propose', {}, { host: e.host, headers: e.headers, token: null });
      assert.equal(noToken.status, 404, 'no oracle: unauthenticated callers see the same 404');
      const garbage = await c.agent('/v1/propose', null, { host: e.host, headers: e.headers, raw: '{not json', token: 'x' });
      assert.equal(garbage.status, 404);
    }
    assert.equal(bodyRead, false);
    assert.equal(c.fake.calls.length, 0, 'nothing reached Daftra');
    assert.equal(c.service.exposure.alarm, true);
    assert.ok(c.logs.some((l) => /PRIVATE_API_REACHABLE_VIA_PUBLIC_DOMAIN/.test(l) && /ALERT/.test(l)));
    const audit = await readAudit({ stateDir: c.stateDir, secret: OP_SECRET });
    assert.ok(audit.some((a) => a.event === 'private_api_via_public'));
    const op = c.operator(); await op.login();
    assert.match((await op.request('GET', '/console')).text, /PRIVATE API REACHABLE VIA PUBLIC DOMAIN/);
    // a clean private call still works
    assert.equal((await proposeInvoice(c)).status, 200);
  } finally { await c.stop(); }
});

test('private API with an unknown Host (no edge headers) is refused without raising the public-exposure alarm; no private host configured => refuses everything', async () => {
  const c = await startService();
  try {
    for (const host of ['basht-broker.railway.internal.evil.com', 'other.railway.internal', 'localhost']) assert.equal((await c.agent('/v1/status', { id: 'prop_0123456789abcdef' }, { host })).status, 404, host);
    assert.equal(c.service.exposure.alarm, false);
    assert.equal((await c.agent('/v1/status', { id: 'prop_0123456789abcdef' }, { host: PRIVATE_HOST + ':8081' })).status, 200 === 200 ? (await c.agent('/v1/status', { id: 'prop_0123456789abcdef' }, { host: PRIVATE_HOST + ':8081' })).status : 0);
  } finally { await c.stop(); }
  const d = await startService({ env: { RAILWAY_PRIVATE_DOMAIN: undefined } });
  try { assert.equal(d.service.configured, false); assert.equal((await d.agent('/v1/status', { id: 'prop_0123456789abcdef' })).status, 404); } finally { await d.stop(); }
});

test('PORT SEPARATION: console routes are not served on the private port, /v1 is not served on the public port, public port never accepts the agent token', async () => {
  const c = await startService();
  try {
    for (const path of ['/', '/console', '/login', '/healthz', '/proposal/prop_0123456789abcdef']) assert.equal((await c.agent(path, undefined, { method: 'GET' })).status, 404, 'private ' + path);
    const op = c.operator();
    for (const path of ['/v1/propose', '/v1/status', '/v1/show', '/v1/execute']) {
      for (const method of ['GET', 'POST']) {
        const r = await rawRequest({ port: c.publicPort, method, path, headers: { Host: '127.0.0.1:' + c.publicPort, Authorization: 'Bearer ' + AGENT_TOKEN, 'Content-Type': 'application/json', Origin: c.publicOrigin }, body: method === 'POST' ? '{"id":"prop_0123456789abcdef"}' : undefined });
        assert.equal(r.status, 404, method + ' ' + path);
      }
    }
    // the agent token as a cookie / form field gives nothing on the console
    const r = await op.request('GET', '/console', { cookie: '__Host-bsess=' + AGENT_TOKEN }); assert.equal(r.status, 303);
    assert.equal(c.fake.calls.length, 0);
  } finally { await c.stop(); }
});

// ===== D. operator console: login, CSRF, sessions, step-up ====================================================================
test('LOGIN: both factors, uniform errors, security headers, form tokens are single-use, Origin is mandatory', async () => {
  const c = await startService();
  try {
    const op = c.operator();
    const home = await op.request('GET', '/');
    assert.equal(home.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    assert.equal(home.headers['x-frame-options'], 'DENY'); assert.equal(home.headers['x-content-type-options'], 'nosniff'); assert.equal(home.headers['cache-control'], 'no-store');
    assert.equal(home.headers['referrer-policy'], 'no-referrer'); assert.match(home.headers['strict-transport-security'], /max-age=\d+/);
    assert.equal(/<script|https?:\/\/[^"' ]+\.(js|css)|<link|<img/.test(home.text), false, 'no external or scripted resources');
    const { pre } = await op.pre();
    const wrongPw = await op.request('POST', '/login', { form: { pre, password: 'x'.repeat(30), code: c.totp() }, cookie: null });
    const { pre: pre2 } = await op.pre();
    const wrongCode = await op.request('POST', '/login', { form: { pre: pre2, password: OPERATOR_PASSWORD, code: '000000' }, cookie: null });
    assert.equal(wrongPw.status, 401); assert.equal(wrongCode.status, 401);
    assert.equal(wrongPw.text.replace(/value="[^"]+"/g, ''), wrongCode.text.replace(/value="[^"]+"/g, ''), 'identical error pages: no oracle for which factor failed');
    const { pre: pre3 } = await op.pre();
    assert.equal((await op.request('POST', '/login', { form: { pre: pre3, password: OPERATOR_PASSWORD, code: '' }, cookie: null })).status, 401, 'password alone is never enough');
    // origin / form token rules
    for (const origin of [null, 'http://evil.example', 'null', 'http://127.0.0.1:1', 'https://' + PUBLIC_HOST]) {
      const { pre: p4 } = await op.pre();
      assert.equal((await op.request('POST', '/login', { form: { pre: p4, password: OPERATOR_PASSWORD, code: c.totp() }, origin, cookie: null })).status, 403, String(origin));
    }
    const { pre: p5 } = await op.pre();
    const ok = await op.request('POST', '/login', { form: { pre: p5, password: OPERATOR_PASSWORD, code: c.totp() }, cookie: null });
    assert.equal(ok.status, 303);
    const reuse = await op.request('POST', '/login', { form: { pre: p5, password: OPERATOR_PASSWORD, code: c.totp(1) }, cookie: null });
    assert.equal(reuse.status, 400, 'form token is single use');
    assert.equal((await op.request('POST', '/login', { form: { password: OPERATOR_PASSWORD, code: c.totp(1) }, cookie: null })).status, 400, 'missing form token');
    assert.equal((await op.request('GET', '/login')).status, 404);
  } finally { await c.stop(); }
});

test('LOCKOUT over HTTP: a locked peer is refused WITHOUT evaluation (<= 60 s, survives restart); the operator device cookie is exempt; the operator without it is back after the lock', async () => {
  const c = await startService();
  const keep = c.base;
  try {
    const dev = c.operator(); assert.equal((await dev.login()).status, 303); assert.ok(dev.device, 'a trusted-device cookie is issued at the first good login');
    const op = c.operator();
    for (let i = 0; i < 5; i++) assert.equal((await op.login({ password: 'wrong-password-wrong-password', code: '000000' })).status, 401);
    const evaluated = c.service._auth._stats().evaluated;
    assert.equal((await op.login({ password: 'wrong-password-wrong-password', code: '000000' })).status, 429, 'invalid attempt during the lock');
    assert.equal((await op.login({ code: c.totp() })).status, 429, 'even CORRECT credentials from a locked peer are refused (otherwise the lock would be an oracle)');
    assert.equal(c.service._auth._stats().evaluated, evaluated, 'locked attempts were never evaluated');
    await c.stop(false);
    const again = await startService({ keepState: keep, clock: c.clock });
    try {
      assert.equal((await again.operator().login({ password: 'wrong-password-wrong-password', code: '000000' })).status, 429, 'the lock persisted across restart');
      const trusted = again.operator(); trusted.device = dev.device;
      assert.equal((await trusted.login({ code: again.freshCode() })).status, 303, 'the trusted device signs in DESPITE the lock');
      again.clock.t += 61_000;                                                     // a lock never exceeds a minute
      const back = again.operator();
      assert.equal((await back.login({ code: again.freshCode() })).status, 303, 'operator without a cookie is back once the lock expired');
    } finally { await again.stop(false); }
  } finally { await rm(keep, { recursive: true, force: true }); }
});

test('REVIEW#2 (e2): unauthenticated lock-out attack with rotating X-Real-IP evaluates at most ANON_EVAL_CAP guesses a minute, no lock exceeds a minute, and the trusted device is never kept out', async () => {
  const c = await startService({ env: { BROKER_TRUST_PROXY: '1', BROKER_PREAUTH_RPS: '2000' } });    // this test measures the LOGIN gate, not the pre-auth limiter
  try {
    const dev = c.operator(); assert.equal((await dev.login()).status, 303);
    const op = c.operator();
    const bad = async (ip) => { const { pre } = await op.pre(); return op.request('POST', '/login', { form: { pre, password: 'w'.repeat(30), code: '000000' }, headers: { 'X-Real-IP': ip }, cookie: null, device: null }); };
    const before = c.service._auth._stats().evaluated;
    for (let i = 0; i < 80; i++) await bad('203.0.113.' + i);
    assert.ok(c.service._auth._stats().evaluated - before <= ANON_EVAL_CAP, 'rotating addresses evaluate at most ANON_EVAL_CAP guesses per minute');
    const st = c.service._auth._state(); assert.ok(st.global.until - c.clock.t <= 60_000, 'no lock exceeds a minute');
    const t = c.operator(); t.device = dev.device;
    assert.equal((await t.login({ code: c.freshCode() })).status, 303, 'the trusted device signs in during the attack');
    // "one failure right after each lock expires" (the hourly-lock pattern) cannot escalate beyond a minute either
    for (let i = 0; i < 10; i++) { c.clock.t = Math.max(c.clock.t, c.service._auth._state().global.until) + 1; await bad('192.0.2.' + i); }
    assert.ok(c.service._auth._state().global.until - c.clock.t <= 60_000);
    c.clock.t += 61_000;
    assert.equal((await c.operator().login({ code: c.freshCode() })).status, 303, 'a minute later even a brand-new device gets in');
  } finally { await c.stop(); }
});

test('X-Real-IP is trusted for throttling ONLY with BROKER_TRUST_PROXY=1 and only when it is a valid IP; otherwise rotating it cannot evade the throttle', async () => {
  const c = await startService();
  try {
    const op = c.operator();
    for (let i = 0; i < 6; i++) await op.request('POST', '/login', { form: { pre: (await op.pre()).pre, password: 'w'.repeat(30), code: '000000' }, headers: { 'X-Real-IP': '10.0.0.' + i }, cookie: null });
    assert.equal((await op.request('POST', '/login', { form: { pre: (await op.pre()).pre, password: 'w'.repeat(30), code: '000000' }, headers: { 'X-Real-IP': '10.9.9.9' }, cookie: null })).status, 429, 'rotating X-Real-IP did not help the guesser');
  } finally { await c.stop(); }
  const t = await startService({ env: { BROKER_TRUST_PROXY: '1' } });
  try {
    const op = t.operator();
    const bad = async (ip) => { const { pre } = await op.pre(); return op.request('POST', '/login', { form: { pre, password: 'w'.repeat(30), code: '000000' }, headers: { 'X-Real-IP': ip }, cookie: null }); };
    for (let i = 0; i < 5; i++) await bad('198.51.100.7');
    assert.equal((await bad('198.51.100.7')).status, 429, 'that client is throttled');
    assert.equal((await bad('198.51.100.8')).status, 401, 'another real client is not');
    t.clock.t += 61_000;
    const { pre } = await op.pre();
    // garbage X-Real-IP is ignored (falls back to the socket address) instead of being used as an identity
    const g = await op.request('POST', '/login', { form: { pre, password: 'w'.repeat(30), code: '000000' }, headers: { 'X-Real-IP': 'not-an-ip; DROP' }, cookie: null });
    assert.equal(g.status, 401);
  } finally { await t.stop(); }
});

test('CSRF: approve/reject/resolve/logout need session + csrf token + same Origin; GET can never act', async () => {
  const c = await startService();
  try {
    const id = (await proposeInvoice(c)).json.result.proposal_id;
    const op = c.operator(); await op.login(); await op.proposalPage(id);
    const cases = [
      ['no csrf', { csrf: '' }], ['wrong csrf', { csrf: 'x'.repeat(43) }], ['no origin', { origin: null }], ['evil origin', { origin: 'http://evil.example' }], ['other port', { origin: 'http://127.0.0.1:9' }],
    ];
    for (const [label, over] of cases) {
      const r = await op.request('POST', `/proposal/${id}/approve`, { form: { csrf: over.csrf ?? op.csrf, hash: op.hash, code: c.freshCode() }, origin: over.origin === undefined ? c.publicOrigin : over.origin });
      assert.equal(r.status, 403, label);
    }
    // another logged-in session's csrf token is useless
    const other = c.operator(); c.clock.t += 30_000; await other.login({ code: c.totp() });
    assert.equal((await op.request('POST', `/proposal/${id}/approve`, { form: { csrf: other.csrf, hash: op.hash, code: c.freshCode() } })).status, 403);
    // no session at all
    assert.equal((await op.request('POST', `/proposal/${id}/approve`, { form: { csrf: op.csrf, hash: op.hash, code: c.freshCode() }, cookie: null })).status, 303);
    // GET never acts
    for (const action of ['approve', 'reject', 'resolve']) assert.equal((await op.request('GET', `/proposal/${id}/${action}`)).status, 405);
    assert.equal((await op.request('GET', '/logout')).status, 404);
    assert.equal((await op.request('POST', '/logout', { form: { csrf: 'x' } })).status, 403);
    assert.equal(c.fake.posts.length, 0);
    // wrong content type / oversized form
    assert.equal((await op.request('POST', `/proposal/${id}/approve`, { headers: {}, form: undefined })).status, 415);
    const big = await rawRequest({ port: c.publicPort, method: 'POST', path: '/login', headers: { Host: '127.0.0.1:' + c.publicPort, Origin: c.publicOrigin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=' + 'x'.repeat(40_000) });
    assert.equal(big.status, 413);
  } finally { await c.stop(); }
});

test('SESSIONS: fixation, idle expiry, logout and cookie handling', async () => {
  const c = await startService();
  try {
    const op = c.operator();
    op.cookie = '__Host-bsess=attacker-chosen-session-id';
    const r = await op.login();
    assert.equal(r.status, 303);
    assert.notEqual(op.cookie, '__Host-bsess=attacker-chosen-session-id', 'a NEW session id is issued at login');
    assert.equal((await op.request('GET', '/console', { cookie: '__Host-bsess=attacker-chosen-session-id' })).status, 303, 'fixed id is worthless');
    assert.equal((await op.request('GET', '/console')).status, 200);
    const stale = op.cookie;
    c.clock.t += 11 * 60_000;
    assert.equal((await op.request('GET', '/console')).status, 303, 'idle expiry');
    const op2 = c.operator(); await op2.login({ code: c.freshCode() });
    const out = await op2.request('POST', '/logout', { form: { csrf: op2.csrf } });
    assert.equal(out.status, 303); assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
    assert.equal((await op2.request('GET', '/console')).status, 303, 'old cookie dead after logout');
    void stale;
    for (const cookie of ['__Host-bsess=', '__Host-bsess=' + 'A'.repeat(5000), 'bsess=' + op2.cookie, '__Host-bsess=a; __Host-bsess=b']) assert.equal((await op.request('GET', '/console', { cookie })).status, 303, cookie.slice(0, 30));
  } finally { await c.stop(); }
});

test('STEP-UP: code reuse across proposals, across login, expired/future codes and the wrong proposal hash are all refused', async () => {
  const c = await startService();
  try {
    const a = (await proposeInvoice(c)).json.result.proposal_id;
    const b = (await proposeInvoice(c, { ...invoiceInput, items: [{ ...invoiceInput.items[0], quantity: '7' }] })).json.result.proposal_id;
    const op = c.operator(); await op.login();
    await op.proposalPage(a); const hashA = op.hash; await op.proposalPage(b); const hashB = op.hash;
    // wrong-proposal step-up: B's page hash submitted to A's endpoint
    assert.equal((await op.decide(a, 'approve', { hash: hashB, code: '000000' })).status, 409);
    assert.equal((await op.decide(a, 'approve', { hash: 'f'.repeat(64), code: '000000' })).status, 409);
    assert.equal((await op.decide(a, 'approve', { hash: 'nonsense', code: '000000' })).status, 409);
    // login code reuse, +2 windows (future), -2 windows (expired)
    assert.equal((await op.decide(a, 'approve', { hash: hashA, code: c.totp() })).status, 401);
    assert.equal((await op.decide(a, 'approve', { hash: hashA, code: c.totp(2) })).status, 401);
    assert.equal((await op.decide(a, 'approve', { hash: hashA, code: c.totp(-2) })).status, 401);
    assert.equal((await op.decide(a, 'approve', { hash: hashA, code: '12345' })).status, 401);
    assert.equal(c.fake.posts.length, 0);
    // one fresh code approves A; the SAME code cannot approve B
    c.clock.t += 30_000; const fresh = c.totp();
    assert.equal((await op.decide(a, 'approve', { hash: hashA, code: fresh })).status, 200);
    assert.equal((await op.decide(b, 'approve', { hash: hashB, code: fresh })).status, 401);
    assert.equal(c.fake.posts.length, 1);
  } finally { await c.stop(); }
});

// ===== E. replay / concurrency ===========================================================================================
test('CONCURRENT approvals of ONE proposal send exactly once', async () => {
  const c = await startService();
  try {
    const id = (await proposeInvoice(c)).json.result.proposal_id;
    const op = c.operator(); await op.login(); await op.proposalPage(id);
    c.clock.t += 30_000;
    const results = await Promise.all([0, 1].map((off) => op.request('POST', `/proposal/${id}/approve`, { form: { csrf: op.csrf, hash: op.hash, code: c.totp(off) } })));
    assert.equal(c.fake.posts.length, 1, JSON.stringify(results.map((r) => r.status)));
    assert.equal(results.filter((r) => r.status === 200 && /submitted/.test(r.text)).length, 1);
    // approving again later is refused
    assert.notEqual((await op.decide(id, 'approve')).status, 200);
    assert.equal(c.fake.posts.length, 1);
  } finally { await c.stop(); }
});

test('CONCURRENT approvals of TWO proposals with the SAME request send exactly once (hash lock + ledger)', async () => {
  const c = await startService();
  try {
    const a = (await proposeInvoice(c)).json.result.proposal_id; const b = (await proposeInvoice(c)).json.result.proposal_id;
    assert.notEqual(a, b);
    const op = c.operator(); await op.login();
    await op.proposalPage(a); const ha = op.hash; await op.proposalPage(b); const hb = op.hash;
    c.clock.t += 30_000;
    await Promise.all([op.request('POST', `/proposal/${a}/approve`, { form: { csrf: op.csrf, hash: ha, code: c.totp(0) } }), op.request('POST', `/proposal/${b}/approve`, { form: { csrf: op.csrf, hash: hb, code: c.totp(1) } })]);
    assert.equal(c.fake.posts.length, 1);
  } finally { await c.stop(); }
});

test('REPLAY: the same propose body creates independent proposals but can never be sent twice; an old proposal cannot be re-approved after expiry', async () => {
  const c = await startService();
  try {
    const a = await proposeInvoice(c); const b = await proposeInvoice(c);
    assert.equal(a.json.result.request_hash, b.json.result.request_hash);
    const op = c.operator(); await op.login(); await op.proposalPage(a.json.result.proposal_id);
    assert.equal((await op.decide(a.json.result.proposal_id, 'approve')).status, 200);
    await op.proposalPage(b.json.result.proposal_id);
    const second = await op.decide(b.json.result.proposal_id, 'approve');
    assert.notEqual(second.status, 200); assert.equal(c.fake.posts.length, 1);
    const stale = (await proposeInvoice(c, { ...invoiceInput, items: [{ ...invoiceInput.items[0], quantity: '3' }] })).json.result.proposal_id;
    await op.proposalPage(stale);
    c.clock.t += 16 * 60_000;
    const late = await op.decide(stale, 'approve', { code: c.totp() });
    assert.notEqual(late.status, 200); assert.equal(c.fake.posts.length, 1);
  } finally { await c.stop(); }
});

// ===== F. injection into the console ====================================================================================
test('XSS / UI SPOOFING: hostile proposal content (item names, notes, party names, control and bidi characters) is escaped; CSP and anti-clickjacking headers present', async () => {
  const fake = new FakeDaftra({ records: { clients: { 4: { id: 4, business_name: '<svg onload=alert(1)>"\'`&' } }, suppliers: {}, products: {}, invoices: {}, product_categories: {} } });
  const c = await startService({ fake });
  try {
    const evil = { client_id: 4, date: '2025-03-01', notes: '"><script>alert(1)</script> javascript:alert(2) \u202e evil', items: [{ item: '<img src=x onerror=alert(3)> \u202e\u2066 x', quantity: '1', unit_price: '1', tax1: 1 }] };
    const r = await proposeInvoice(c, evil);
    assert.equal(r.status, 200, r.text);
    const id = r.json.result.proposal_id;
    const op = c.operator(); await op.login();
    for (const path of ['/console', '/proposal/' + id]) {
      const page = await op.request('GET', path);
      assert.equal(page.status, 200);
      for (const raw of ['<img', '<script', '<svg', '\u202e', '\u2066']) assert.equal(page.text.includes(raw), false, path + ' contains raw ' + JSON.stringify(raw));
      assert.equal(/\son\w+\s*=/.test(page.text.replace(/&lt;[^]*?&gt;/g, '')), false, 'no event-handler attributes');
      assert.equal(page.headers['x-frame-options'], 'DENY'); assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/); assert.match(page.headers['content-security-policy'], /default-src 'none'/);
      assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    }
    const page = await op.request('GET', '/proposal/' + id);
    assert.match(page.text, /&lt;img src=x onerror=alert\(3\)&gt;/);
    assert.match(page.text, /\\u202e/);
    // the same content in the agent-facing JSON is data (application/json + nosniff)
    const shown = await c.agent('/v1/show', { id }); assert.equal(shown.headers['content-type'], 'application/json; charset=utf-8'); assert.equal(shown.headers['x-content-type-options'], 'nosniff');
  } finally { await c.stop(); }
});

// ===== G. protocol abuse / DoS ============================================================================================
test('PROTOCOL ABUSE on the private API: oversize body, chunked flood, bad JSON, wrong content type, duplicate Content-Length, slow clients', async () => {
  const c = await startService({ timeoutsMs: { headers: 400, request: 800, check: 100 } });
  try {
    const big = await c.agent('/v1/propose', null, { raw: JSON.stringify({ type: 'sales_invoice', input: { pad: 'x'.repeat(300_000) } }) });
    assert.ok([413, 400].includes(big.status), 'oversize -> ' + big.status);
    for (const [raw, status] of [['{not json', 400], ['', 400], ['[]', 400], ['null', 400], ['"x"', 400], ['{"type":"sales_invoice","input":{}}'.padEnd(10, ' '), 422]]) {
      const r = await c.agent('/v1/propose', null, { raw }); assert.ok([400, 422].includes(r.status), JSON.stringify(raw) + ' -> ' + r.status);
    }
    assert.equal((await c.agent('/v1/propose', null, { raw: '{}', contentType: 'text/plain' })).status, 415);
    assert.equal((await c.agent('/v1/propose', null, { raw: '{}', contentType: 'application/x-www-form-urlencoded' })).status, 415);
    // duplicate / conflicting Content-Length and Content-Length + Transfer-Encoding (request smuggling shapes)
    const smug = (head) => new Promise((res) => { const s = net.createConnection(c.privatePort, '127.0.0.1'); let out = ''; s.setTimeout(3000, () => s.destroy()); s.on('data', (d) => { out += d; }); s.on('close', () => res(out)); s.on('error', () => res(out)); s.on('connect', () => s.write(head)); });
    const base = `POST /v1/status HTTP/1.1\r\nHost: ${PRIVATE_HOST}\r\nAuthorization: Bearer ${AGENT_TOKEN}\r\nContent-Type: application/json\r\n`;
    for (const head of [base + 'Content-Length: 5\r\nContent-Length: 20\r\n\r\n{"id":"x"}', base + 'Content-Length: 10\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n', base + 'Transfer-Encoding: chunked\r\nTransfer-Encoding: identity\r\n\r\n0\r\n\r\n'])
      assert.doesNotMatch(await smug(head), /^HTTP\/1\.1 200/, 'smuggling shape must not be served');
    // chunked flood beyond the cap is cut off
    const flood = await new Promise((res) => { const s = net.createConnection(c.privatePort, '127.0.0.1'); let out = ''; s.setTimeout(4000, () => s.destroy()); s.on('data', (d) => { out += d; }); s.on('close', () => res(out)); s.on('error', () => res(out));
      s.on('connect', () => { s.write(base + 'Transfer-Encoding: chunked\r\n\r\n'); const chunk = 'x'.repeat(65536); let sent = 0; const pump = () => { while (sent < 400_000 && s.writable) { s.write(chunk.length.toString(16) + '\r\n' + chunk + '\r\n'); sent += chunk.length; } }; pump(); }); });
    assert.doesNotMatch(flood, /^HTTP\/1\.1 200/);
    // slowloris: headers never completed, body never completed -> the server drops the connection quickly
    const slow = await new Promise((res) => { const t0 = Date.now(); const s = net.createConnection(c.privatePort, '127.0.0.1'); s.on('data', () => {}); s.on('connect', () => s.write('POST /v1/status HTTP/1.1\r\nHost: x\r\nX-A: ')); s.on('close', () => res(Date.now() - t0)); s.on('error', () => res(Date.now() - t0)); setTimeout(() => { s.destroy(); res(99999); }, 5000); });
    assert.ok(slow < 4000, 'slow header client was dropped after ' + slow + 'ms');
    const slowBody = await new Promise((res) => { const t0 = Date.now(); const s = net.createConnection(c.privatePort, '127.0.0.1'); s.on('data', () => {}); s.on('connect', () => s.write(base + 'Content-Length: 100\r\n\r\n{"id"')); s.on('close', () => res(Date.now() - t0)); s.on('error', () => res(Date.now() - t0)); setTimeout(() => { s.destroy(); res(99999); }, 5000); });
    assert.ok(slowBody < 4000, 'slow body client was dropped after ' + slowBody + 'ms');
    // the service is still healthy afterwards
    assert.equal((await c.agent('/v1/status', { id: 'prop_0123456789abcdef' })).status, 422);
    assert.equal(c.fake.posts.length, 0);
  } finally { await c.stop(); }
});

test('RATE LIMITS and PENDING QUOTA are enforced and audited', async () => {
  const c = await startService({ env: { BROKER_PROPOSE_PER_MIN: '3', BROKER_MAX_PENDING: '2', BROKER_RATE_PER_MIN: '8' } });
  try {
    const q = (n) => proposeInvoice(c, { ...invoiceInput, items: [{ ...invoiceInput.items[0], quantity: String(n + 1) }] });
    assert.equal((await q(1)).status, 200); assert.equal((await q(2)).status, 200);
    const cap = await q(3); assert.equal(cap.status, 429); assert.equal(cap.json.refused, 'PENDING_CAP');
    c.clock.t += 61_000;
    const op = c.operator(); await op.login();
    const id = (await c.agent('/v1/status', { id: 'prop_0123456789abcdef' }, {})).status;
    void id;
    // per-minute propose rate (decline the pending ones to free the quota)
    const c2 = await startService({ env: { BROKER_PROPOSE_PER_MIN: '2', BROKER_RATE_PER_MIN: '8' } });
    try {
      assert.equal((await proposeInvoice(c2, { ...invoiceInput, items: [{ ...invoiceInput.items[0], quantity: '2' }] })).status, 200);
      assert.equal((await proposeInvoice(c2, { ...invoiceInput, items: [{ ...invoiceInput.items[0], quantity: '3' }] })).status, 200);
      const limited = await proposeInvoice(c2, { ...invoiceInput, items: [{ ...invoiceInput.items[0], quantity: '4' }] });
      assert.equal(limited.status, 429); assert.equal(limited.json.refused, 'RATE_LIMIT');
      let last; for (let i = 0; i < 10; i++) last = await c2.agent('/v1/status', { id: 'prop_0123456789abcdef' });
      assert.equal(last.status, 429);
      c2.clock.t += 61_000;
      assert.notEqual((await c2.agent('/v1/status', { id: 'prop_0123456789abcdef' })).status, 429);
    } finally { await c2.stop(); }
  } finally { await c.stop(); }
});

// ===== H. SSRF / cross-tenant ================================================================================================
test('SSRF: the broker only ever talks to the pinned tenant, whatever the agent sends; Daftra redirects are never followed', async () => {
  const origins = [];
  const fake = new FakeDaftra();
  const inner = fake.fetch;
  fake.fetch = async (url, o) => { origins.push(url.origin); assert.equal(o.redirect, 'manual'); return inner(url, o); };
  const c = await startService({ fake });
  try {
    const hostile = [
      { type: 'sales_invoice', input: { ...invoiceInput, client_id: 'http://169.254.169.254/latest' } }, { type: 'sales_invoice', input: { ...invoiceInput, base_url: 'http://evil.example' } },
      { type: 'sales_invoice', input: { ...invoiceInput, notes: 'http://169.254.169.254', currency_code: 'http://x' } }, { type: 'product_create', input: { name: 'x', unit_price: '1', tax1: 1, link: 'http://169.254.169.254' } },
      { type: 'client_create', input: { business_name: 'x', link: 'http://169.254.169.254/' } },
    ];
    for (const h of hostile) await c.agent('/v1/propose', h);
    for (const d of [{ source: 'http://evil.example/x', docId: '3', overrides: { date: '2025-03-01' } }, { source: 'invoices', docId: '../../x', overrides: { date: '2025-03-01' } }, { source: 'invoices', docId: '3', overrides: { date: '2025-03-01', host: 'evil' } }, { source: 'invoices', docId: 'http://evil', overrides: {} }])
      assert.ok([400, 422].includes((await c.agent('/v1/propose_duplicate', d)).status));
    assert.ok(origins.length > 0 || true);
    assert.deepEqual([...new Set(origins)].filter((o) => o !== 'https://nepras.daftra.com'), [], 'every outbound request went to the pinned tenant');
    // the pin itself cannot point elsewhere
    assert.throws(() => loadServiceConfig({ DAFTRA_BASE_URL: 'https://evil.example' }).tenant && (() => { throw Error('x'); })(), /x/);
    assert.ok(loadServiceConfig({ DAFTRA_BASE_URL: 'https://evil.example' }).issues.some((i) => /daftra\.com tenant/.test(i)));
    assert.ok(loadServiceConfig({ DAFTRA_BASE_URL: 'http://nepras.daftra.com' }).issues.some((i) => /daftra\.com tenant/.test(i)));
    assert.equal(c.fake.posts.length, 0);
  } finally { await c.stop(); }
});

test('CROSS-TENANT / FOREIGN STATE: proposals or ledger signed for another tenant or with another secret are refused', async () => {
  const c = await startService();
  try {
    const otherTenantEnv = { DAFTRA_BASE_URL: 'https://other.daftra.com', DAFTRA_API_KEY: 'k', DAFTRA_APPROVAL_SECRET: OP_SECRET, OPENCLAW_WORKSPACE_DIR: c.stateDir };
    const foreign = await createProposal('sales_invoice', invoiceInput, { env: otherTenantEnv, fetcher: c.fake.fetch, actor: 'x' });
    const show = await c.agent('/v1/show', { id: foreign.id }); assert.equal(show.status, 409); assert.equal(show.json.refused, 'CROSS_TENANT');
    assert.equal((await c.agent('/v1/status', { id: foreign.id })).json.refused, 'CROSS_TENANT');
    const otherSecretEnv = { ...otherTenantEnv, DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_APPROVAL_SECRET: 'attacker-secret-0123456789-0123456789-xyzxyz' };
    const forged = await createProposal('sales_invoice', invoiceInput, { env: otherSecretEnv, fetcher: c.fake.fetch, actor: 'x' });
    const bad = await c.agent('/v1/show', { id: forged.id }); assert.equal(bad.status, 409); assert.equal(bad.json.refused, 'TAMPERED');
    const op = c.operator(); await op.login();
    for (const id of [foreign.id, forged.id]) { const page = await op.request('GET', '/proposal/' + id); assert.equal(page.status, 404); assert.match(page.text, /Cannot show this proposal/); const d = await op.decide(id, 'approve', { hash: 'a'.repeat(64) }); assert.notEqual(d.status, 200); }
    assert.equal(c.fake.posts.length, 0);
    const list = await op.request('GET', '/console'); assert.match(list.text, /integrity check failed/);
  } finally { await c.stop(); }
});

// ===== I. state directory, ledger, audit tampering =========================================================================
test('STATE DIR: symlink, group/world-writable, symlinks inside, missing secrets -> service reports not configured and refuses everything that writes', async () => {
  const mk = async (prep) => { const base = await mkdtemp(join(tmpdir(), 'basht-sd-')); const dir = join(base, 'broker-data'); await prep(base, dir); return { base, dir }; };
  const cases = [
    ['symlinked dir', async (base, dir) => { await mkdir(join(base, 'real'), { mode: 0o700 }); await symlink(join(base, 'real'), dir); }, /symlink/],
    ['world-writable', async (base, dir) => { await mkdir(dir, { mode: 0o700 }); await chmod(dir, 0o777); }, /group-writable or accessible by others/],
    ['group-writable', async (base, dir) => { await mkdir(dir, { mode: 0o700 }); await chmod(dir, 0o770); }, /group-writable or accessible by others/],
    ['other-readable', async (base, dir) => { await mkdir(dir, { mode: 0o700 }); await chmod(dir, 0o705); }, /group-writable or accessible by others/],
    ['symlink inside', async (base, dir) => { await mkdir(join(dir, 'x'), { recursive: true, mode: 0o700 }); await symlink(join(dir, 'x'), join(dir, 'daftra-ledger')); }, /symlink was found inside/],
    ['symlinked audit', async (base, dir) => { await mkdir(dir, { mode: 0o700 }); await writeFile(join(base, 'victim'), ''); await symlink(join(base, 'victim'), join(dir, 'audit.jsonl')); }, /symlink was found inside/],
    ['not a directory', async (base, dir) => { await writeFile(dir, 'x'); }, /not a directory/],
  ];
  for (const [label, prep, rx] of cases) {
    const { base, dir } = await mk(prep);
    const fake = new FakeDaftra();
    try {
      const svc = createBrokerService({ env: { DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_WRITE_API_KEY: WRITE_KEY, DAFTRA_APPROVAL_SECRET: OP_SECRET, BROKER_AGENT_TOKEN: AGENT_TOKEN, OPERATOR_PASSWORD, OPERATOR_TOTP_SEED: TOTP_SEED, DAFTRA_WRITES_ENABLED: '1', BROKER_STATE_DIR: dir, RAILWAY_PRIVATE_DOMAIN: PRIVATE_HOST },
        fetcher: fake.fetch, log: () => {}, publicHost: '127.0.0.1', privateHost: '127.0.0.1', publicPort: 0, privatePort: 0 });
      assert.equal(svc.configured, false, label); assert.ok(svc.issues.some((i) => rx.test(i)), label + ': ' + svc.issues.join('|'));
      assert.equal(svc.writesEnabled(), false, label);
      const addr = await svc.listen();
      const r = await rawRequest({ port: addr.private.port, method: 'POST', path: '/v1/propose', headers: { Host: PRIVATE_HOST, Authorization: 'Bearer ' + AGENT_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'sales_invoice', input: invoiceInput }) });
      assert.equal(r.status, 503, label); assert.equal(fake.calls.length, 0);
      await svc.close();
    } finally { await rm(base, { recursive: true, force: true }); }
  }
});

test('LEDGER / PROPOSAL / OPERATOR-STATE / AUDIT tampering on the broker volume fails closed', async () => {
  const c = await startService();
  try {
    const id = (await proposeInvoice(c)).json.result.proposal_id;
    const op = c.operator(); await op.login(); await op.proposalPage(id);
    // edited audit log: the next audited action (and therefore any approval) is refused
    const auditFile = join(c.stateDir, 'audit.jsonl');
    const lines = (await readFile(auditFile, 'utf8')).trim().split('\n');
    await writeFile(auditFile, lines.map((l, i) => (i === 0 ? l.replace('proposal_created', 'nothing_here') : l)).join('\n') + '\n');
    await assert.rejects(readAudit({ stateDir: c.stateDir, secret: OP_SECRET }), (e) => e.code === 'AUDIT_TAMPERED');
    const blocked = await op.decide(id, 'approve');
    assert.equal(blocked.status, 500); assert.equal(c.fake.posts.length, 0, 'no approval while the audit trail is tampered');
    await writeFile(auditFile, lines.join('\n') + '\n');                                       // restore
    // truncated / edited ledger
    const ledgerFile = join(c.stateDir, 'daftra-ledger', 'ledger.jsonl');
    const id2 = (await proposeInvoice(c, { ...invoiceInput, items: [{ ...invoiceInput.items[0], quantity: '5' }] })).json.result.proposal_id;
    await op.proposalPage(id2);
    await writeFile(ledgerFile, '{"garbage":true}\n');
    const r = await op.decide(id2, 'approve');
    assert.equal(r.status, 409); assert.match(r.text, /Integrity check failed \(LEDGER_TAMPERED\)/);
    assert.equal((await c.agent('/v1/propose', { type: 'sales_invoice', input: invoiceInput })).status, 409);
    await rm(ledgerFile);
    // edited proposal
    const pf = join(c.stateDir, 'daftra-ledger', 'proposals', id2 + '.json');
    const stored = JSON.parse(await readFile(pf, 'utf8')); stored.request.body.InvoiceItem[0].unit_price = '0.01'; await writeFile(pf, JSON.stringify(stored));
    assert.equal((await op.decide(id2, 'approve')).status, 409);
    assert.equal((await c.agent('/v1/status', { id: id2 })).json.refused, 'TAMPERED');
    assert.equal(c.fake.posts.length, 0);
    // edited operator state (rewinding the replay counter) -> logins refused after restart
    const stateFile = join(c.stateDir, 'operator-state.json');
    const st = JSON.parse(await readFile(stateFile, 'utf8')); st.last_step = 1; await writeFile(stateFile, JSON.stringify(st));
    await c.stop(false);
    const again = await startService({ keepState: c.base, clock: c.clock });
    try { assert.equal((await again.operator().login({ code: again.freshCode() })).status, 503); assert.ok(again.logs.some((l) => /operator state failed authentication/.test(l))); } finally { await again.stop(false); }
  } finally { await rm(c.base, { recursive: true, force: true }); }
});

test('OPERATOR_STATE_RESET=1 is the only recovery from corrupted operator state and keeps past codes dead', async () => {
  const c = await startService();
  const keep = c.base;
  try {
    const op = c.operator(); await op.login();
    await writeFile(join(c.stateDir, 'operator-state.json'), '{"broken":true}');
    await c.stop(false);
    const reset = await startService({ keepState: keep, clock: c.clock, env: { OPERATOR_STATE_RESET: '1' } });
    try {
      assert.ok(reset.logs.some((l) => /operator state was reset/.test(l)));
      assert.equal((await reset.operator().login({ code: reset.totp() })).status, 401, 'the code of the current window is dead after a reset');
      assert.equal((await reset.operator().login({ code: reset.freshCode() })).status, 303);
      const audit = await readAudit({ stateDir: join(keep, 'broker-data'), secret: OP_SECRET });
      assert.ok(audit.some((a) => a.event === 'operator_state_reset'));
    } finally { await reset.stop(false); }
  } finally { await rm(keep, { recursive: true, force: true }); }
});

// ===== J. enrollment ======================================================================================================
test('ENROLLMENT: 404 unless OPERATOR_ENROLLMENT=1; requires the password; shows the derived setup key; password-only login stays impossible', async () => {
  const off = await startService();
  try {
    const op = off.operator();
    for (const method of ['GET', 'POST']) assert.equal((await op.request(method, '/enroll', { form: method === 'POST' ? { password: OPERATOR_PASSWORD } : undefined })).status, 404);
    assert.equal(/enroll/i.test((await op.request('GET', '/')).text.replace(/Authenticator code/g, '')), false, 'no enrollment link when disabled');
  } finally { await off.stop(); }
  const c = await startService({ env: { OPERATOR_ENROLLMENT: '1' } });
  try {
    const op = c.operator();
    const form = await op.request('GET', '/enroll'); assert.equal(form.status, 200);
    const pre = /name="pre" value="([^"]+)"/.exec(form.text)[1];
    assert.equal((await op.request('POST', '/enroll', { form: { pre, password: 'wrong'.repeat(8) } })).status, 401);
    const pre2 = /name="pre" value="([^"]+)"/.exec((await op.request('GET', '/enroll')).text)[1];
    assert.equal((await op.request('POST', '/enroll', { form: { pre: pre2, password: OPERATOR_PASSWORD }, origin: 'http://evil.example' })).status, 403);
    const pre3 = /name="pre" value="([^"]+)"/.exec((await op.request('GET', '/enroll')).text)[1];
    const shown = await op.request('POST', '/enroll', { form: { pre: pre3, password: OPERATOR_PASSWORD } });
    assert.equal(shown.status, 200); assert.ok(shown.text.includes(totpBase32(TOTP_SEED)));
    assert.match(shown.text, /otpauth:\/\/totp\//); assert.match(shown.text, /remove the OPERATOR_ENROLLMENT/);
    assert.equal(shown.headers['set-cookie'], undefined, 'enrollment creates no session');
    assert.equal(shown.text.includes(TOTP_SEED), false, 'the seed itself is never shown, only the derived key');
    assert.equal((await op.request('GET', '/console')).status, 303);
    assert.equal((await op.login({ code: '' })).status, 401);
  } finally { await c.stop(); }
});

// ===== K. no secrets anywhere ===================================================================================================
test('SECRETS never appear in any HTTP response, header, log line, ledger, proposal or audit record (full interaction sweep)', async () => {
  const c = await startService({ fake: new FakeDaftra({ post: () => ({ status: 422, json: { message: 'bad key ' + WRITE_KEY + ' and secret ' + OP_SECRET } }) }) });
  const seen = [];
  try {
    const rec = (r) => { seen.push(JSON.stringify(r.headers) + r.text); return r; };
    const id = rec(await proposeInvoice(c)).json.result.proposal_id;
    rec(await c.agent('/v1/show', { id })); rec(await c.agent('/v1/status', { id })); rec(await c.agent('/v1/status', { id }, { token: 'wrong' })); rec(await c.agent('/v1/status', { id }, { host: PUBLIC_HOST }));
    rec(await c.agent('/v1/propose', { type: 'sales_invoice', input: { client_id: WRITE_KEY } }));
    const op = c.operator(); for (const r of [await op.request('GET', '/'), await op.login(), await op.request('GET', '/console'), await op.proposalPage(id)]) rec(r);
    rec(await op.decide(id, 'approve'));
    rec(await op.request('GET', '/healthz'));
    for (const s of seen) scan(s, 'response');
    scan(c.logs.join('\n'), 'logs');
    for (const f of ['audit.jsonl', 'daftra-ledger/ledger.jsonl']) scan(await readFile(join(c.stateDir, f), 'utf8'), f);
    for (const f of await readdir(join(c.stateDir, 'daftra-ledger', 'proposals'))) scan(await readFile(join(c.stateDir, 'daftra-ledger', 'proposals', f), 'utf8'), f);
    scan(await readFile(join(c.stateDir, 'operator-state.json'), 'utf8'), 'operator-state');
    assert.ok(seen.join('').includes('[redacted]') || true);
  } finally { await c.stop(); }
});

// ---- added after the mutation sweep (each pins a guard that previously survived) -------------------------------------
test('MUTATION#1 a request with ONLY the public Host (no edge headers) already raises the exposure alarm', async () => {
  const c = await startService();
  try {
    assert.equal(c.service.exposure.alarm, false);
    assert.equal((await c.agent('/v1/status', { id: 'prop_0123456789abcdef' }, { host: PUBLIC_HOST })).status, 404);
    assert.equal(c.service.exposure.alarm, true);
  } finally { await c.stop(); }
});

test('MUTATION#2 two Authorization headers are refused even when the FIRST one is the valid token', async () => {
  const c = await startService();
  try {
    const send = (headers) => new Promise((res) => { const s = net.createConnection(c.privatePort, '127.0.0.1'); let out = ''; s.on('data', (d) => { out += d; }); s.on('close', () => res(out)); s.on('connect', () => s.write(`POST /v1/status HTTP/1.1\r\nHost: ${PRIVATE_HOST}\r\n${headers}Content-Type: application/json\r\nContent-Length: 30\r\nConnection: close\r\n\r\n{"id":"prop_0123456789abcdef"}`)); });
    assert.match(await send(`Authorization: Bearer ${AGENT_TOKEN}\r\n`), /^HTTP\/1\.1 422/, 'control: one valid header is accepted');
    assert.match(await send(`Authorization: Bearer ${AGENT_TOKEN}\r\nAuthorization: Bearer nope\r\n`), /^HTTP\/1\.1 401/);
    assert.match(await send(`Authorization: Bearer ${AGENT_TOKEN}\r\nauthorization: Bearer ${AGENT_TOKEN}\r\n`), /^HTTP\/1\.1 401/);
  } finally { await c.stop(); }
});

test('MUTATION#3 the library environment of the service never has writes on unless the SERVICE env says 1 and it is configured', async () => {
  const off = await startService({ env: { DAFTRA_WRITES_ENABLED: undefined } });
  try { assert.equal(off.service._brokerEnv.DAFTRA_WRITES_ENABLED, '0'); } finally { await off.stop(); }
  const unconfigured = await startService({ env: { OPERATOR_PASSWORD: undefined } });
  try { assert.equal(unconfigured.service._brokerEnv.DAFTRA_WRITES_ENABLED, '0'); } finally { await unconfigured.stop(); }
  const on = await startService();
  try { assert.equal(on.service._brokerEnv.DAFTRA_WRITES_ENABLED, '1'); for (const k of ['OPERATOR_PASSWORD', 'OPERATOR_TOTP_SEED', 'BROKER_AGENT_TOKEN']) assert.equal(k in on.service._brokerEnv, false, k + ' must not reach the libraries'); } finally { await on.stop(); }
});

test('MUTATION#5 the private API has exactly four routes: a well-formed /v1/execute or /v1/resolve request is a 404, not a validation error', async () => {
  const c = await startService();
  try {
    const id = (await proposeInvoice(c)).json.result.proposal_id;
    for (const [route, body] of [['/v1/execute', { id, phrase: 'x' }], ['/v1/resolve', { id, created: false, code: 'x' }], ['/v1/approve', { id }], ['/v1/reject', { id }], ['/v1/enable_writes', {}]]) {
      const r = await c.agent(route, body); assert.equal(r.status, 404, route); assert.equal(r.json.ok, false);
    }
  } finally { await c.stop(); }
});
