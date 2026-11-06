// Login service logic with a FAKE browser (no Chromium, no network): gate, lockout, CSRF/origin, input validation, lifecycle, privacy of logs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLoginServer, loadLoginConfig } from './server.mjs';

const CODE = 'access-code-0123456789-0123456789-abcdef';
const MARK = 'TYPED-SECRET-MARKER-31337';
const baseEnv = { DAFTRA_BASE_URL: 'https://nepras.daftra.com', LOGIN_ENABLED: '1', LOGIN_ACCESS_CODE: CODE };

class FakeBrowser {
  constructor(over = {}) { this.calls = []; this.frame = null; this.closedWith = null; this.fl = new Set(); this.sl = new Set(); this.over = over; }
  async start() { if (this.over.failStart) throw new Error('boom'); this.calls.push(['start']); }
  async tap(x, y) { this.calls.push(['tap', x, y]); } async typeText(t) { this.calls.push(['text', t]); } async key(k) { this.calls.push(['key', k]); } async scroll(d) { this.calls.push(['scroll', d]); }
  async proof(id) { this.calls.push(['proof', id]); if (this.over.proofDelay) await new Promise((r) => setTimeout(r, this.over.proofDelay)); return { invoice_id: id, verdict: 'both_ok', browser: [], cookies: { count: 1, names: ['OISystem'] }, server: { kind: 'pdf', size: 99 } }; }
  async close(reason) { this.closedWith = reason; }
  onFrame(fn) { this.fl.add(fn); return () => this.fl.delete(fn); } onStatus(fn) { this.sl.add(fn); return () => this.sl.delete(fn); }
  latestFrame() { return this.frame; } push(b64) { this.frame = b64; for (const f of this.fl) f(b64); }
}

async function start({ env = {}, now, browsers = [], opts = {} } = {}) {
  const clock = { t: Date.UTC(2026, 10, 6, 12) }; const logs = [];
  const svc = createLoginServer({ env: { ...baseEnv, ...env }, port: 0, host: '127.0.0.1', now: now ?? (() => clock.t), log: (l) => logs.push(l),
    makeBrowser: () => { const b = new FakeBrowser(opts); browsers.push(b); return b; } });
  const addr = await svc.listen(); const base = 'http://127.0.0.1:' + addr.port; const jar = {};
  const call = async (method, path, { json, form, headers = {}, origin = base, cookie = true } = {}) => {
    const h = { ...(origin ? { Origin: origin } : {}), ...(cookie && jar.cookie ? { Cookie: jar.cookie } : {}), ...headers };
    let body; if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); } if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const r = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) jar.cookie = sc.split(';')[0];
    return { status: r.status, text: await r.text(), headers: r.headers, setCookie: sc };
  };
  const login = async () => { const r = await call('POST', '/start', { form: { code: CODE } }); const app = await call('GET', '/app'); return { r, csrf: /data-csrf="([a-f0-9]+)"/.exec(app.text)?.[1], app }; };
  return { svc, logs, clock, base, call, login, browsers, jar, stop: () => svc.close() };
}

test('dark by default: without LOGIN_ENABLED, a strong code and a *.daftra.com tenant the service answers health only', async () => {
  for (const env of [{ LOGIN_ENABLED: undefined }, { LOGIN_ACCESS_CODE: 'short' }, { DAFTRA_BASE_URL: 'https://evil.example/' }, { DAFTRA_BASE_URL: undefined }]) {
    const c = await start({ env });
    try {
      assert.equal(c.svc.configured, false, JSON.stringify(env));
      assert.equal((await c.call('GET', '/healthz')).status, 200);
      for (const [m, p] of [['GET', '/'], ['POST', '/start'], ['GET', '/app'], ['GET', '/events']]) assert.equal((await c.call(m, p, { form: m === 'POST' ? { code: CODE } : undefined })).status, 404, m + p);
      assert.equal(c.browsers.length, 0, 'no browser is ever started');
    } finally { await c.stop(); }
  }
  assert.deepEqual(loadLoginConfig({}).issues.length > 0, true);
});

test('access code gate: wrong code 401, five failures lock the door for 15 minutes (even the right code), then it opens again', async () => {
  const c = await start();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await c.call('POST', '/start', { form: { code: 'nope' + i } })).status, 401);
    assert.equal((await c.call('POST', '/start', { form: { code: CODE } })).status, 429, 'locked');
    assert.equal(c.browsers.length, 0);
    c.clock.t += 14 * 60_000; assert.equal((await c.call('POST', '/start', { form: { code: CODE } })).status, 429);
    c.clock.t += 2 * 60_000;
    const ok = await c.call('POST', '/start', { form: { code: CODE } });
    assert.equal(ok.status, 303); assert.equal(c.browsers.length, 1);
    assert.match(ok.setCookie, /^__Host-lsess=[a-f0-9]{64}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  } finally { await c.stop(); }
});

test('/start needs a same-origin form POST; the page never contains the access code; pages carry strict headers and a matching CSP nonce', async () => {
  const c = await start();
  try {
    assert.equal((await c.call('POST', '/start', { form: { code: CODE }, origin: 'https://evil.example' })).status, 403);
    assert.equal((await c.call('POST', '/start', { form: { code: CODE }, origin: null })).status, 403);
    assert.equal((await c.call('POST', '/start', { json: { code: CODE } })).status, 415);
    const home = await c.call('GET', '/');
    assert.equal(home.status, 200); assert.equal(home.text.includes(CODE), false); assert.doesNotMatch(home.text, /<script/i);
    assert.match(home.headers.get('content-security-policy'), /default-src 'none'/);
    const { r, csrf, app } = await c.login();
    assert.equal(r.status, 303); assert.ok(csrf);
    assert.equal(app.text.includes(CODE), false);
    const csp = app.headers.get('content-security-policy'); const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
    assert.ok(app.text.includes('<script nonce="' + nonce + '">')); assert.equal((app.text.match(/<script/g) ?? []).length, 1, 'exactly one script');
    assert.match(csp, /connect-src 'self'/); assert.match(csp, /img-src data:/); assert.match(csp, /frame-ancestors 'none'/); assert.doesNotMatch(csp, /unsafe-eval|\*/);
    assert.doesNotMatch(app.text, /https?:\/\/(?!nepras)/, 'no third-party resource');
    assert.equal(app.headers.get('cache-control'), 'no-store'); assert.equal(app.headers.get('referrer-policy'), 'no-referrer'); assert.equal(app.headers.get('x-frame-options'), 'DENY');
  } finally { await c.stop(); }
});

test('inputs: session cookie + same origin + CSRF are all required; shapes are validated; typed text goes ONLY to the browser', async () => {
  const c = await start();
  try {
    const { csrf } = await c.login(); const b = c.browsers[0];
    const post = (json, o = {}) => c.call('POST', '/input', { json, headers: { 'x-csrf': csrf }, ...o });
    assert.equal((await c.call('POST', '/input', { json: { type: 'key', key: 'Enter' } })).status, 403, 'no csrf');
    assert.equal((await post({ type: 'key', key: 'Enter' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await c.call('POST', '/input', { json: { type: 'key', key: 'Enter' }, headers: { 'x-csrf': 'wrong' } })).status, 403);
    assert.equal((await c.call('POST', '/input', { json: { type: 'key', key: 'Enter' }, headers: { 'x-csrf': csrf }, cookie: false })).status, 401);
    for (const bad of [{ type: 'tap', fx: 2, fy: 0.5 }, { type: 'tap', fx: -0.1, fy: 0 }, { type: 'tap', fx: 'a', fy: 0 }, { type: 'text', text: '' }, { type: 'text', text: 'x'.repeat(129) },
      { type: 'text', text: 'a\nb' }, { type: 'text', text: 'a\u0000' }, { type: 'text', text: 5 }, { type: 'key', key: 'Escape' }, { type: 'key', key: 'F12' }, { type: 'scroll', dir: 'left' }, { type: 'eval', code: '1' }, {}]) {
      assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await c.call('POST', '/input', { headers: { 'x-csrf': csrf, 'content-type': 'text/plain' }, form: undefined })).status, 415);
    assert.equal(b.calls.length, 1, 'only start() reached the browser: nothing invalid was forwarded');
    assert.equal((await post({ type: 'tap', fx: 0.5, fy: 0.25 })).status, 200);
    assert.equal((await post({ type: 'text', text: MARK })).status, 200);
    assert.equal((await post({ type: 'key', key: 'Tab' })).status, 200);
    assert.equal((await post({ type: 'scroll', dir: 'down' })).status, 200);
    assert.deepEqual(b.calls.slice(1), [['tap', 0.5, 0.25], ['text', MARK], ['key', 'Tab'], ['scroll', 'down']]);
    // flood limit
    let limited = 0; for (let i = 0; i < 40; i++) if ((await post({ type: 'key', key: 'Tab' })).status === 429) limited++;
    assert.ok(limited > 0, 'per-session rate limit');
    // privacy: the typed marker is nowhere in the service log, which only knows the KIND of input
    const logText = c.logs.join('\n');
    for (const leak of [MARK, CODE, csrf, c.jar.cookie.split('=')[1]]) assert.equal(logText.includes(leak), false, 'log leaks ' + leak.slice(0, 8));
    assert.ok(c.logs.every((l) => /"svc":"basht-login"/.test(l)));
    assert.ok(c.logs.some((l) => /"evt":"input","kind":"text"/.test(l)));
  } finally { await c.stop(); }
});

test('a second start replaces the first session (one browser at a time) and the old cookie stops working', async () => {
  const c = await start();
  try {
    const first = await c.login(); const oldCookie = c.jar.cookie;
    await c.call('POST', '/start', { form: { code: CODE } });
    assert.equal(c.browsers.length, 2); assert.equal(c.browsers[0].closedWith, 'replaced');
    assert.notEqual(c.jar.cookie, oldCookie);
    const stale = await c.call('POST', '/input', { json: { type: 'key', key: 'Tab' }, headers: { 'x-csrf': first.csrf, Cookie: oldCookie }, cookie: false });
    assert.equal(stale.status, 401);
  } finally { await c.stop(); }
});

test('lifecycle: idle (5 min) and maximum lifetime close the browser; finish deletes it; start failures clean up and show a generic error', async () => {
  const c = await start({ env: { LOGIN_MAX_MINUTES: '10' } });
  try {
    const { csrf } = await c.login(); const b = c.browsers[0];
    c.clock.t += 4 * 60_000; await c.svc._tick(); assert.equal(b.closedWith, null);
    await c.call('POST', '/input', { json: { type: 'key', key: 'Tab' }, headers: { 'x-csrf': csrf } });   // activity resets idle
    c.clock.t += 4 * 60_000; await c.svc._tick(); assert.equal(b.closedWith, null);
    c.clock.t += 2 * 60_000 + 1; await c.svc._tick(); assert.equal(b.closedWith, 'max_lifetime', 'more than 10 min since the start');
    assert.equal(c.svc._current(), null);
    assert.equal((await c.call('GET', '/app')).status, 303);
    const l2 = await c.login(); const b2 = c.browsers[1];
    c.clock.t += 5 * 60_000 + 1; await c.svc._tick(); assert.equal(b2.closedWith, 'idle');
    const l3 = await c.login(); const b3 = c.browsers[2];
    assert.equal((await c.call('POST', '/finish', { json: {}, headers: { 'x-csrf': l3.csrf } })).status, 200); assert.equal(b3.closedWith, 'finished');
    assert.equal((await c.call('POST', '/finish', { json: {}, headers: { 'x-csrf': l3.csrf } })).status, 401);
    void l2;
  } finally { await c.stop(); }
  const f = await start({ opts: { failStart: true } });
  try {
    const r = await f.call('POST', '/start', { form: { code: CODE } });
    assert.equal(r.status, 503); assert.doesNotMatch(r.text, /boom/); assert.equal(f.browsers[0].closedWith, 'start_failed'); assert.equal(f.svc._current(), null);
  } finally { await f.stop(); }
});

test('SSE: frames are pushed (latest one replayed on connect), heartbeats do not count as activity, closing sends "closed"', async () => {
  const c = await start({ env: { LOGIN_MAX_MINUTES: '10' } });
  try {
    const { csrf } = await c.login(); const b = c.browsers[0]; b.push('FIRSTFRAME');
    const events = []; const done = new Promise((ok) => {
      const req = http.get(c.base + '/events', { headers: { Cookie: c.jar.cookie } }, (res) => {
        assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8'); res.setEncoding('utf8'); let buf = '';
        res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n\n')) >= 0) { events.push(buf.slice(0, i)); buf = buf.slice(i + 2); } });
        res.on('end', ok);
      }); req.on('error', ok);
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(events.includes('event: frame\ndata: FIRSTFRAME'), 'latest frame replayed');
    const noCookie = await c.call('GET', '/events', { cookie: false }); assert.equal(noCookie.status, 401);
    await c.call('POST', '/finish', { json: {}, headers: { 'x-csrf': csrf } });
    await done;
    assert.ok(events.some((e) => e.startsWith('event: closed')));
  } finally { await c.stop(); }
});

test('proof: validated id, one at a time, metadata-only result, only the verdict is logged', async () => {
  const c = await start({ opts: { proofDelay: 200 } });
  try {
    const { csrf } = await c.login(); const b = c.browsers[0];
    const proof = (id) => c.call('POST', '/proof', { json: { invoice_id: id }, headers: { 'x-csrf': csrf } });
    for (const bad of ['0', '../1', '1.pdf', 'abc', '', '1234567890123456', null, {}, [1]]) assert.equal((await proof(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await c.call('POST', '/proof', { json: { invoice_id: '97900' } })).status, 403);
    const [first, second] = await Promise.all([proof('97900'), new Promise((r) => setTimeout(r, 50)).then(() => proof(97900))]);
    assert.equal(first.status, 200); assert.equal(JSON.parse(first.text).verdict, 'both_ok');
    assert.equal(second.status, 409, 'busy while another proof runs');
    assert.deepEqual(b.calls.filter((x) => x[0] === 'proof'), [['proof', '97900']]);
    assert.ok(c.logs.some((l) => /"evt":"proof","verdict":"both_ok"/.test(l)));
  } finally { await c.stop(); }
});
