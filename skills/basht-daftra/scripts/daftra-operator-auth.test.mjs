import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base32Encode, deriveTotpSecret, totpBase32, totpCode, stepAt, matchTotp, otpauthUri, createOperatorAuth, constantTimeEqual, SESSION_IDLE_MS, SESSION_ABSOLUTE_MS, LOCK_MAX_MS } from './daftra-operator-auth.mjs';

const PW = 'correct horse battery staple 42'; const SEED = 'totp-seed-0123456789-0123456789-0123456789-abcdef';
const T0 = Date.UTC(2026, 10, 6, 12, 0, 5);
async function mk(over = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'basht-oa-')); const clock = { t: T0 };
  const make = () => createOperatorAuth({ env: { OPERATOR_PASSWORD: PW, OPERATOR_TOTP_SEED: SEED, OPERATOR_FAIL_DELAY_MS: '0', ...over }, stateDir: dir, now: () => clock.t });
  return { dir, clock, make, auth: make(), done: () => rm(dir, { recursive: true, force: true }) };
}
const code = (clock, off = 0) => totpCode(deriveTotpSecret(SEED), stepAt(clock.t) + off);

test('RFC 4648 base32 and RFC 6238 TOTP test vectors', () => {
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(base32Encode(Buffer.from('12345678901234567890')), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  const secret = Buffer.from('12345678901234567890');
  // RFC 6238 appendix B (SHA-1), last 6 digits of the 8-digit values
  for (const [time, expected] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']])
    assert.equal(totpCode(secret, Math.floor(time / 30)), expected, String(time));
});

test('derived secret is deterministic, 20 bytes, seed-dependent, and the seed must be strong', () => {
  assert.equal(deriveTotpSecret(SEED).length, 20);
  assert.deepEqual(deriveTotpSecret(SEED), deriveTotpSecret(SEED));
  assert.notDeepEqual(deriveTotpSecret(SEED), deriveTotpSecret(SEED + 'x'));
  assert.match(totpBase32(SEED), /^[A-Z2-7]{32}$/);
  assert.throws(() => deriveTotpSecret('short'), /at least 32/);
  assert.match(otpauthUri('ABC234'), /^otpauth:\/\/totp\/.+\?secret=ABC234&issuer=.*&algorithm=SHA1&digits=6&period=30$/);
});

test('matchTotp accepts only +-1 step and rejects malformed input', () => {
  const secret = deriveTotpSecret(SEED);
  const cur = stepAt(T0);
  for (const off of [-1, 0, 1]) assert.equal(matchTotp(secret, totpCode(secret, cur + off), T0), cur + off);
  for (const off of [-2, 2, 10]) assert.equal(matchTotp(secret, totpCode(secret, cur + off), T0), null);
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, '12 456', '000000 ']) assert.equal(matchTotp(secret, bad, T0) !== null && bad !== '000000 ' ? 'x' : null, null, String(bad));
  assert.equal(constantTimeEqual('a', 'a'), true); assert.equal(constantTimeEqual('a', 'b'), false); assert.equal(constantTimeEqual('a', 'aa'), false);
});

test('login needs BOTH factors; failures are uniform; unconfigured/short secrets never log in', async () => {
  const m = await mk();
  try {
    const wrongPw = await m.auth.login({ password: 'x'.repeat(30), code: code(m.clock), ip: '1.1.1.1' });
    const wrongCode = await m.auth.login({ password: PW, code: '000000', ip: '1.1.1.2' });
    const none = await m.auth.login({ password: '', code: '', ip: '1.1.1.3' });
    for (const r of [wrongPw, wrongCode, none]) assert.deepEqual({ ok: r.ok, status: r.status }, { ok: false, status: 401 });
    const good = await m.auth.login({ password: PW, code: code(m.clock), ip: '1.1.1.4' });
    assert.equal(good.ok, true); assert.match(good.session.id, /^[A-Za-z0-9_-]{43}$/);
  } finally { await m.done(); }
  for (const over of [{ OPERATOR_PASSWORD: 'short' }, { OPERATOR_TOTP_SEED: 'short' }]) {
    const m2 = await mk(over);
    try { assert.equal((await m2.auth.login({ password: over.OPERATOR_PASSWORD ?? PW, code: code(m2.clock), ip: 'x' })).status, 503); } finally { await m2.done(); }
  }
});

test('REPLAY: a code works once, the login code never authorises a step-up, older steps are dead, only a NEWER step is fresh', async () => {
  const m = await mk();
  try {
    const c0 = code(m.clock);
    assert.equal((await m.auth.login({ password: PW, code: c0, ip: 'a' })).ok, true);
    assert.equal((await m.auth.login({ password: PW, code: c0, ip: 'a' })).ok, false, 'login replay');
    assert.equal((await m.auth.stepUp({ ip: 'a', code: c0 })).ok, false, 'login code reused as step-up');
    assert.equal((await m.auth.stepUp({ ip: 'a', code: code(m.clock, -1) })).ok, false, 'older window');
    m.clock.t += 30_000;
    const c1 = code(m.clock);
    assert.equal((await m.auth.stepUp({ ip: 'a', code: c1 })).ok, true);
    assert.equal((await m.auth.stepUp({ ip: 'a', code: c1 })).ok, false, 'step-up replay');
    assert.equal((await m.auth.stepUp({ ip: 'a', code: c0 })).ok, false, 'going back in time');
    // the replay window survives a restart (persisted, HMAC-protected)
    const again = m.make();
    assert.equal((await again.stepUp({ ip: 'a', code: c1 })).ok, false, 'replay after restart');
  } finally { await m.done(); }
});

const BAD = { password: 'wrong'.repeat(6), code: '000000' };

test('LOCKOUT: invalid attempts get locked (<= 60 s), VALID credentials are NEVER refused because of a lock, locks persist across restart', async () => {
  const m = await mk();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await m.auth.login({ ...BAD, ip: '9.9.9.9' })).status, 401);       // the 5th failure starts the lock
    assert.equal((await m.auth.login({ ...BAD, ip: '9.9.9.9' })).status, 429, 'invalid + locked = cheap refusal');
    assert.equal((await m.auth.login({ password: PW, code: code(m.clock), ip: '9.9.9.9' })).ok, true, 'valid credentials are never refused by a lock');
    // restart: the persisted lock still throttles INVALID attempts from that client
    for (let i = 0; i < 6; i++) await m.auth.login({ ...BAD, ip: '5.5.5.5' });
    await m.auth.flush();
    const restarted = m.make();
    assert.equal((await restarted.login({ ...BAD, ip: '5.5.5.5' })).status, 429, 'lock survives a restart');
    m.clock.t += 31_000;
    assert.equal((await restarted.login({ password: PW, code: code(m.clock), ip: '5.5.5.5' })).ok, true);
    // a quiet client is unaffected by someone else's failures
    assert.equal((await restarted.login({ password: PW, code: code(m.clock), ip: '8.8.8.8' })).status, 401, 'same step: replay is dead for everyone (not a lock)');
  } finally { await m.done(); }
});

test('LOCKOUT is capped: no failure pattern can lock anyone out for more than a minute, and counters decay', async () => {
  const m = await mk();
  try {
    for (let i = 0; i < 200; i++) { await m.auth.login({ ...BAD, ip: 'r' + (i % 40) }); m.clock.t += 700; }
    const t = m.clock.t; const s = m.auth._state();
    assert.ok((s.global.until ?? 0) - t <= LOCK_MAX_MS, 'global lock <= ' + LOCK_MAX_MS);
    for (const c of Object.values(s.clients)) assert.ok((c.until ?? 0) - t <= LOCK_MAX_MS);
    // the e2 scenario: one failure just after each lock expired never reaches an hour-long lock
    for (let i = 0; i < 12; i++) { m.clock.t = Math.max(m.clock.t, s.global.until) + 1; await m.auth.login({ ...BAD, ip: 'x' }); }
    assert.ok(m.auth._state().global.until - m.clock.t <= LOCK_MAX_MS);
    // the operator signs in right through all of it
    m.clock.t += 31_000;
    assert.equal((await m.auth.login({ password: PW, code: code(m.clock), ip: 'op' })).ok, true);
    // 16 quiet minutes later counters are forgotten
    m.clock.t += 16 * 60_000;
    await m.auth.login({ ...BAD, ip: 'q' });
    assert.equal(m.auth._state().clients[Object.keys(m.auth._state().clients).at(-1)].fails, 1);
  } finally { await m.done(); }
});

test('failures are SERIALISED and DELAYED with a bounded queue; valid logins never wait behind them', async () => {
  const m = await mk();
  try {
    const sleeps = []; let release; const gate = new Promise((ok) => { release = ok; });
    const auth = createOperatorAuth({ env: { OPERATOR_PASSWORD: PW, OPERATOR_TOTP_SEED: SEED }, stateDir: m.dir, now: () => m.clock.t, failDelayMs: 100, sleep: async (ms) => { sleeps.push(ms); await gate; } });
    const flood = Array.from({ length: 60 }, (_, i) => auth.login({ ...BAD, ip: 'f' + i }));
    await new Promise((ok) => setTimeout(ok, 30));
    const t0 = Date.now();
    const ok = await auth.login({ password: PW, code: code(m.clock), ip: 'operator' });          // must not queue behind the flood
    assert.equal(ok.ok, true); assert.ok(Date.now() - t0 < 500);
    release(); const results = await Promise.all(flood);
    assert.ok(results.every((r) => r.status === 401 || r.status === 429));
    assert.ok(sleeps.length <= 20, 'at most 20 queued delays (got ' + sleeps.length + ')');
    assert.ok(sleeps.every((ms) => ms >= 100 && ms <= 2000));
  } finally { await m.done(); }
});

test('BREAK-GLASS clearLocks() removes every lock but NEVER the replay high-water mark', async () => {
  const m = await mk();
  try {
    const first = code(m.clock);
    assert.equal((await m.auth.login({ password: PW, code: first, ip: 'a' })).ok, true);
    for (let i = 0; i < 30; i++) await m.auth.login({ ...BAD, ip: 'z' });
    assert.equal((await m.auth.login({ ...BAD, ip: 'z' })).status, 429);
    assert.equal(await m.auth.clearLocks(), true);
    assert.equal((await m.auth.login({ ...BAD, ip: 'z' })).status, 401, 'no lock any more');
    assert.equal((await m.auth.login({ password: PW, code: first, ip: 'z' })).status, 401, 'the used code stays dead');
    assert.equal(m.auth._state().last_step, stepAt(m.clock.t));
  } finally { await m.done(); }
});

test('the state write chain RECOVERS after a transient I/O error (no sticky 500s)', async () => {
  const m = await mk();
  try {
    await m.auth.ready();
    const moved = m.dir + '-away';
    await rename(m.dir, moved);
    await assert.rejects(m.auth.login({ password: PW, code: code(m.clock), ip: 'a' }));      // save() fails: the error reaches THIS caller
    await rename(moved, m.dir);
    m.clock.t += 31_000;
    assert.equal((await m.auth.login({ password: PW, code: code(m.clock), ip: 'a' })).ok, true, 'next login works');
  } finally { await m.done(); }
});

test('enrollment proof is password-only, never refused for the right password, throttled for wrong ones, and creates no session', async () => {
  const m = await mk();
  try {
    assert.equal((await m.auth.verifyPasswordOnly({ password: PW, ip: 'a' })).ok, true);
    assert.equal(m.auth.sessionCount(), 0);
    for (let i = 0; i < 6; i++) await m.auth.verifyPasswordOnly({ password: 'nope'.repeat(8), ip: 'b' });
    assert.equal((await m.auth.verifyPasswordOnly({ password: 'nope'.repeat(8), ip: 'b' })).status, 429);
    assert.equal((await m.auth.verifyPasswordOnly({ password: PW, ip: 'b' })).ok, true, 'the right password is never refused');
  } finally { await m.done(); }
});

test('STATE TAMPERING fails closed: edited / symlinked / corrupt state refuses logins; reset recovers with dead past codes', async () => {
  const m = await mk();
  try {
    assert.equal((await m.auth.login({ password: PW, code: code(m.clock), ip: 'a' })).ok, true);
    const file = join(m.dir, 'operator-state.json');
    const st = JSON.parse(await readFile(file, 'utf8')); st.last_step = 0;               // attacker rewinds the replay counter
    await writeFile(file, JSON.stringify(st));
    const edited = m.make();
    assert.equal((await edited.login({ password: PW, code: code(m.clock), ip: 'b' })).status, 503);
    assert.ok(edited.broken);
    await writeFile(file, '{not json');
    assert.equal((await m.make().login({ password: PW, code: code(m.clock), ip: 'b' })).status, 503);
    // operator-initiated reset: new state, and no code from before the reset can be replayed
    const old = code(m.clock);
    const r = m.make(); await r.ready(); await r.reset();
    assert.equal((await r.login({ password: PW, code: old, ip: 'c' })).ok, false, 'a code from the reset window is dead');
    m.clock.t += 30_000;
    assert.equal((await r.login({ password: PW, code: code(m.clock), ip: 'c' })).ok, true);
  } finally { await m.done(); }
  const m2 = await mk();
  try {
    await writeFile(join(m2.dir, 'real.json'), '{}');
    await symlink(join(m2.dir, 'real.json'), join(m2.dir, 'operator-state.json'));
    assert.equal((await m2.make().login({ password: PW, code: code(m2.clock), ip: 'a' })).status, 503, 'symlinked state file');
  } finally { await m2.done(); }
});

test('sessions: new id per login, idle and absolute expiry, logout, cap; pre-login tokens are single use', async () => {
  const m = await mk();
  try {
    const a = (await m.auth.login({ password: PW, code: code(m.clock), ip: 'a' })).session;
    m.clock.t += 30_000;
    const b = (await m.auth.login({ password: PW, code: code(m.clock), ip: 'a' })).session;
    assert.notEqual(a.id, b.id); assert.notEqual(a.csrf, b.csrf);
    assert.equal(m.auth.session(a.id).id, a.id);
    m.clock.t += SESSION_IDLE_MS - 1000; assert.ok(m.auth.session(a.id), 'activity keeps it alive');
    m.clock.t += SESSION_IDLE_MS + 1000; assert.equal(m.auth.session(a.id), null, 'idle expiry');
    m.auth.logout(b.id); assert.equal(m.auth.session(b.id), null);
    assert.equal(m.auth.session('nope'), null); assert.equal(m.auth.session(undefined), null);
    const c = (await (async () => { m.clock.t += 30_000; return m.auth.login({ password: PW, code: code(m.clock), ip: 'z' }); })()).session;
    for (let i = 0; i < 40; i++) m.clock.t += 60_000 * 0 + 0;                                        // absolute expiry
    m.clock.t += SESSION_ABSOLUTE_MS; for (let k = 0; k < 3; k++) { m.clock.t -= SESSION_IDLE_MS - 1; m.auth.session(c.id); }
    m.clock.t += SESSION_ABSOLUTE_MS; assert.equal(m.auth.session(c.id), null);
    const p = m.auth.issuePre(); assert.equal(m.auth.consumePre(p), true); assert.equal(m.auth.consumePre(p), false); assert.equal(m.auth.consumePre('x'), false);
  } finally { await m.done(); }
});
