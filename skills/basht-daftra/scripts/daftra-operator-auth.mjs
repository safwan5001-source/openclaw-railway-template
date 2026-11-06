// Operator authentication for the separate-service broker's approval console.
// The agent never sees any of this: it has neither the password, nor the TOTP seed, nor access to the broker's state.
//   - password  : OPERATOR_PASSWORD (>= 20 chars), constant-time compare
//   - TOTP      : RFC 6238 (HMAC-SHA1, 6 digits, 30 s, +-1 step). The shared secret is DERIVED from OPERATOR_TOTP_SEED
//                 (>= 32 chars) with HKDF-SHA256, so the owner needs no shell/base32 tooling: the enrollment page shows
//                 the derived base32 "setup key" once (OPERATOR_ENROLLMENT=1) for the iOS Passwords app / any authenticator.
//   - replay    : a monotonically increasing "last accepted time step" is persisted (HMAC-protected). A code can be used
//                 once; the code that logged you in can never also authorise an approval.
//   - step-up   : every approve / reject / resolve needs a FRESH code (step > last used).
//   - throttling: per-client and global failure counters with exponential lockout, persisted (HMAC-protected) so a
//                 restart does not reset it.
//   - sessions  : server-side, random 256-bit ids, 10 min idle / 30 min absolute, new id on login, CSRF token per session.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD = 30;
export const SESSION_IDLE_MS = 10 * 60_000;
export const SESSION_ABSOLUTE_MS = 30 * 60_000;
const MAX_SESSIONS = 20;
const MAX_PRE_TOKENS = 1000;
const FREE_FAILS = 4;                  // failures allowed before lockout starts
const LOCK_BASE_MS = 30_000;
const LOCK_MAX_MS = 60 * 60_000;

export function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function deriveTotpSecret(seed) {
  if (typeof seed !== 'string' || seed.length < 32) throw new Error('OPERATOR_TOTP_SEED must be at least 32 characters');
  return Buffer.from(hkdfSync('sha256', Buffer.from(seed, 'utf8'), Buffer.from('basht-daftra-operator-totp-v1'), Buffer.from('totp-secret'), 20));
}
export const totpBase32 = (seed) => base32Encode(deriveTotpSecret(seed));

export function totpCode(secret, step) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(counter).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}
export const stepAt = (ms) => Math.floor(ms / 1000 / TOTP_PERIOD);

const sha = (s) => createHash('sha256').update(String(s)).digest();
export function constantTimeEqual(a, b) { return timingSafeEqual(sha(a), sha(b)); }   // equal-length digests: no length leak

// Returns the matching time step (within +-1 of `now`) or null. Always evaluates all three candidates.
export function matchTotp(secret, code, nowMs) {
  const cur = stepAt(nowMs); let hit = null;
  const given = /^[0-9]{6}$/.test(String(code ?? '').trim()) ? String(code).trim() : '------';
  for (const s of [cur - 1, cur, cur + 1]) if (constantTimeEqual(totpCode(secret, s), given) && given !== '------') hit = s;
  return hit;
}

export function otpauthUri(b32, account = 'operator', issuer = 'BASHT Daftra Broker') {
  return 'otpauth://totp/' + encodeURIComponent(issuer) + ':' + encodeURIComponent(account) + '?secret=' + b32 + '&issuer=' + encodeURIComponent(issuer) + '&algorithm=SHA1&digits=6&period=' + TOTP_PERIOD;
}

const unique = () => randomBytes(32).toString('base64url');

export class AuthStateTampered extends Error {
  constructor(m) { super(m); this.name = 'AuthStateTampered'; this.code = 'AUTH_STATE_TAMPERED'; }
}

// opts: { env, stateDir, now: () => ms, stateKeyLabel }
export function createOperatorAuth(opts) {
  const { env, stateDir } = opts; const now = opts.now ?? Date.now;
  const password = env.OPERATOR_PASSWORD; const seed = env.OPERATOR_TOTP_SEED;
  const configured = typeof password === 'string' && password.length >= 20 && typeof seed === 'string' && seed.length >= 32;
  const secret = configured ? deriveTotpSecret(seed) : null;
  const stateFile = join(stateDir, 'operator-state.json');
  const stateKey = configured ? createHash('sha256').update('state-key\n' + seed).digest() : null;
  const macOf = (obj) => createHmac('sha256', stateKey).update(JSON.stringify(obj)).digest('hex');
  const sessions = new Map();
  const pre = new Map();
  let state = { last_step: 0, global: { fails: 0, until: 0 }, clients: {} };
  let loaded = false; let broken = null; let writing = Promise.resolve();

  async function load() {
    if (loaded || !configured) return;
    loaded = true;
    let raw;
    try {
      const st = await lstat(stateFile);
      if (st.isSymbolicLink() || !st.isFile()) { broken = 'operator state is not a regular file'; return; }
      raw = await readFile(stateFile, 'utf8');
    } catch (e) { if (e.code === 'ENOENT') { state.last_step = stepAt(now()) - 2; return; } broken = 'operator state unreadable'; return; }
    try {
      const { mac, ...body } = JSON.parse(raw);
      if (typeof mac !== 'string' || mac.length !== 64 || !timingSafeEqual(Buffer.from(mac), Buffer.from(macOf(body)))) throw new Error('mac');
      state = body;
    } catch { broken = 'operator state failed authentication (edited?)'; }
  }
  async function save() {
    const body = JSON.parse(JSON.stringify(state));
    const tmp = stateFile + '.' + randomBytes(4).toString('hex') + '.tmp';
    writing = writing.then(async () => {
      await writeFile(tmp, JSON.stringify({ ...body, mac: macOf(body) }), { flag: 'wx', mode: 0o600 });
      await rename(tmp, stateFile);
    });
    await writing;
  }
  // Operator may reset a corrupted state (OPERATOR_STATE_RESET=1): the file is moved aside, and codes of past steps stay dead.
  async function reset() {
    try { await rename(stateFile, stateFile + '.corrupt-' + now()); } catch { /* absent */ }
    state = { last_step: stepAt(now()), global: { fails: 0, until: 0 }, clients: {} };
    broken = null; await save();
  }

  const clientKey = (ip) => createHash('sha256').update('client\n' + String(ip)).digest('hex').slice(0, 12);

  function lockedUntil(ip) {
    const c = state.clients[clientKey(ip)];
    return Math.max(state.global.until ?? 0, c?.until ?? 0);
  }
  async function fail(ip) {
    const bump = (rec, free) => { rec.fails = (rec.fails ?? 0) + 1; if (rec.fails > free) rec.until = now() + Math.min(LOCK_BASE_MS * 2 ** (rec.fails - free - 1), LOCK_MAX_MS); };
    const k = clientKey(ip); state.clients[k] ??= { fails: 0, until: 0 };
    bump(state.clients[k], FREE_FAILS); bump(state.global, FREE_FAILS * 5);
    const keys = Object.keys(state.clients); if (keys.length > 500) for (const old of keys.slice(0, keys.length - 500)) delete state.clients[old];
    await save();
  }
  async function success(ip) {
    const k = clientKey(ip); if (state.clients[k]) state.clients[k] = { fails: 0, until: 0 };
    state.global = { fails: 0, until: 0 }; await save();
  }

  function reap() {
    const t = now();
    for (const [id, s] of sessions) if (t - s.last > SESSION_IDLE_MS || t - s.created > SESSION_ABSOLUTE_MS) sessions.delete(id);
    for (const [id, exp] of pre) if (exp < t) pre.delete(id);
  }

  return {
    configured,
    get broken() { return broken; },
    ready: async () => { await load(); return configured && !broken; },
    reset,
    totpBase32: () => (configured ? totpBase32(seed) : null),
    checkPassword: (given) => configured && constantTimeEqual(given ?? '', password),

    // Single-use pre-login form tokens (login CSRF).
    issuePre() { reap(); if (pre.size >= MAX_PRE_TOKENS) pre.delete(pre.keys().next().value); const id = unique(); pre.set(id, now() + SESSION_IDLE_MS); return id; },
    consumePre(id) { reap(); const ok = typeof id === 'string' && pre.has(id); if (ok) pre.delete(id); return ok; },

    // -> { ok:true, session } | { ok:false, status:401|429|503, locked? }.  Uniform failure for password/code/format.
    async login({ password: pw, code, ip }) {
      await load();
      if (!configured) return { ok: false, status: 503 };
      if (broken) return { ok: false, status: 503, broken };
      if (lockedUntil(ip) > now()) return { ok: false, status: 429 };
      const pwOk = constantTimeEqual(pw ?? '', password);                // always evaluate both factors
      const step = matchTotp(secret, code, now());
      if (!pwOk || step === null || step <= state.last_step) { await fail(ip); return { ok: false, status: 401 }; }
      state.last_step = step; await success(ip);
      reap();
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      const id = unique(); const s = { id, csrf: unique(), created: now(), last: now(), short: createHash('sha256').update(id).digest('hex').slice(0, 8) };
      sessions.set(id, s);
      return { ok: true, session: s };
    },
    // Password-only proof used by /enroll (no session is created, nothing but the setup key is revealed).
    async verifyPasswordOnly({ password: pw, ip }) {
      await load();
      if (!configured) return { ok: false, status: 503 };
      if (lockedUntil(ip) > now()) return { ok: false, status: 429 };
      if (!constantTimeEqual(pw ?? '', password)) { await fail(ip); return { ok: false, status: 401 }; }
      return { ok: true };
    },
    session(id) {
      reap();
      const s = typeof id === 'string' ? sessions.get(id) : undefined;
      if (!s) return null;
      s.last = now(); return s;
    },
    logout(id) { sessions.delete(id); },
    // Fresh code required for an action. The code must be newer than any code ever accepted.
    async stepUp({ ip, code }) {
      await load();
      if (!configured || broken) return { ok: false, status: 503 };
      if (lockedUntil(ip) > now()) return { ok: false, status: 429 };
      const step = matchTotp(secret, code, now());
      if (step === null || step <= state.last_step) { await fail(ip); return { ok: false, status: 401 }; }
      state.last_step = step; await success(ip);
      return { ok: true, step };
    },
    sessionCount: () => sessions.size,
    _state: () => state,
  };
}
export async function removeStateFile(stateDir) { await rm(join(stateDir, 'operator-state.json'), { force: true }); }
