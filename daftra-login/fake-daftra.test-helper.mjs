// A fake "Daftra" over local HTTPS for the real-Chromium end-to-end test: JS-driven e-mail + OTP login on www.daftra.com, a session cookie
// on the tenant host, a PDF route that needs the cookie, and write endpoints that must NEVER be reached through the login browser.
import https from 'node:https';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const OTP = '123456';
export const EMAIL = 'operator@example.test';
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

export function haveOpenssl() {
  return new Promise((ok) => execFile('openssl', ['version'], (e) => ok(!e)));
}

async function makeCert() {
  const dir = await mkdtemp(join(tmpdir(), 'basht-fake-cert-'));
  await new Promise((ok, fail) => execFile('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2',
    '-subj', '/CN=fake.daftra.test', '-addext', 'subjectAltName=DNS:*.daftra.com,DNS:daftra.com'], (e) => (e ? fail(e) : ok())));
  const out = { key: await readFile(join(dir, 'k.pem')), cert: await readFile(join(dir, 'c.pem')) };
  await rm(dir, { recursive: true, force: true });
  return out;
}

const LOGIN_HTML = `<!doctype html><html><head><title>Daftra login</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font:20px sans-serif;margin:16px">
<div id="step1"><input id="email" type="email" placeholder="email" style="width:100%;height:56px;font-size:22px"><button id="next" style="width:100%;height:56px;font-size:22px;margin-top:12px">Continue</button></div>
<div id="step2" style="display:none"><input id="otp" inputmode="numeric" placeholder="otp" style="width:100%;height:56px;font-size:22px"><button id="verify" style="width:100%;height:56px;font-size:22px;margin-top:12px">Verify</button></div>
<script>
const J = (b) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
document.getElementById('next').onclick = async () => { await fetch('/api/otp-start', J({ email: document.getElementById('email').value })); document.getElementById('step1').style.display = 'none'; document.getElementById('step2').style.display = 'block'; };
document.getElementById('verify').onclick = async () => { const r = await fetch('/api/otp-verify', J({ otp: document.getElementById('otp').value })); const j = await r.json(); if (j.redirect) location.href = j.redirect; };
</script></body></html>`;
const CLIENT_LOGIN_HTML = '<!doctype html><html><head><title>Client login</title></head><body><form action="/clients/login" method="post"><input type="email" name="email"><input type="password" name="password"></form></body></html>';
const DASHBOARD_HTML = `<!doctype html><html><head><title>Dashboard</title></head><body><h1>Dashboard</h1>
<img src="https://evil.example/pixel.png">
<script>fetch('/owner/invoices/add', { method: 'POST' }).catch(() => {}); fetch('/owner/invoices/delete/1').catch(() => {}); fetch('/api2/invoices.json', { method: 'POST' }).catch(() => {});</script></body></html>`;

export async function startFakeDaftra() {
  const { key, cert } = await makeCert();
  const state = { email: null, otp: null, writes: 0, deletes: 0, apiWrites: 0, pdfRequests: [], tokens: new Set(), sessions: new Set(), logins: 0 };
  const cookieOf = (req) => /(?:^|;\s*)OISystem=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
  const server = https.createServer({ key, cert }, async (req, res) => {
    const host = String(req.headers.host).split(':')[0]; const url = new URL(req.url, 'https://x');
    const body = await new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c).toString())); });
    const html = (s, status = 200) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(s); };
    const redirect = (to, extra = {}) => { res.writeHead(302, { Location: to, ...extra }); res.end(); };
    if (host === 'www.daftra.com') {
      if (req.method === 'GET' && url.pathname === '/users/login') return html(LOGIN_HTML);
      if (req.method === 'POST' && url.pathname === '/api/otp-start') { state.email = JSON.parse(body).email; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}'); }
      if (req.method === 'POST' && url.pathname === '/api/otp-verify') {
        state.otp = JSON.parse(body).otp; res.writeHead(200, { 'Content-Type': 'application/json' });
        if (state.otp !== OTP) return res.end('{}');
        const t = randomBytes(12).toString('hex'); state.tokens.add(t); state.logins++;
        return res.end(JSON.stringify({ redirect: 'https://nepras.daftra.com/sso?t=' + t }));
      }
      return html('not found', 404);
    }
    if (host === 'nepras.daftra.com') {
      if (url.pathname === '/sso' && state.tokens.has(url.searchParams.get('t'))) {
        const s = randomBytes(16).toString('hex'); state.sessions.add(s);
        return redirect('/owner/dashboard', { 'Set-Cookie': 'OISystem=' + s + '; Path=/; HttpOnly; Secure; SameSite=Lax' });
      }
      if (req.method === 'POST' && url.pathname === '/owner/invoices/add') { state.writes++; res.writeHead(200); return res.end('{}'); }
      if (req.method === 'POST' && url.pathname.startsWith('/api2/')) { state.apiWrites++; res.writeHead(200); return res.end('{}'); }
      if (url.pathname.startsWith('/owner/invoices/delete/')) { state.deletes++; res.writeHead(200); return res.end('{}'); }
      const authed = state.sessions.has(cookieOf(req));
      if (url.pathname === '/owner/dashboard') return authed ? html(DASHBOARD_HTML) : redirect('/');
      const m = /^\/(?:owner\/)?invoices\/view\/(\d+)\.pdf$/.exec(url.pathname);
      if (m) {
        if (!authed) return redirect('https://nepras.daftra.com/');
        state.pdfRequests.push({ ua: String(req.headers['user-agent'] ?? ''), owner: url.pathname.startsWith('/owner/'), fetchSite: req.headers['sec-fetch-site'] ?? null });
        res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end(PDF);
      }
      if (url.pathname === '/') return html(CLIENT_LOGIN_HTML);
      return html('not found', 404);
    }
    return html('unknown host', 404);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  return { port, state, testMap: ['MAP www.daftra.com 127.0.0.1:' + port, 'MAP nepras.daftra.com 127.0.0.1:' + port], stop: () => new Promise((ok) => { server.close(() => ok()); server.closeAllConnections?.(); }) };
}
