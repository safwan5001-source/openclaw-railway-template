// One short-lived, isolated Chromium for ONE operator login. Nothing here persists: fresh profile in a private temp dir, deleted on close.
//
// What this process CAN technically see (stated plainly, because it is true): everything the operator types into the remote page
// (e-mail, OTP, any password) passes through this Node process on its way to Chromium, and the session cookies live in Chromium's memory
// and are readable here over CDP. The code never logs, stores or forwards typed text, and cookies exist only inside proof().
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectCdp } from './cdp.mjs';
import { decideRequest, hostResolverRules } from './policy.mjs';
import { findChromium } from '../skills/basht-daftra/scripts/daftra-pdf.mjs';
import { fetchSessionPdf } from '../skills/basht-daftra/scripts/daftra-session-pdf.mjs';

export const VIEWPORT = Object.freeze({ width: 430, height: 900, dpr: 2 });
export const LOGIN_URL = 'https://www.daftra.com/users/login';
const KEYS = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
});

// The child gets a MINIMAL environment: never the access code or any other variable of this service.
export function childEnvironment(env, dir) {
  return { PATH: env.PATH ?? '/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8', ...(env.FONTCONFIG_PATH ? { FONTCONFIG_PATH: env.FONTCONFIG_PATH } : {}) };
}

// ---- launching -----------------------------------------------------------------------------------------------------------------
export function chromiumArgs({ dir, policy, noSandbox, testMap = [], extra = [] }) {
  return ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + join(dir, 'profile'),
    '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update',
    '--disable-default-apps', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--host-resolver-rules=' + hostResolverRules(policy, { testMap }),
    ...(noSandbox ? ['--no-sandbox'] : []), ...extra, 'about:blank'];
}

export async function launchChromium({ env = process.env, policy, noSandbox = env.LOGIN_CHROMIUM_NO_SANDBOX === '1', testMap = [], extraArgs = [], startTimeoutMs = 25000 } = {}) {
  const bin = findChromium(env);
  if (!bin) throw new Error('Chromium not found');
  const dir = await mkdtemp(join(tmpdir(), 'basht-login-'), { mode: 0o700 });
  const childEnv = childEnvironment(env, dir);
  const child = spawn(bin, chromiumArgs({ dir, policy, noSandbox, testMap, extra: extraArgs }), { stdio: ['ignore', 'ignore', 'pipe'], env: childEnv });
  let wsUrl = null; let exited = false; child.once('exit', () => { exited = true; });
  const found = new Promise((ok, fail) => {
    let buf = '';
    child.stderr.on('data', (d) => { if (wsUrl) return; buf = (buf + d).slice(-4096); const m = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[A-Za-z0-9-]+)/.exec(buf); if (m) { wsUrl = m[1]; ok(wsUrl); } });
    child.once('exit', () => fail(new Error('Chromium exited during start')));
    child.once('error', () => fail(new Error('Chromium could not be started')));
    setTimeout(() => fail(new Error('Chromium start timeout')), startTimeoutMs).unref?.();
  });
  const kill = async () => {
    if (!exited) { try { child.kill('SIGKILL'); } catch { /* gone */ } await new Promise((r) => (exited ? r() : child.once('exit', r))); }
    child.stderr?.destroy();
    await rm(dir, { recursive: true, force: true });
  };
  try { await found; } catch (e) { await kill(); throw e; }
  return { wsUrl, kill };
}

// ---- the session ---------------------------------------------------------------------------------------------------------------
// launch(): () => Promise<{ wsUrl, kill }>. Everything else is derived from `policy` and `env` (tenant root only: NO API key here).
export function createLoginBrowser({ launch, policy, env, log = () => {}, now = Date.now, fetcher = fetch }) {
  const tenantOrigin = 'https://' + policy.tenant;
  const frameListeners = new Set(); const statusListeners = new Set();
  let cdp; let proc; let sid; let userAgent = ''; let latest = null; let closed = false; let blocked = 0; let lastFrameAt = 0; let pendingLoad = null;

  const S = (method, params) => cdp.send(method, params, sid);
  const status = (text) => { for (const fn of statusListeners) fn({ text }); };
  const emitFrame = (b64) => { latest = b64; for (const fn of frameListeners) fn(b64); };

  async function onEvent(m) {
    if (closed) return;
    try {
      if (m.method === 'Fetch.requestPaused' && m.sessionId === sid) {
        const { requestId, request } = m.params;
        const d = decideRequest({ url: request.url, method: request.method }, policy);
        if (d.allow) await S('Fetch.continueRequest', { requestId }).catch(() => {});
        else {
          blocked++;
          try { const u = new URL(request.url); log('request_blocked', { reason: d.reason, method: String(request.method).slice(0, 8), host: u.hostname.slice(0, 80) }); status('blocked ' + d.reason + ': ' + request.method + ' ' + u.hostname.slice(0, 60)); } catch { /* unparsable */ }
          await S('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
        }
      } else if (m.method === 'Page.screencastFrame' && m.sessionId === sid) {
        await S('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
        const t = now(); if (t - lastFrameAt >= 140) { lastFrameAt = t; emitFrame(m.params.data); }
      } else if (m.method === 'Page.javascriptDialogOpening' && m.sessionId === sid) {
        await S('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
      } else if (m.method === 'Page.loadEventFired' && m.sessionId === sid) {
        pendingLoad?.();
      } else if (m.method === 'Target.targetCreated' && m.params?.targetInfo?.type === 'page' && m.params.targetInfo.targetId !== targetId) {
        await cdp.send('Target.closeTarget', { targetId: m.params.targetInfo.targetId }).catch(() => {});   // no pop-ups, no second tab
      }
    } catch { /* event handling never crashes the session */ }
  }
  let targetId;

  async function start() {
    proc = await launch();
    cdp = await connectCdp(proc.wsUrl);
    cdp.onEvent(onEvent);
    cdp.onClose(() => { if (!closed) close('browser_gone'); });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    // Reuse the single page Chromium opened itself; only AFTER that watch for extra pages (pop-ups / new tabs) and close them.
    const { targetInfos } = await cdp.send('Target.getTargets');
    targetId = targetInfos.find((t) => t.type === 'page')?.targetId;
    if (!targetId) ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const version = await cdp.send('Browser.getVersion');
    // Normal desktop-Chrome string instead of "HeadlessChrome": the operator is signing in to their OWN account; some sites reject the headless label.
    userAgent = String(version.userAgent ?? '').replace('HeadlessChrome', 'Chrome');
    await S('Page.enable'); await S('Network.enable'); await S('Runtime.enable');
    await S('Emulation.setUserAgentOverride', { userAgent });
    await S('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: VIEWPORT.dpr, mobile: true });
    await S('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await S('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: VIEWPORT.width * VIEWPORT.dpr, maxHeight: VIEWPORT.height * VIEWPORT.dpr, everyNthFrame: 1 });
    await S('Page.navigate', { url: LOGIN_URL }).catch(() => {});
    log('browser_started', {});
  }

  const toXY = (fx, fy) => ({ x: Math.round(fx * VIEWPORT.width), y: Math.round(fy * VIEWPORT.height) });
  async function tap(fx, fy) {
    const { x, y } = toXY(fx, fy);
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  // Typed text goes straight to Chromium; it is never logged, stored or echoed back.
  async function typeText(text) {
    for (const ch of Array.from(String(text))) {
      const isDigit = /^[0-9]$/.test(ch);
      const base = isDigit ? { key: ch, code: 'Digit' + ch, windowsVirtualKeyCode: 48 + Number(ch) } : { key: ch };
      await S('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, ...base });
      await S('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    }
  }
  async function key(name) {
    const k = KEYS[name]; if (!k) throw new Error('unsupported key');
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk };
    await S('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(k.text ? { text: k.text } : {}) });
    await S('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  async function scroll(dir) {
    await S('Input.dispatchMouseEvent', { type: 'mouseWheel', x: VIEWPORT.width / 2, y: VIEWPORT.height / 2, deltaX: 0, deltaY: dir === 'up' ? -400 : 400 });
  }

  async function evaluate(expression) {
    const r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page script failed');
    return r.result?.value;
  }
  async function gotoTenantRoot() {
    const loaded = new Promise((ok) => { pendingLoad = ok; setTimeout(ok, 15000).unref?.(); });
    await S('Page.navigate', { url: tenantOrigin + '/' });
    await loaded; pendingLoad = null;
  }

  // The proof (see proof.mjs). Cookies are read, used for ONE server-side GET and dropped inside this function.
  async function proof(invoiceId) {
    const { runPdfProof } = await import('./proof.mjs');
    return runPdfProof({
      invoiceId, tenantOrigin,
      browserProbe: async () => { await gotoTenantRoot(); return evaluate(probeExpression(invoiceId)); },
      cookieHeader: async () => {
        const { cookies } = await S('Network.getCookies', { urls: [tenantOrigin] });
        const safe = cookies.filter((c) => /^[A-Za-z0-9_.-]{1,64}$/.test(c.name) && /^[\x21-\x7e]{0,4096}$/.test(c.value) && !/[;,\s"]/.test(c.value));
        return { header: safe.map((c) => c.name + '=' + c.value).join('; '), names: safe.map((c) => c.name) };
      },
      serverFetch: (header) => fetchSessionPdf(String(invoiceId), { cookieHeader: header, env, userAgent, fetcher }),
    });
  }

  async function close(reason = 'closed') {
    if (closed) return; closed = true;
    latest = null;
    for (const fn of statusListeners) { try { fn({ closed: true, reason }); } catch { /* ignore */ } }
    try { await cdp?.send('Browser.close'); } catch { /* may already be gone */ }
    try { cdp?.close(); } catch { /* ignore */ }
    await proc?.kill?.().catch?.(() => {});
    frameListeners.clear(); statusListeners.clear();
    log('browser_closed', { reason });
  }

  return {
    start, tap, typeText, key, scroll, proof, close,
    onFrame(fn) { frameListeners.add(fn); return () => frameListeners.delete(fn); }, latestFrame: () => latest,
    onStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); },
    get closed() { return closed; }, get blockedCount() { return blocked; },
    _evaluate: evaluate, _S: (m, p) => S(m, p),
  };
}

// In-page probe: GET the invoice PDF with the page's own session and report ONLY metadata (never bytes, URLs or cookies).
export function probeExpression(invoiceId) {
  const id = JSON.stringify(String(invoiceId));
  return `(async (id) => {
    const out = [];
    for (const [variant, p] of [['owner', '/owner/invoices/view/' + id + '.pdf'], ['plain', '/invoices/view/' + id + '.pdf']]) {
      try {
        const r = await fetch(p, { credentials: 'include', cache: 'no-store' });
        const buf = new Uint8Array(await r.arrayBuffer());
        const head = new TextDecoder('latin1').decode(buf.slice(0, 5));
        const tail = new TextDecoder('latin1').decode(buf.slice(Math.max(0, buf.length - 1024)));
        const u = new URL(r.url);
        out.push({ variant, http_status: r.status, content_type: (r.headers.get('content-type') || 'none').split(';')[0].trim().toLowerCase().slice(0, 60), size: buf.length,
          pdf_magic: head === '%PDF-', has_eof: tail.includes('%%EOF'), redirected: r.redirected, final_is_root: u.pathname === '/', same_host: u.host === location.host });
        if (head === '%PDF-') break;
      } catch (e) { out.push({ variant, error: 'fetch_failed' }); }
    }
    return out;
  })(${id})`;
}
