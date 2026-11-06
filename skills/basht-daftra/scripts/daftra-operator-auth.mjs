// Operator authentication for the separate-service broker's approval console.
// The agent never sees any of this: it has neither the password, nor the TOTP seed, nor access to the broker's state.
//   - password  : OPERATOR_PASSWORD (>= 20 chars), constant-time compare
//   - TOTP      : RFC 6238 (HMAC-SHA1, 6 digits, 30 s, +-1 step). The shared secret is DERIVED from OPERATOR_TOTP_SEED
//                 (>= 32 chars) with HKDF-SHA256, so the owner needs no shell/base32 tooling: the enrollment page shows
//                 the derived base32 "setup key" once (OPERATOR_ENROLLMENT=1) for the iOS Passwords app / any authenticator.
//   - replay    : a monotonically increasing "last accepted time step" is persisted (HMAC-protected). A code can be used
//                 once; the code that logged you in can never also authorise an approval.
//   - step-up   : every approve / reject / resolve needs a FRESH code (step > last used).
//   - throttling: per-client and global failure counters. INVALID attempts are serialised, delayed and, after a few, refused
//                 for at most 60 s; VALID credentials (password + fresh code) are never refused because of a lock, so an
//                 unauthenticated flood can slow only itself. Counters are persisted lazily (HMAC-protected).
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
const LOCK_BASE_MS = 5_000;
export const LOCK_MAX_MS = 60_000;        // an invalid-credential lock can never exceed a minute
const FAIL_DECAY_MS = 15 * 60_000;
const MAX_FAIL_QUEUE = 20;

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

// opts: { env, stateDir, now: () => ms, sleep?, failDelayMs? }
export function createOperatorAuth(opts) {
  const { env, stateDir } = opts; const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  const envDelay = Number(env.OPERATOR_FAIL_DELAY_MS);
  const failDelayMs = opts.failDelayMs ?? (Number.isFinite(envDelay) && envDelay >= 0 ? Math.min(envDelay, 2000) : 300);
  const password = env.OPERATOR_PASSWORD; const seed = env.OPERATOR_TOTP_SEED;
  const configured = typeof password === 'string' && password.length >= 20 && typeof seed === 'string' && seed.length >= 32;
  const secret = configured ? deriveTotpSecret(seed) : null;
  const stateFile = join(stateDir, 'operator-state.json');
  const stateKey = configured ? createHash('sha256').update('state-key\n' + seed).digest() : null;
  const macOf = (obj) => createHmac('sha256', stateKey).update(JSON.stringify(obj)).digest('hex');
  const sessions = new Map();
  const pre = new Map();
  let state = { last_step: 0, global: { fails: 0, until: 0 }, clients: {} };
  let loaded = false; let broken = null; let writing = Promise.resolve(); let dirty = false; let saveTimer = null;

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
      // Self-heal: a lock is never longer than LOCK_MAX_MS and counters decay, so stale persisted locks are dropped at start.
      const t0 = now();
      for (const rec of [state.global, ...Object.values(state.clients ?? {})]) if (rec && (rec.until ?? 0) - t0 > LOCK_MAX_MS) rec.until = t0 + LOCK_MAX_MS;
    } catch { broken = 'operator state failed authentication (edited?)'; }
  }
  // The write chain RECOVERS after a transient I/O error: the error reaches the caller of THAT save only.
  function save() {
    const body = JSON.parse(JSON.stringify(state));
    const tmp = stateFile + '.' + randomBytes(4).toString('hex') + '.tmp';
    const job = writing.catch(() => {}).then(async () => {
      try {
        await writeFile(tmp, JSON.stringify({ ...body, mac: macOf(body) }), { flag: 'wx', mode: 0o600 });
        await rename(tmp, stateFile);
      } catch (e) { await rm(tmp, { force: true }).catch(() => {}); throw e; }
    });
    writing = job.catch(() => {});
    return job;
  }
  // Failure counters are persisted lazily (at most one write per second): an attacker must not be able to turn failed
  // logins into unbounded disk writes. Successes (last_step = replay protection) are persisted immediately.
  function saveSoon() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; if (dirty) { dirty = false; save().catch(() => {}); } }, 1000);
    saveTimer.unref?.();
  }
  async function flush() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } if (dirty) { dirty = false; await save(); } else await writing.catch(() => {}); }
  // Operator may reset a corrupted state (OPERATOR_STATE_RESET=1): the file is moved aside, and codes of past steps stay dead.
  async function reset() {
    try { await rename(stateFile, stateFile + '.corrupt-' + now()); } catch { /* absent */ }
    state = { last_step: stepAt(now()), global: { fails: 0, until: 0 }, clients: {} };
    broken = null; await save();
  }
  // Break-glass for a lockout: clears every lock/failure counter but NEVER the replay high-water mark.
  async function clearLocks() {
    await load();
    if (broken) return false;
    state.clients = {}; state.global = { fails: 0, until: 0 };
    await save(); return true;
  }

  const clientKey = (ip) => createHash('sha256').update('client\n' + String(ip)).digest('hex').slice(0, 12);
  function lockedUntil(ip) {
    const c = state.clients[clientKey(ip)];
    return Math.max(state.global.until ?? 0, c?.until ?? 0);
  }
  // Failure accounting: counters decay after 15 quiet minutes; locks escalate 5 s -> 60 s and NEVER beyond (LOCK_MAX_MS).
  function recordFail(ip) {
    const t = now();
    const bump = (rec, free) => {
      if (t - (rec.last ?? 0) > FAIL_DECAY_MS) rec.fails = 0;
      rec.fails = (rec.fails ?? 0) + 1; rec.last = t;
      if (rec.fails > free) rec.until = t + Math.min(LOCK_BASE_MS * 2 ** Math.min(rec.fails - free - 1, 10), LOCK_MAX_MS);
    };
    const k = clientKey(ip); state.clients[k] ??= { fails: 0, until: 0 };
    bump(state.clients[k], FREE_FAILS); bump(state.global, FREE_FAILS * 5);
    const keys = Object.keys(state.clients); if (keys.length > 500) for (const old of keys.slice(0, keys.length - 500)) delete state.clients[old];
    saveSoon();
  }
  // Failures are SERIALISED and delayed (bounded queue): a flood slows the flooder, never the operator, because valid
  // credentials never enter this path. Beyond the queue bound a failure is refused at once, without a delay.
  let failChain = Promise.resolve(); let failWaiting = 0;
  async function penalise(ip) {
    recordFail(ip);
    if (failDelayMs <= 0 || failWaiting >= MAX_FAIL_QUEUE) return;
    failWaiting++;
    const fails = state.clients[clientKey(ip)]?.fails ?? 1;
    const delay = Math.min(failDelayMs * 2 ** Math.min(fails - 1, 3), 2000);
    const mine = failChain.then(() => sleep(delay));
    failChain = mine.catch(() => {});
    try { await mine; } finally { failWaiting--; }
  }
  async function success(ip) {
    const k = clientKey(ip); if (state.clients[k]) state.clients[k] = { fails: 0, until: 0 };
    state.global = { fails: 0, until: 0 };
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
    reset, clearLocks, flush,
    totpBase32: () => (configured ? totpBase32(seed) : null),
    checkPassword: (given) => configured && constantTimeEqual(given ?? '', password),

    // Single-use pre-login form tokens (login CSRF).
    issuePre() { reap(); if (pre.size >= MAX_PRE_TOKENS) pre.delete(pre.keys().next().value); const id = unique(); pre.set(id, now() + SESSION_IDLE_MS); return id; },
    consumePre(id) { reap(); const ok = typeof id === 'string' && pre.has(id); if (ok) pre.delete(id); return ok; },

    // -> { ok:true, session } | { ok:false, status:401|429|503 }.  Uniform failure for password/code/format.
    // Valid credentials (password + a code newer than any accepted one) are NEVER refused because of a lock/counter.
    async login({ password: pw, code, ip }) {
      await load();
      if (!configured) return { ok: false, status: 503 };
      if (broken) return { ok: false, status: 503, broken };
      const pwOk = constantTimeEqual(pw ?? '', password);                // always evaluate both factors
      const step = matchTotp(secret, code, now());
      if (pwOk && step !== null && step > state.last_step) {
        state.last_step = step; await success(ip); await save();
        reap();
        if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
        const id = unique(); const s = { id, csrf: unique(), created: now(), last: now(), short: createHash('sha256').update(id).digest('hex').slice(0, 8) };
        sessions.set(id, s);
        return { ok: true, session: s };
      }
      if (lockedUntil(ip) > now()) return { ok: false, status: 429 };    // invalid + locked: cheap refusal, not counted again
      await penalise(ip); return { ok: false, status: 401 };
    },
    // Password-only proof used by /enroll (no session is created, nothing but the setup key is revealed).
    async verifyPasswordOnly({ password: pw, ip }) {
      await load();
      if (!configured) return { ok: false, status: 503 };
      if (constantTimeEqual(pw ?? '', password)) return { ok: true };
      if (lockedUntil(ip) > now()) return { ok: false, status: 429 };
      await penalise(ip); return { ok: false, status: 401 };
    },
    session(id) {
      reap();
      const s = typeof id === 'string' ? sessions.get(id) : undefined;
      if (!s) return null;
      s.last = now(); return s;
    },
    logout(id) { sessions.delete(id); },
    // Fresh code required for an action. The code must be newer than any code ever accepted. A valid fresh code is never refused by a lock.
    async stepUp({ ip, code }) {
      await load();
      if (!configured || broken) return { ok: false, status: 503 };
      const step = matchTotp(secret, code, now());
      if (step !== null && step > state.last_step) { state.last_step = step; await success(ip); await save(); return { ok: true, step }; }
      if (lockedUntil(ip) > now()) return { ok: false, status: 429 };
      await penalise(ip); return { ok: false, status: 401 };
    },
    sessionCount: () => sessions.size,
    _state: () => state,
  };
}
export async function removeStateFile(stateDir) { await rm(join(stateDir, 'operator-state.json'), { force: true }); }
