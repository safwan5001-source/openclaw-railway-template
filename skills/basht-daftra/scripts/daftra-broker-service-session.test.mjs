// End to end: operator pastes ONE Daftra session in the console -> the agent asks for invoice 97900 (a draft) -> official PDF.
// Real HTTP on loopback, scripted operator (password + TOTP + CSRF), fake Daftra. The session is never visible to the agent,
// the logs, the audit chain or any page; nothing is ever written to Daftra.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeDaftra } from './daftra-fake.test-helper.mjs';
import { startService, ALL_SECRETS, OP_SECRET, rawRequest } from './daftra-broker-service.test-helper.mjs';
import { readAudit } from './daftra-broker-service.mjs';
import { downloadInvoicePdfViaBroker } from './daftra-broker-service-client.mjs';

const COOKIE_VALUE = 'abc123DEF456ghi789JKL012mno345';
const COOKIE_VALUE_2 = 'zzz999YYY888xxx777WWW666vvv555';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

// Fake Daftra + a scripted "session PDF" page: valid cookie => PDF, any other cookie => redirect to the login route.
function sessionFake() {
  const fake = new FakeDaftra({ records: { invoices: { 97900: { id: 97900, draft: 1 }, 97407: { id: 97407, draft: 0 } } } });
  fake.pdfCalls = []; fake.validCookie = COOKIE_VALUE;
  const base = fake.fetch;
  fake.fetch = async (url, options = {}) => {
    if (url.pathname.startsWith('/api2/')) return base(url, options);
    fake.pdfCalls.push({ method: options.method ?? 'GET', host: url.hostname, path: url.pathname, headers: options.headers });
    const cookie = options.headers?.Cookie ?? '';
    const m = /^\/owner\/invoices\/view\/(\d+)\.pdf$/.exec(url.pathname);
    if (m && cookie.includes('OISystem=' + fake.validCookie)) return new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
    return new Response('', { status: 302, headers: { location: '/users/login' } });
  };
  return fake;
}
const csrfOf = (text) => /name="csrf" value="([^"]+)"/.exec(text)?.[1];
async function connect(ctx, op, cookie = 'OISystem=' + COOKIE_VALUE) {
  const page = await op.request('GET', '/console/daftra-session');
  return op.request('POST', '/console/daftra-session', { form: { csrf: csrfOf(page.text), cookie, code: ctx.freshCode() } });
}
const pdfFor = (ctx, id) => ctx.agent('/v1/invoice_pdf', { id }).then((r) => r.json);

test('full flow: connect once in the console, then BASHT gets the official PDF of a DRAFT; the cookie never appears anywhere', async () => {
  const fake = sessionFake(); const ctx = await startService({ fake });
  try {
    const op = ctx.operator(); assert.equal((await op.login()).status, 303);
    const before = await op.request('GET', '/console/daftra-session');
    assert.equal(before.status, 200); assert.match(before.text, /not_connected/);
    assert.match((await op.request('GET', '/console')).text, /href="\/console\/daftra-session"/);

    // not connected yet: the agent is told exactly what to do (the invoice has no hash link in this fake)
    const none = await pdfFor(ctx, 97900);
    assert.equal(none.result.status, 422); assert.match(none.result.message, /Connect your Daftra session in the operator console/);
    assert.equal(fake.pdfCalls.length, 0);

    const saved = await connect(ctx, op);
    assert.equal(saved.status, 200); assert.match(saved.text, /Session saved/); assert.match(saved.text, /connected/);
    for (const r of [saved, await op.request('GET', '/console/daftra-session'), await op.request('GET', '/console')]) assert.equal(r.text.includes(COOKIE_VALUE), false, 'the console never shows the cookie');

    const got = await pdfFor(ctx, 97900);
    assert.equal(got.ok, true); assert.equal(got.result.status, 200);
    assert.equal(Buffer.from(got.result.base64, 'base64').equals(PDF), true);
    assert.equal(got.result.draft, true); assert.equal(got.result.source, 'daftra_session');
    assert.equal((await pdfFor(ctx, 97407)).result.draft, false, 'issued invoices use the same path');

    // what Daftra saw: GET only, tenant only, the cookie, nothing else
    assert.ok(fake.pdfCalls.length >= 2);
    for (const c of fake.pdfCalls) {
      assert.equal(c.method, 'GET'); assert.equal(c.host, 'nepras.daftra.com');
      assert.deepEqual(Object.keys(c.headers).map((h) => h.toLowerCase()).sort(), ['accept', 'cookie', 'user-agent']);
      assert.equal(c.headers.Cookie, 'OISystem=' + COOKIE_VALUE);
    }
    assert.equal(fake.posts.length, 0, 'nothing was ever written to Daftra');
    assert.deepEqual([...new Set(fake.calls.map((c) => c.method))], ['GET']);

    // the page now shows a successful use, still without the cookie
    const after = await op.request('GET', '/console/daftra-session');
    assert.match(after.text, /Last successful PDF/); assert.equal(after.text.includes(COOKIE_VALUE), false);

    // nowhere to be found: not in the logs, not in the audit chain, not in the state directory in clear text
    assert.equal(JSON.stringify(ctx.logs).includes(COOKIE_VALUE), false);
    const audit = await readAudit({ stateDir: ctx.stateDir, secret: OP_SECRET });
    assert.ok(audit.some((e) => e.event === 'operator_daftra_session_save' && e.cookies === 1));
    assert.equal(JSON.stringify(audit).includes(COOKIE_VALUE), false);
    for (const name of await readdir(ctx.stateDir)) {
      const st = await stat(join(ctx.stateDir, name));
      if (st.isFile()) assert.equal((await readFile(join(ctx.stateDir, name), 'utf8')).includes(COOKIE_VALUE), false, name);
    }
    assert.equal(((await stat(join(ctx.stateDir, 'daftra-session.json'))).mode & 0o777), 0o600);
    for (const s of ALL_SECRETS) assert.equal(JSON.stringify(got).includes(s), false);
    assert.equal(JSON.stringify(got).includes(COOKIE_VALUE), false, 'the agent never sees the cookie');
  } finally { await ctx.stop(); }
});

test('saving needs the signed-in operator, CSRF, same origin and a FRESH authenticator code; bad input saves nothing', async () => {
  const fake = sessionFake(); const ctx = await startService({ fake });
  try {
    const anon = ctx.operator();
    assert.equal((await anon.request('GET', '/console/daftra-session')).status, 303);
    assert.equal((await anon.request('POST', '/console/daftra-session', { form: { csrf: 'x', cookie: COOKIE_VALUE, code: '123456' } })).status, 303);

    const loginCode = ctx.totp();
    const op = ctx.operator(); await op.login({ code: loginCode });
    const page = await op.request('GET', '/console/daftra-session'); const csrf = csrfOf(page.text);
    const post = (form, o = {}) => op.request('POST', '/console/daftra-session', { form, ...o });
    assert.equal((await post({ csrf: 'wrong', cookie: COOKIE_VALUE, code: ctx.freshCode() })).status, 403);
    assert.equal((await post({ csrf, cookie: COOKIE_VALUE, code: ctx.freshCode() }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ cookie: COOKIE_VALUE, code: ctx.freshCode() })).status, 403, 'no csrf');
    assert.equal((await post({ csrf, cookie: COOKIE_VALUE, code: '000000' })).status, 401, 'wrong code');
    assert.equal((await post({ csrf, cookie: COOKIE_VALUE, code: loginCode })).status, 401, 'the code used to sign in cannot be replayed');
    const bad = await post({ csrf, cookie: 'has space; and,comma', code: ctx.freshCode() });
    assert.equal(bad.status, 200); assert.match(bad.text, /class="bad"/);
    assert.equal(bad.text.includes('has space'), false, 'invalid input is not echoed');
    await assert.rejects(stat(join(ctx.stateDir, 'daftra-session.json')), 'nothing was saved by any rejected request');
    assert.equal((await post({ csrf, cookie: COOKIE_VALUE, code: ctx.freshCode() })).status, 200);
    await stat(join(ctx.stateDir, 'daftra-session.json'));
    // GET with other methods
    assert.equal((await op.request('PUT', '/console/daftra-session')).status, 405);
  } finally { await ctx.stop(); }
});

test('the agent cannot connect, read, change or clear the session: no private-API route, no console access', async () => {
  const fake = sessionFake(); const ctx = await startService({ fake });
  try {
    for (const route of ['/v1/daftra_session', '/v1/session', '/v1/daftra-session', '/console/daftra-session']) {
      const r = await ctx.agent(route, { cookie: COOKIE_VALUE });
      assert.ok([404, 400, 405].includes(r.status), route + ' -> ' + r.status);
    }
    const viaPublic = await rawRequest({ port: ctx.publicPort, method: 'GET', path: '/console/daftra-session', headers: { Host: '127.0.0.1:' + ctx.publicPort, Authorization: 'Bearer ' + 'agent-token-0123456789-0123456789-0123456789' } });
    assert.equal(viaPublic.status, 303, 'an agent token does not open the console');
    await assert.rejects(stat(join(ctx.stateDir, 'daftra-session.json')));
  } finally { await ctx.stop(); }
});

test('an expired Daftra session is detected, reported to the agent with a clear instruction, stops being sent, and re-connecting fixes it', async () => {
  const fake = sessionFake(); const ctx = await startService({ fake });
  try {
    const op = ctx.operator(); await op.login();
    await connect(ctx, op);
    assert.equal((await pdfFor(ctx, 97900)).result.status, 200);

    fake.validCookie = 'something-else-now';                // Daftra signed the operator out
    const r = (await pdfFor(ctx, 97900)).result;
    assert.equal(r.status, 502); assert.equal(r.session, 'expired');
    assert.match(r.message, /session expired or rejected \[HTTP 302, 1 redirect\(s\), page=login\]: reconnect it in the operator console/);
    assert.equal(JSON.stringify(r).includes(COOKIE_VALUE), false);
    assert.match((await op.request('GET', '/console/daftra-session')).text, /expired/);
    const audit = await readAudit({ stateDir: ctx.stateDir, secret: OP_SECRET });
    assert.ok(audit.some((e) => e.event === 'daftra_session_expired'));

    const callsBefore = fake.pdfCalls.length;
    const again = (await pdfFor(ctx, 97900)).result;
    assert.equal(again.status, 422); assert.match(again.message, /Connect your Daftra session/);
    assert.equal(fake.pdfCalls.length, callsBefore, 'an expired cookie is not sent again');

    fake.validCookie = COOKIE_VALUE_2;
    await connect(ctx, op, 'OISystem=' + COOKIE_VALUE_2);
    assert.equal((await pdfFor(ctx, 97900)).result.status, 200);
    assert.equal(fake.posts.length, 0);
    assert.equal(JSON.stringify(ctx.logs).includes(COOKIE_VALUE_2), false);
  } finally { await ctx.stop(); }
});

test('disconnect deletes the stored session; it survives a service restart until then', async () => {
  const fake = sessionFake(); const ctx = await startService({ fake });
  const keep = ctx.base;
  try {
    const op = ctx.operator(); await op.login(); await connect(ctx, op);
    await ctx.service.close();
    const ctx2 = await startService({ fake, keepState: keep });
    try {
      assert.equal((await pdfFor(ctx2, 97900)).result.status, 200, 'the session survives a restart');
      ctx2.clock.t += 10 * 60_000;                 // later than any authenticator step the first run used (replay protection persists)
      const op2 = ctx2.operator(); await op2.login({ code: ctx2.totp() });
      const page = await op2.request('GET', '/console/daftra-session');
      const cleared = await op2.request('POST', '/console/daftra-session/clear', { form: { csrf: csrfOf(page.text) } });
      assert.equal(cleared.status, 200); assert.match(cleared.text, /deleted/);
      await assert.rejects(stat(join(ctx2.stateDir, 'daftra-session.json')));
      assert.equal((await pdfFor(ctx2, 97900)).result.status, 422);
      assert.equal((await op2.request('POST', '/console/daftra-session/clear', { form: { csrf: 'bad' } })).status, 403);
    } finally { await ctx2.service.close(); }
  } finally { const { rm } = await import('node:fs/promises'); await rm(keep, { recursive: true, force: true }); }
});

test('BASHT client: "get invoice 97900" ends as a saved official PDF (via: daftra_session); a not-connected broker yields an actionable message', async () => {
  const fake = sessionFake(); const ctx = await startService({ fake });
  const { mkdtemp, rm, readFile: rf } = await import('node:fs/promises'); const { tmpdir } = await import('node:os');
  const out = await mkdtemp(join(tmpdir(), 'basht-client-'));
  try {
    const route = async (url, o) => {                       // forwards the client's HTTP call to the private listener of the test service
      const u = new URL(String(url));
      const r = await rawRequest({ port: ctx.privatePort, method: o.method, path: u.pathname, headers: { ...o.headers, Host: 'basht-broker.railway.internal' }, rawBody: o.body });
      return new Response(r.text, { status: r.status, headers: { 'content-type': 'application/json' } });
    };
    const target = { url: 'http://basht-broker.railway.internal:8081', token: 'agent-token-0123456789-0123456789-0123456789', fetcher: route };
    await assert.rejects(downloadInvoicePdfViaBroker({ id: '97900', outPath: join(out, 'a.pdf'), ...target }), /Connect your Daftra session in the operator console/);
    const op = ctx.operator(); await op.login(); await connect(ctx, op);
    const r = await downloadInvoicePdfViaBroker({ id: '97900', outPath: join(out, 'b.pdf'), ...target });
    assert.deepEqual({ source: r.source, via: r.via, draft: r.draft, size: r.size }, { source: 'daftra_official', via: 'daftra_session', draft: true, size: PDF.length });
    assert.equal((await rf(join(out, 'b.pdf'))).equals(PDF), true);
  } finally { await rm(out, { recursive: true, force: true }); await ctx.stop(); }
});
