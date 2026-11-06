#!/usr/bin/env node
// BASHT Daftra LOGIN BROWSER (experimental, separate Railway service, NOT part of the broker or OpenClaw images).
//
// Lets the operator sign in to Daftra from Safari on the iPhone: a short-lived isolated Chromium is streamed as images, taps and typed text go
// back to it. The operator types the e-mail / OTP themselves. After signing in, "test PDF" proves whether the authorized session can download
// the OFFICIAL invoice PDF, and reports only metadata. Phase 1 holds the session in memory only; nothing is sent to the broker yet.
//
// Hard limits: one session at a time, <= LOGIN_MAX_MINUTES, idle timeout, access-code gate with lockout, no persistence, no API key,
// no logging of typed text / cookies / URLs, tenant writes blocked at the network layer (policy.mjs).
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { createPolicy, parseHostList } from './policy.mjs';
import { createLoginBrowser, launchChromium } from './browser.mjs';
import { tenantBase } from '../skills/basht-daftra/scripts/daftra-readonly.mjs';
import { startPage, appPage } from './ui.mjs';

const EVENTS = new Set(['server_started', 'login_attempt_failed', 'login_locked', 'session_started', 'session_start_failed', 'session_closed', 'input', 'proof', 'browser_started', 'browser_closed', 'request_blocked', 'unconfigured']);
const SECURITY_HEADERS = Object.freeze({
  'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
});
const PLAIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const sha = (s) => createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => timingSafeEqual(sha(a), sha(b));

export function loadLoginConfig(env = process.env) {
  const issues = [];
  let tenantHost = '';
  try { tenantHost = tenantBase(env).hostname; } catch (e) { issues.push(e.message); }
  const accessCode = typeof env.LOGIN_ACCESS_CODE === 'string' ? env.LOGIN_ACCESS_CODE : '';
  if (accessCode.length < 32) issues.push('LOGIN_ACCESS_CODE must be at least 32 characters');
  if (env.LOGIN_ENABLED !== '1') issues.push('LOGIN_ENABLED is not 1 (the service stays dark until the operator turns it on)');
  const maxMinutes = Math.min(20, Math.max(2, Number(env.LOGIN_MAX_MINUTES) || 10));
  return { issues, tenantHost, accessCode, maxMs: maxMinutes * 60_000, idleMs: 5 * 60_000, maxMinutes, loginHosts: [...parseHostList(env.LOGIN_EXTRA_HOSTS)] };
}

export function createLoginServer(options = {}) {
  const env = { ...(options.env ?? process.env) };
  const now = options.now ?? Date.now;
  const cfg = loadLoginConfig(env);
  const configured = cfg.issues.length === 0;
  const policy = configured ? createPolicy({ tenantHost: cfg.tenantHost, loginHosts: cfg.loginHosts, allowInsecureTestScheme: options.allowInsecureTestScheme === true }) : null;
  const rawLog = options.log ?? ((line) => console.log(line));
  // Log lines are built ONLY from a fixed event vocabulary and short [A-Za-z0-9_.:-] values: typed text, cookies and URLs cannot get in.
  const log = (evt, fields = {}) => {
    if (!EVENTS.has(evt)) return;
    const clean = {};
    for (const [k, v] of Object.entries(fields)) {
      if (!/^[a-z_]{1,30}$/.test(k)) continue;
      if (typeof v === 'number' || typeof v === 'boolean') clean[k] = v; else if (typeof v === 'string' && /^[A-Za-z0-9_.:-]{0,80}$/.test(v)) clean[k] = v;
    }
    try { rawLog(JSON.stringify({ ts: new Date(now()).toISOString(), svc: 'basht-login', evt, ...clean })); } catch { /* logging never breaks a request */ }
  };
  const makeBrowser = () => (options.makeBrowser ?? (({ policy: p, env: e, log: l }) => createLoginBrowser({ launch: () => launchChromium({ env: e, policy: p }), policy: p, env: e, log: l })))({ policy, env, log });

  let current = null;                                        // the single live session
  let failures = []; let lockedUntil = 0;

  async function destroy(reason) {
    const s = current; if (!s) return; current = null;
    clearTimeout(s.timer);
    for (const res of s.clients) { try { res.write('event: closed\ndata: {}\n\n'); res.end(); } catch { /* gone */ } }
    s.clients.clear();
    await s.browser.close(reason).catch(() => {});
    log('session_closed', { reason });
  }
  const tick = async () => {
    const s = current; if (!s) return;
    if (now() - s.created > cfg.maxMs) await destroy('max_lifetime');
    else if (now() - s.lastSeen > cfg.idleMs) await destroy('idle');
  };
  const housekeeping = setInterval(() => { tick().catch(() => {}); }, 5000); housekeeping.unref?.();

  // ---- helpers ----
  const cookieOf = (req, name) => { for (const part of String(req.headers.cookie ?? '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); } return null; };
  const sessionOf = (req) => { const id = cookieOf(req, '__Host-lsess'); return current && id && safeEqual(id, current.id) ? current : null; };
  const send = (res, status, type, body, extra = {}) => { res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Security-Policy': PLAIN_CSP, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra }); res.end(body); };
  const text = (res, status, body) => send(res, status, 'text/plain; charset=utf-8', body);
  const json = (res, status, obj) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
  const sameOrigin = (req) => { const o = req.headers.origin; if (typeof o !== 'string') return false; try { return new URL(o).host === req.headers.host; } catch { return false; } };
  function readBody(req, limit) {
    return new Promise((ok, fail) => {
      let size = 0; const chunks = [];
      req.on('data', (d) => { size += d.length; if (size > limit) { fail(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(d); });
      req.on('end', () => ok(Buffer.concat(chunks))); req.on('error', () => fail(Object.assign(new Error('read error'), { status: 400 })));
    });
  }
  async function readJson(req) {
    if (!/^application\/json(\s*;.*)?$/i.test(String(req.headers['content-type'] ?? ''))) throw Object.assign(new Error('bad type'), { status: 415 });
    try { const v = JSON.parse((await readBody(req, 4096)).toString('utf8')); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch (e) { if (e.status) throw e; }
    throw Object.assign(new Error('bad json'), { status: 400 });
  }
  const guard = (req, res, s) => {                          // authenticated mutation: session cookie + same origin + per-session CSRF header
    if (!s) { text(res, 401, 'Unauthorized'); return false; }
    if (!sameOrigin(req) || typeof req.headers['x-csrf'] !== 'string' || !safeEqual(req.headers['x-csrf'], s.csrf)) { text(res, 403, 'Forbidden'); return false; }
    s.lastSeen = now(); return true;
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x'); const path = url.pathname; const method = req.method;
    if (method === 'GET' && (path === '/healthz' || path === '/setup/healthz')) return text(res, 200, 'ok');   // the repo-root railway.toml probes /setup/healthz
    if (!configured) { log('unconfigured', {}); return text(res, 404, 'Not Found'); }

    if (method === 'GET' && path === '/') return send(res, 200, 'text/html; charset=utf-8', startPage({ tenantHost: cfg.tenantHost }));

    if (method === 'POST' && path === '/start') {
      if (!sameOrigin(req)) return text(res, 403, 'Forbidden');
      if (!/^application\/x-www-form-urlencoded/i.test(String(req.headers['content-type'] ?? ''))) return text(res, 415, 'Unsupported');
      let form; try { form = new URLSearchParams((await readBody(req, 2048)).toString('utf8')); } catch (e) { return text(res, e.status ?? 400, 'Bad request'); }
      const t = now(); failures = failures.filter((x) => t - x < 15 * 60_000);
      if (t < lockedUntil) { log('login_locked', {}); return send(res, 429, 'text/html; charset=utf-8', startPage({ tenantHost: cfg.tenantHost, message: 'محاولات كثيرة — حاول لاحقًا / too many attempts' })); }
      if (!safeEqual(form.get('code') ?? '', cfg.accessCode)) {
        failures.push(t); log('login_attempt_failed', { n: failures.length });
        if (failures.length >= 5) lockedUntil = t + 15 * 60_000;
        return send(res, 401, 'text/html; charset=utf-8', startPage({ tenantHost: cfg.tenantHost, message: 'رمز غير صحيح / invalid code' }));
      }
      failures = [];
      await destroy('replaced');
      const browser = makeBrowser();
      const s = { id: randomBytes(32).toString('hex'), csrf: randomBytes(24).toString('hex'), browser, created: now(), lastSeen: now(), clients: new Set(), timer: null, busy: false, inputs: [] };
      try { await browser.start(); } catch { log('session_start_failed', {}); await browser.close('start_failed').catch(() => {}); return send(res, 503, 'text/html; charset=utf-8', startPage({ tenantHost: cfg.tenantHost, message: 'تعذر تشغيل المتصفح / browser could not start' })); }
      current = s; browser.onFrame((b64) => { for (const c of s.clients) c.write('event: frame\ndata: ' + b64 + '\n\n'); });
      browser.onStatus((st) => { for (const c of s.clients) c.write('event: status\ndata: ' + JSON.stringify(st.closed ? { text: 'closed' } : { text: String(st.text).slice(0, 120) }) + '\n\n'); });
      log('session_started', {});
      return send(res, 303, 'text/plain; charset=utf-8', '', { Location: '/app', 'Set-Cookie': '__Host-lsess=' + s.id + '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=' + Math.ceil(cfg.maxMs / 1000) });
    }

    if (method === 'GET' && path === '/app') {
      const s = sessionOf(req); if (!s) return send(res, 303, 'text/plain; charset=utf-8', '', { Location: '/' });
      s.lastSeen = now();
      const nonce = randomBytes(16).toString('base64');
      const body = appPage({ nonce, csrf: s.csrf, tenantHost: cfg.tenantHost, maxMinutes: cfg.maxMinutes });
      return send(res, 200, 'text/html; charset=utf-8', body, { 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'` });
    }

    if (method === 'GET' && path === '/events') {
      const s = sessionOf(req); if (!s) return text(res, 401, 'Unauthorized');
      s.lastSeen = now();
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n'); s.clients.add(res);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closed */ } }, 15000); hb.unref?.();   // heartbeats do NOT count as activity
      req.on('close', () => { clearInterval(hb); s.clients.delete(res); });
      const first = s.browser.latestFrame?.(); if (first) res.write('event: frame\ndata: ' + first + '\n\n');
      return;
    }

    if (method === 'POST' && path === '/input') {
      const s = sessionOf(req); if (!guard(req, res, s)) return;
      let b; try { b = await readJson(req); } catch (e) { return text(res, e.status ?? 400, 'Bad request'); }
      const t = now(); s.inputs = s.inputs.filter((x) => t - x < 1000); if (s.inputs.length >= 25) return text(res, 429, 'Slow down'); s.inputs.push(t);
      try {
        if (b.type === 'tap' && Number.isFinite(b.fx) && Number.isFinite(b.fy) && b.fx >= 0 && b.fx <= 1 && b.fy >= 0 && b.fy <= 1) await s.browser.tap(b.fx, b.fy);
        else if (b.type === 'text' && typeof b.text === 'string' && b.text.length >= 1 && b.text.length <= 128 && !/[\u0000-\u001f\u007f]/.test(b.text)) await s.browser.typeText(b.text);
        else if (b.type === 'key' && ['Enter', 'Backspace', 'Tab'].includes(b.key)) await s.browser.key(b.key);
        else if (b.type === 'scroll' && (b.dir === 'up' || b.dir === 'down')) await s.browser.scroll(b.dir);
        else return text(res, 400, 'Bad request');
      } catch { return text(res, 502, 'Browser error'); }
      log('input', { kind: b.type });                           // the KIND only, never the content
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && path === '/proof') {
      const s = sessionOf(req); if (!guard(req, res, s)) return;
      let b; try { b = await readJson(req); } catch (e) { return text(res, e.status ?? 400, 'Bad request'); }
      const id = typeof b.invoice_id === 'number' ? String(b.invoice_id) : b.invoice_id;
      if (typeof id !== 'string' || !/^[1-9][0-9]{0,14}$/.test(id)) return text(res, 400, 'Invalid invoice id');
      if (s.busy) return text(res, 409, 'Busy'); s.busy = true;
      try { const r = await Promise.race([s.browser.proof(id), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 60_000).unref?.())]); log('proof', { verdict: r.verdict }); return json(res, 200, { ok: true, ...r }); }
      catch { log('proof', { verdict: 'error' }); return json(res, 502, { ok: false, error: 'proof_failed' }); }
      finally { s.busy = false; }
    }

    if (method === 'POST' && path === '/finish') {
      const s = sessionOf(req); if (!guard(req, res, s)) return;
      await destroy('finished'); return json(res, 200, { ok: true });
    }
    return text(res, 404, 'Not Found');
  }

  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 10_000, requestTimeout: 0 }, (req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) { try { res.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Internal error'); } catch { /* closed */ } } });
  });
  async function listen() {
    const port = options.port ?? env.PORT ?? 8080;
    if (!configured) log('unconfigured', {});
    await new Promise((ok, fail) => { server.once('error', fail); server.listen(Number(port), options.host ?? env.LOGIN_HOST ?? '::', () => { server.off('error', fail); ok(); }); });
    log('server_started', { configured });
    return server.address();
  }
  async function close() { clearInterval(housekeeping); await destroy('shutdown'); await new Promise((ok) => { server.close(() => ok()); server.closeAllConnections?.(); }); }
  return { listen, close, server, configured, issues: cfg.issues, _tick: tick, _current: () => current };
}

if (process.argv[1] && import.meta.url === new URL('file://' + resolve(process.argv[1])).href) {
  const svc = createLoginServer();
  try { const a = await svc.listen(); console.log(JSON.stringify({ ok: true, svc: 'basht-login', configured: svc.configured, port: a.port })); }
  catch (e) { console.error(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 1; }
  const stop = () => svc.close().then(() => process.exit(0)); process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
