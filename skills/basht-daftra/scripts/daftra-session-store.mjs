// The operator's own Daftra browser session, stored by the BROKER only (never by the agent, never in the OpenClaw image).
//
// The operator signs in to Daftra in their own browser, copies the session cookie(s) once and pastes them into the broker's
// operator console (password + authenticator code). The Daftra password never reaches BASHT, Claude Code or the broker.
// The cookie is kept ENCRYPTED AT REST (AES-256-GCM, key derived from DAFTRA_APPROVAL_SECRET) in the private state volume,
// is only ever sent to the tenant host on GET requests for one invoice PDF (daftra-session-pdf.mjs), and is never returned,
// logged, audited or shown again.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FILE = 'daftra-session.json';
const DEFAULT_COOKIE_NAME = 'OISystem';                 // Daftra's documented session cookie
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const VALUE_RE = /^[A-Za-z0-9%_.~+\/=:-]{1,2048}$/;      // URL-safe / base64 / hex tokens: no quotes, spaces, ';' or ','
const MAX_PAIRS = 12;
const MAX_TOTAL = 4096;
export const SESSION_STATUS = Object.freeze({ none: 'not_connected', connected: 'connected', expired: 'expired' });

// Accepts a bare session value, `name=value`, a `Cookie:` header or `a=1; b=2`. Returns {ok, pairs} or {ok:false, error} (error never echoes input).
export function parseCookieInput(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'No cookie provided' };
  let text = raw.trim().replace(/^cookie\s*:\s*/i, '');
  if (!text || text.length > MAX_TOTAL * 2) return { ok: false, error: 'Cookie is empty or too long' };
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, error: 'Cookie contains control characters' };
  if (!text.includes('=')) text = DEFAULT_COOKIE_NAME + '=' + text;
  const map = new Map();
  for (const part of text.split(';')) {
    const piece = part.trim();
    if (!piece) continue;
    const i = piece.indexOf('=');
    if (i <= 0) return { ok: false, error: 'Cookie is not in name=value form' };
    const name = piece.slice(0, i).trim(); let value = piece.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (!NAME_RE.test(name)) return { ok: false, error: 'Cookie name is not valid' };
    if (!VALUE_RE.test(value)) return { ok: false, error: 'Cookie value has unsupported characters' };
    map.set(name, value);
  }
  const pairs = [...map];
  if (!pairs.length || pairs.length > MAX_PAIRS) return { ok: false, error: 'Expected between 1 and ' + MAX_PAIRS + ' cookies' };
  if (pairs.reduce((n, [k, v]) => n + k.length + v.length + 2, 0) > MAX_TOTAL) return { ok: false, error: 'Cookie is too long' };
  return { ok: true, pairs };
}

const headerOf = (pairs) => pairs.map(([k, v]) => k + '=' + v).join('; ');

export function createSessionStore({ dir, secret, now = Date.now }) {
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('session store needs the approval secret');
  const key = createHash('sha256').update('daftra-session-key\n' + secret).digest();
  const path = join(dir, FILE);
  let cache; let loaded = false;

  async function read() {
    if (loaded) return cache;
    loaded = true; cache = null;
    let st;
    try { st = await lstat(path); } catch (e) { if (e.code === 'ENOENT') return cache; throw e; }
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('session file is not a regular file');
    try {
      const f = JSON.parse(await readFile(path, 'utf8'));
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'));
      d.setAuthTag(Buffer.from(f.tag, 'base64'));
      cache = JSON.parse(Buffer.concat([d.update(Buffer.from(f.ct, 'base64')), d.final()]).toString('utf8'));
    } catch { cache = { corrupt: true }; }                 // wrong key / tampered file: treated as "not connected", never an exception
    return cache;
  }

  async function write(record) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(record), 'utf8'), c.final()]);
    const body = JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') });
    const tmp = path + '.' + randomBytes(6).toString('hex') + '.tmp';
    await writeFile(tmp, body, { flag: 'wx', mode: 0o600 });
    try { await rename(tmp, path); } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
    cache = record; loaded = true;
  }

  const usable = (r) => Boolean(r && !r.corrupt && typeof r.cookie === 'string' && r.cookie);

  return {
    // The Cookie header value, or null. Only the PDF fetcher may call this.
    async cookieHeader() { const r = await read(); return usable(r) && r.status !== SESSION_STATUS.expired ? r.cookie : null; },
    // Every cookie value (for log scrubbing).
    async secretValues() { const r = await read(); return usable(r) ? r.cookie.split('; ').map((p) => p.slice(p.indexOf('=') + 1)).filter((v) => v.length >= 6) : []; },
    // Safe summary: never contains the cookie or its names.
    async status() {
      const r = await read();
      if (!usable(r)) return { state: SESSION_STATUS.none, corrupt: Boolean(r?.corrupt) };
      return { state: r.status === SESSION_STATUS.expired ? SESSION_STATUS.expired : SESSION_STATUS.connected, saved_at: r.saved_at, last_ok_at: r.last_ok_at ?? null, last_failure_at: r.last_failure_at ?? null, cookie_count: r.cookie.split('; ').length };
    },
    async save(pairs) {
      const t = new Date(now()).toISOString();
      await write({ cookie: headerOf(pairs), status: SESSION_STATUS.connected, saved_at: t, last_ok_at: null, last_failure_at: null });
    },
    async markOk() { const r = await read(); if (usable(r)) await write({ ...r, status: SESSION_STATUS.connected, last_ok_at: new Date(now()).toISOString() }); },
    async markExpired() { const r = await read(); if (usable(r) && r.status !== SESSION_STATUS.expired) await write({ ...r, status: SESSION_STATUS.expired, last_failure_at: new Date(now()).toISOString() }); },
    async clear() { await unlink(path).catch((e) => { if (e.code !== 'ENOENT') throw e; }); cache = null; loaded = true; },
    path,
  };
}
