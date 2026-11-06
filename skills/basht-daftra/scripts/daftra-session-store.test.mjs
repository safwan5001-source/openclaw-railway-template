// Encrypted-at-rest storage of the operator's pasted Daftra session. All values are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCookieInput, createSessionStore, SESSION_STATUS } from './daftra-session-store.mjs';

const SECRET = 'approval-hmac-secret-0123456789-0123456789-abcdef';
const VALUE = 'abc123DEF456ghi789JKL012mno345';
const dir = async () => mkdtemp(join(tmpdir(), 'basht-session-'));

test('parseCookieInput accepts a bare value, name=value, a Cookie header and several cookies; rejects the rest without echoing input', () => {
  assert.deepEqual(parseCookieInput(VALUE), { ok: true, pairs: [['OISystem', VALUE]] });
  assert.deepEqual(parseCookieInput('OISystem=' + VALUE).pairs, [['OISystem', VALUE]]);
  assert.deepEqual(parseCookieInput('Cookie: OISystem=' + VALUE + '; lang=ar; OISystem="' + VALUE + 'X"').pairs, [['OISystem', VALUE + 'X'], ['lang', 'ar']]);
  assert.deepEqual(parseCookieInput('a=b=c==').pairs, [['a', 'b=c==']]);
  for (const bad of ['', '   ', null, undefined, 42, 'a b c=d e', 'bad name=1', 'x=y\r\nSet-Cookie: z=1', 'x=a,b', 'x=' + 'a'.repeat(2049), 'x=\u0000', ';;;', '=novalue', Array.from({ length: 13 }, (_, i) => 'c' + i + '=v').join('; ')]) {
    const r = parseCookieInput(bad);
    assert.equal(r.ok, false, JSON.stringify(bad)?.slice(0, 40));
    assert.equal(typeof r.error, 'string');
    if (typeof bad === 'string' && bad.length > 4) assert.equal(r.error.includes(bad.slice(0, 8)), false, 'the error never echoes the input');
  }
});

test('the session is encrypted at rest (AES-GCM), mode 0600, and unreadable with another secret or after tampering', async () => {
  const d = await dir();
  try {
    const store = createSessionStore({ dir: d, secret: SECRET });
    assert.equal((await store.status()).state, SESSION_STATUS.none);
    assert.equal(await store.cookieHeader(), null);
    await store.save(parseCookieInput('OISystem=' + VALUE + '; lang=ar').pairs);
    assert.equal(await store.cookieHeader(), 'OISystem=' + VALUE + '; lang=ar');
    const raw = await readFile(store.path, 'utf8');
    for (const leak of [VALUE, 'OISystem', 'lang']) assert.equal(raw.includes(leak), false, leak);
    assert.equal(((await stat(store.path)).mode & 0o777), 0o600);
    assert.deepEqual((await readdir(d)).filter((n) => n.endsWith('.tmp')), [], 'no temp file is left behind');
    // another process (same secret) sees it; a different secret or a flipped byte sees nothing
    assert.equal(await createSessionStore({ dir: d, secret: SECRET }).cookieHeader(), 'OISystem=' + VALUE + '; lang=ar');
    assert.equal(await createSessionStore({ dir: d, secret: SECRET + 'x' }).cookieHeader(), null);
    const f = JSON.parse(raw); f.ct = Buffer.from(Buffer.from(f.ct, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64');
    await writeFile(store.path, JSON.stringify(f));
    const tampered = createSessionStore({ dir: d, secret: SECRET });
    assert.equal(await tampered.cookieHeader(), null);
    assert.deepEqual(await tampered.status(), { state: SESSION_STATUS.none, corrupt: true });
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('status never contains the cookie; expired sessions are not handed out; saving again reconnects; clear deletes', async () => {
  const d = await dir(); let t = Date.UTC(2026, 10, 6, 12);
  try {
    const store = createSessionStore({ dir: d, secret: SECRET, now: () => t });
    await store.save([['OISystem', VALUE]]);
    await store.markOk();
    let st = await store.status();
    assert.equal(st.state, SESSION_STATUS.connected); assert.equal(st.cookie_count, 1); assert.ok(st.last_ok_at);
    assert.equal(JSON.stringify(st).includes(VALUE), false);
    t += 60_000; await store.markExpired();
    st = await store.status(); assert.equal(st.state, SESSION_STATUS.expired); assert.ok(st.last_failure_at);
    assert.equal(await store.cookieHeader(), null, 'an expired session is never sent');
    assert.deepEqual(await store.secretValues(), [VALUE], 'values stay available for log scrubbing');
    await store.save([['OISystem', VALUE + '2']]);
    assert.equal((await store.status()).state, SESSION_STATUS.connected);
    await store.clear();
    assert.equal((await store.status()).state, SESSION_STATUS.none);
    await assert.rejects(stat(store.path));
    await store.clear();                                      // idempotent
  } finally { await rm(d, { recursive: true, force: true }); }
});

test('a symlinked session file is refused (treated as not connected), and a short secret is refused', async () => {
  const d = await dir();
  try {
    await writeFile(join(d, 'real.json'), '{}');
    await symlink(join(d, 'real.json'), join(d, 'daftra-session.json'));
    await assert.rejects(createSessionStore({ dir: d, secret: SECRET }).status(), /regular file/);
    assert.throws(() => createSessionStore({ dir: d, secret: 'short' }), /approval secret/);
  } finally { await rm(d, { recursive: true, force: true }); }
});
