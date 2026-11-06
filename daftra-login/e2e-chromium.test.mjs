// REAL Chromium end to end against a fake HTTPS "Daftra" (no real Daftra, no real credentials, no internet):
// iPhone-style flow = start with access code -> see the remote page -> tap + type e-mail and OTP -> signed in -> proof of the official PDF.
// Skips (with a reason) when Chromium or openssl is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { createLoginServer } from './server.mjs';
import { createLoginBrowser, launchChromium, VIEWPORT } from './browser.mjs';
import { findChromium } from '../skills/basht-daftra/scripts/daftra-pdf.mjs';
import { startFakeDaftra, haveOpenssl, EMAIL, OTP } from './fake-daftra.test-helper.mjs';

const CODE = 'access-code-0123456789-0123456789-abcdef';
const chromium = findChromium(process.env);
const skip = !chromium ? 'Chromium not installed' : undefined;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = await Promise.resolve().then(fn).catch(() => false); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await sleep(100); }
}


// Node-side stand-in for "the internet": the fake Daftra answers for nepras.daftra.com on a local port (self-signed certificate).
function localFetch(port, url, o = {}) {
  const u = new URL(String(url));
  return new Promise((ok, fail) => {
    const req = https.request({ host: '127.0.0.1', port, path: u.pathname + u.search, method: o.method ?? 'GET', headers: { ...o.headers, Host: u.hostname }, servername: u.hostname, rejectUnauthorized: false }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d));
      res.on('end', () => ok(new Response([301, 302, 303, 307, 308].includes(res.statusCode) ? null : Buffer.concat(chunks), { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).filter(([, v]) => typeof v === 'string')) })));
    });
    req.on('error', fail); req.end();
  });
}

async function setup() {
  if (!(await haveOpenssl())) return null;
  const fake = await startFakeDaftra();
  const logs = [];
  const env = { ...process.env, DAFTRA_BASE_URL: 'https://nepras.daftra.com', LOGIN_ENABLED: '1', LOGIN_ACCESS_CODE: CODE, LOGIN_CHROMIUM_NO_SANDBOX: '1' };
  const svc = createLoginServer({
    env, port: 0, host: '127.0.0.1', log: (l) => logs.push(l),
    makeBrowser: ({ policy, env: e, log }) => createLoginBrowser({
      launch: () => launchChromium({ env: e, policy, noSandbox: true, testMap: fake.testMap, extraArgs: ['--ignore-certificate-errors'] }), policy, env: e, log,
      fetcher: (u, o = {}) => localFetch(fake.port, u, o) }),
  });
  const addr = await svc.listen();
  const base = 'http://127.0.0.1:' + addr.port;
  const jar = {};
  const call = async (method, path, { json, form, headers = {} } = {}) => {
    const h = { Origin: base, ...(jar.cookie ? { Cookie: jar.cookie } : {}), ...headers };
    let body;
    if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const r = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) jar.cookie = sc.split(';')[0];
    return { status: r.status, text: await r.text(), headers: r.headers };
  };
  return { fake, svc, logs, base, call, jar, stop: async () => { await svc.close(); await fake.stop(); } };
}

test('iPhone flow with real Chromium: sign in by tap + typing, then the official-PDF proof; writes are blocked; nothing sensitive is logged', { skip, timeout: 120000 }, async (t) => {
  const ctx = await setup();
  if (!ctx) return t.skip('openssl not installed');
  try {
    // --- gate ---
    assert.equal((await ctx.call('POST', '/start', { form: { code: 'wrong' } })).status, 401);
    const started = await ctx.call('POST', '/start', { form: { code: CODE } });
    assert.equal(started.status, 303); assert.equal(started.headers.get('location'), '/app');
    const app = await ctx.call('GET', '/app');
    assert.equal(app.status, 200);
    const csrf = /data-csrf="([a-f0-9]+)"/.exec(app.text)[1];
    const act = (json) => ctx.call('POST', '/input', { json, headers: { 'x-csrf': csrf } });

    // --- the remote page is streamed as JPEG frames over SSE ---
    const frames = [];
    const sse = http.get(ctx.base + '/events', { headers: { Cookie: ctx.jar.cookie } }, (res) => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); const m = /^event: frame\ndata: (.+)$/s.exec(ev); if (m) frames.push(m[1]); } });
    });
    try {
      const browser = ctx.svc._current().browser;
      await waitFor(() => browser._evaluate('!!document.querySelector("#email")'), 'login page');
      await waitFor(() => frames.length > 0, 'first frame');
      assert.ok(frames[0].startsWith('/9j/'), 'a base64 JPEG');

      const rect = async (sel) => JSON.parse(await browser._evaluate(`JSON.stringify(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect())`));
      const tapOn = async (sel) => { const r = await rect(sel); assert.equal((await act({ type: 'tap', fx: (r.x + r.width / 2) / VIEWPORT.width, fy: (r.y + r.height / 2) / VIEWPORT.height })).status, 200); };

      // --- e-mail, then OTP, typed by the "operator" ---
      await tapOn('#email'); assert.equal((await act({ type: 'text', text: EMAIL })).status, 200);
      await waitFor(() => browser._evaluate('document.querySelector("#email").value').then((v) => v === EMAIL), 'typed e-mail');
      await tapOn('#next');
      await waitFor(() => browser._evaluate('getComputedStyle(document.querySelector("#step2")).display === "block"'), 'otp step');
      await tapOn('#otp'); assert.equal((await act({ type: 'text', text: OTP })).status, 200);
      await tapOn('#verify');
      await waitFor(() => ctx.fake.state.logins === 1 && browser._evaluate('location.host === "nepras.daftra.com" && location.pathname === "/owner/dashboard"'), 'signed-in dashboard');
      assert.equal(ctx.fake.state.email, EMAIL); assert.equal(ctx.fake.state.otp, OTP, 'the fake Daftra (the real destination) received what was typed');

      // --- the dashboard tried to write: none of it got through ---
      await sleep(500);
      assert.equal(ctx.fake.state.writes, 0, 'POST /owner/invoices/add was blocked');
      assert.equal(ctx.fake.state.deletes, 0, 'GET /owner/invoices/delete/1 was blocked');
      assert.equal(ctx.fake.state.apiWrites, 0, 'POST /api2 was blocked');
      assert.ok(browser.blockedCount >= 3, 'blocked: ' + browser.blockedCount);

      // --- THE PROOF ---
      const proof = await ctx.call('POST', '/proof', { json: { invoice_id: '97900' }, headers: { 'x-csrf': csrf } });
      assert.equal(proof.status, 200);
      const r = JSON.parse(proof.text);
      assert.equal(r.verdict, 'both_ok');
      assert.equal(r.browser[0].pdf_magic, true); assert.equal(r.browser[0].has_eof, true); assert.equal(r.browser[0].content_type, 'application/pdf');
      assert.equal(r.server.kind, 'pdf'); assert.ok(r.server.size > 20);
      assert.deepEqual(r.cookies.names, ['OISystem']);
      assert.equal(r.cookies.count, 1);
      // the server-side GET used the same User-Agent as the browser (sessions can be bound to it) and the fixed owner path
      const reqs = ctx.fake.state.pdfRequests;
      assert.ok(reqs.length >= 2);
      const serverReq = reqs[reqs.length - 1];
      assert.equal(serverReq.owner, true); assert.ok(!/HeadlessChrome/.test(serverReq.ua), serverReq.ua); assert.equal(serverReq.ua, reqs[0].ua);
      // the proof result carries metadata only
      const sessionValue = [...ctx.fake.state.sessions][0];
      for (const leak of [sessionValue, EMAIL, OTP, CODE, '%PDF', 'https://', 'OISystem=']) assert.equal(proof.text.includes(leak), false, 'result leaks: ' + leak);

      // --- privacy of the service's own log ---
      const logText = ctx.logs.join('\n');
      for (const leak of [EMAIL, OTP, CODE, sessionValue, 'operator@', 'evil.example/pixel']) assert.equal(logText.includes(leak), false, 'log leaks: ' + leak);
      assert.ok(ctx.logs.some((l) => /"evt":"request_blocked"/.test(l)));
      assert.ok(ctx.logs.some((l) => /"evt":"input"/.test(l)));
    } finally { sse.destroy(); }

    // --- finish: browser gone, session dead ---
    assert.equal((await ctx.call('POST', '/finish', { json: {}, headers: { 'x-csrf': csrf } })).status, 200);
    assert.equal(ctx.svc._current(), null);
    assert.equal((await ctx.call('POST', '/input', { json: { type: 'key', key: 'Enter' }, headers: { 'x-csrf': csrf } })).status, 401);
  } finally { await ctx.stop(); }
});

test('before signing in the proof says so (not_signed_in) and exports nothing', { skip, timeout: 90000 }, async (t) => {
  const ctx = await setup();
  if (!ctx) return t.skip('openssl not installed');
  try {
    await ctx.call('POST', '/start', { form: { code: CODE } });
    const csrf = /data-csrf="([a-f0-9]+)"/.exec((await ctx.call('GET', '/app')).text)[1];
    const r = JSON.parse((await ctx.call('POST', '/proof', { json: { invoice_id: 97900 }, headers: { 'x-csrf': csrf } })).text);
    assert.equal(r.verdict, 'not_signed_in');
    assert.equal(r.cookies.count, 0); assert.equal(r.server.kind, 'skipped');
    assert.equal(r.browser[0].final_is_root, true); assert.equal(ctx.fake.state.pdfRequests.length, 0);
  } finally { await ctx.stop(); }
});
