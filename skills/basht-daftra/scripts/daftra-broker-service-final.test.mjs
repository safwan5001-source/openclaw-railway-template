// Regression tests for the FINAL independent review (round 4) of the separate-service broker. Loopback only, FakeDaftra, no network.
// F1 limiter starvation · F2 pre-auth token eviction · F3 login gate / lock semantics · F4 pending-cap & operator clean-up
// F5 audit/log flooding · F6 read-proxy memory/CPU bounds · F7 CLI fail-closed. Each test names the repro it replaces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FakeDaftra } from './daftra-fake.test-helper.mjs';
import { startService, proposeInvoice, rawRequest, invoiceInput, OPERATOR_PASSWORD, OP_SECRET, AGENT_TOKEN, ALL_SECRETS } from './daftra-broker-service.test-helper.mjs';
import { readAudit } from './daftra-broker-service.mjs';
import { ANON_EVAL_CAP, DEVICE_FAIL_CAP } from './daftra-operator-auth.mjs';
import { run } from './daftra-cli.mjs';
import { acquireLock } from './daftra-ledger.mjs';

// distinct loopback source addresses (127.0.0.0/8 is all local on Linux) = distinct "peers"
const from = (src, ctx, path = '/healthz', extra = {}) => rawRequest({ port: ctx.publicPort, path, localAddress: src, headers: { Host: 'x', Connection: 'close', ...extra } }).then((r) => r.status, () => 'err');
const WRONG = { password: 'w'.repeat(30), code: '000000' };
const badLogin = async (op, over = {}) => { const { pre } = await op.pre(); return op.request('POST', '/login', { form: { pre, ...WRONG, ...over }, cookie: null, device: null }); };

// ---- F1: limiter starvation -------------------------------------------------------------------------------------------------
test('F1 (starve): one flooding peer cannot starve the operator on another peer, and recovers instantly when the flood stops', async () => {
  const c = await startService();
  try {
    assert.equal(await from('127.0.0.9', c), 200);
    let stop = false, sent = 0;
    const attacker = (async () => { while (!stop) { await Promise.all(Array.from({ length: 40 }, () => from('127.0.0.5', c))); sent += 40; } })();
    const seen = {}; const t0 = Date.now();
    while (Date.now() - t0 < 1500) { const s = await from('127.0.0.9', c); seen[s] = (seen[s] ?? 0) + 1; await new Promise((r) => setTimeout(r, 100)); }
    stop = true; await attacker;
    assert.ok(sent > 500, 'the flood really happened (' + sent + ')');
    assert.deepEqual(Object.keys(seen), ['200'], 'operator on another peer was never limited: ' + JSON.stringify(seen));
    assert.equal(await from('127.0.0.9', c), 200);
  } finally { await c.stop(); }
});

test('F1 (global drain): many peers draining the ANONYMOUS global bucket do not lock out a logged-in session or the health check', async () => {
  const c = await startService({ env: { BROKER_PREAUTH_RPS: '5' } });          // per-peer burst 10, global burst 40
  try {
    const op = c.operator(); op.src = '127.0.0.9'; assert.equal((await op.login()).status, 303);
    const peers = Array.from({ length: 30 }, (_, i) => '127.0.0.' + (30 + i));
    const statuses = [];
    for (let r = 0; r < 3; r++) statuses.push(...await Promise.all(peers.map((p) => from(p, c, '/'))));
    assert.ok(statuses.includes(429), 'the anonymous global bucket really was drained');
    assert.equal((await op.request('GET', '/console')).status, 200, 'logged-in operator is served from its own session bucket');
    assert.equal(await from('127.0.0.77', c, '/healthz'), 200, 'health check is exempt from the drained global bucket');
  } finally { await c.stop(); }
});

test('F1 (samepeer): behind a trusted proxy every client has the same socket, but the limiter keys on the TRUSTED client address, so an attacker cannot starve other clients', async () => {
  const c = await startService({ env: { BROKER_TRUST_PROXY: '1' } });
  try {
    let stop = false;
    const attacker = (async () => { while (!stop) await Promise.all(Array.from({ length: 40 }, () => from(undefined, c, '/healthz', { 'X-Real-IP': '203.0.113.5' }))); })();
    const seen = {}; const t0 = Date.now();
    while (Date.now() - t0 < 1500) { const s = await from(undefined, c, '/healthz', { 'X-Real-IP': '198.51.100.9' }); seen[s] = (seen[s] ?? 0) + 1; await new Promise((r) => setTimeout(r, 100)); }
    stop = true; await attacker;
    assert.deepEqual(Object.keys(seen), ['200'], JSON.stringify(seen));
  } finally { await c.stop(); }
});

// ---- F2: pre-auth form tokens -----------------------------------------------------------------------------------------------
test('F2 (pre): 6,000 anonymous form tokens cannot evict the operator\'s token; it works exactly once and a replay fails', async () => {
  const c = await startService({ env: { BROKER_PREAUTH_RPS: '100000' } });
  try {
    const op = c.operator(); const { pre } = await op.pre();
    for (let i = 0; i < 6000; i++) c.service._auth.issuePre();                 // stateless: issuing consumes no server memory
    for (let i = 0; i < 5200; i++) assert.equal(c.service._auth.consumePre(c.service._auth.issuePre()), true);   // even consuming thousands...
    assert.equal(c.service._auth.consumePre(pre), true, 'the operator\'s token still works');
    assert.equal(c.service._auth.consumePre(pre), false, 'and only once');
    const fresh = c.service._auth.issuePre(); const flip = fresh.slice(0, -1) + (fresh.endsWith('A') ? 'B' : 'A');
    assert.equal(c.service._auth.consumePre('x.y.z'), false); assert.equal(c.service._auth.consumePre(flip), false, 'a token with a bad MAC is refused');
    assert.equal(c.service._auth.consumePre(fresh), true, '...and the genuine one was not burned by the forged attempt');
    const op2 = c.operator(); const t = (await op2.pre()).pre;
    assert.equal((await op2.login({ pre: t })).status, 303, 'end to end after the flood');
    c.clock.t += 11 * 60_000; assert.equal(c.service._auth.consumePre((() => { return pre; })()), false);
  } finally { await c.stop(); }
});

// ---- F3: login gate ---------------------------------------------------------------------------------------------------------
test('F3 (lock): a locked peer is refused BEFORE any credential is evaluated; the lock is never an oracle and never exceeds a minute', async () => {
  const c = await startService();
  try {
    const op = c.operator();
    for (let i = 0; i < 5; i++) assert.equal((await badLogin(op)).status, 401);
    const evaluated = c.service._auth._stats().evaluated;
    for (let i = 0; i < 30; i++) assert.equal((await badLogin(op, { code: String(100000 + i) })).status, 429);
    assert.equal((await op.login({ code: c.totp() })).status, 429, 'correct credentials from a locked peer are refused too');
    assert.equal(c.service._auth._stats().evaluated, evaluated, 'zero evaluations while locked');
    assert.ok(c.service._auth._state().clients && Object.values(c.service._auth._state().clients).every((r) => (r.until ?? 0) - c.clock.t <= 60_000));
  } finally { await c.stop(); }
});

test('F3 (lock2): attackers on many peers get at most ANON_EVAL_CAP evaluated guesses per minute IN TOTAL, then the next minute another ANON_EVAL_CAP', async () => {
  const c = await startService({ env: { BROKER_TRUST_PROXY: '1', BROKER_PREAUTH_RPS: '100000' } });
  try {
    const op = c.operator();
    const guess = async (ip, n) => { const { pre } = await op.pre(); return op.request('POST', '/login', { form: { pre, password: OPERATOR_PASSWORD, code: String(100000 + n) }, headers: { 'X-Real-IP': ip }, cookie: null, device: null }); };
    const before = c.service._auth._stats().evaluated;
    for (let n = 0; n < 120; n++) await guess('198.51.100.' + (n % 50), n);
    assert.ok(c.service._auth._stats().evaluated - before <= ANON_EVAL_CAP, 'evaluated=' + (c.service._auth._stats().evaluated - before));
    assert.ok(c.service._auth._stats().refused_cap > 0);
    c.clock.t += 61_000;
    const mid = c.service._auth._stats().evaluated;
    for (let n = 0; n < 120; n++) await guess('192.0.2.' + (n % 50), 500 + n);
    assert.ok(c.service._auth._stats().evaluated - mid <= ANON_EVAL_CAP);
  } finally { await c.stop(); }
});

test('F3 (device): the trusted-device cookie bypasses the attack gate for the operator, has its OWN failure cap if stolen, and is revoked by an epoch bump; forged cookies are just anonymous', async () => {
  const c = await startService({ env: { BROKER_PREAUTH_RPS: '100000' } });
  try {
    const dev = c.operator(); assert.equal((await dev.login()).status, 303);
    assert.match(dev.device, /^__Host-bdev=/);
    assert.equal(c.service._auth.deviceValid(dev.device.split('=')[1]), true);
    // an attack in progress: anonymous budget is exhausted
    const op = c.operator();
    for (let i = 0; i < 12; i++) await badLogin(op);
    assert.equal((await badLogin(op)).status, 429);
    // forged / truncated cookies count as anonymous (same TOTP window; the clock moves once so the code is valid and unspent)
    c.clock.t += 30_000;
    for (const forged of ['__Host-bdev=' + 'A'.repeat(60), '__Host-bdev=' + dev.device.split('=')[1].replace(/.$/, 'x'), '__Host-bdev=a.b.c.d']) {
      const f = c.operator(); f.device = forged;
      assert.equal((await f.login({ code: c.totp() })).status, 429, 'forged device cookie gets no bypass');
    }
    const t = c.operator(); t.device = dev.device;
    assert.equal((await t.login({ code: c.totp() })).status, 303, 'trusted device signs in during the attack');
    assert.ok(!t.device || t.device === dev.device, 'device is not re-minted for a device that presented one');
    // stolen cookie + wrong secrets: capped
    c.clock.t += 61_000;
    const stolen = c.operator(); stolen.device = dev.device;
    const codes = []; for (let i = 0; i < DEVICE_FAIL_CAP + 5; i++) codes.push((await stolen.login({ password: 'w'.repeat(30), code: '000000' })).status);
    assert.equal(codes.filter((x) => x === 401).length, DEVICE_FAIL_CAP, 'a stolen cookie buys at most DEVICE_FAIL_CAP guesses: ' + codes);
    assert.equal(codes.at(-1), 429);
    // epoch bump (break-glass reset) invalidates every previously issued cookie
    await c.service._auth.reset();
    assert.equal(c.service._auth.deviceValid(dev.device.split('=')[1]), false);
  } finally { await c.stop(); }
});

test('F3 (enroll): while the gate refuses a peer, the enrollment key is not revealed and the password is not evaluated', async () => {
  const c = await startService({ env: { OPERATOR_ENROLL: '1' } });
  try {
    const op = c.operator();
    for (let i = 0; i < 5; i++) await badLogin(op);
    const evaluated = c.service._auth._stats().evaluated;
    const e = await op.request('POST', '/enroll', { form: { pre: (await op.pre()).pre, password: OPERATOR_PASSWORD }, cookie: null });
    assert.ok([404, 429, 400].includes(e.status), 'enroll status ' + e.status);
    assert.equal(e.text.includes(c.env.OPERATOR_TOTP_SEED), false);
    assert.equal(c.service._auth._stats().evaluated, evaluated);
  } finally { await c.stop(); }
});

// ---- F4: pending cap, reject without TOTP, reject-all ------------------------------------------------------------------------
test('F4 (cap): junk proposals fill the pending cap -> the operator clears them with reject (NO TOTP needed) and reject-all, show/status still work while capped, and the real proposal then goes through', async () => {
  const c = await startService({ env: { BROKER_PREAUTH_RPS: '100000' } });
  try {
    const ids = [];
    for (let i = 0; i < 20; i++) {
      if (i && i % 10 === 0) c.clock.t += 61_000;
      const r = await c.agent('/v1/propose', { type: 'sales_invoice', input: { ...invoiceInput, notes: 'junk ' + i }, actor: 'a' });
      assert.equal(r.status, 200, 'propose ' + i); ids.push(r.json.result.proposal_id);
    }
    c.clock.t += 61_000;
    const real = await c.agent('/v1/propose', { type: 'sales_invoice', input: { ...invoiceInput, notes: 'REAL' }, actor: 'a' });
    assert.equal(real.status, 429); assert.equal(real.json.refused, 'PENDING_CAP');
    assert.equal((await c.agent('/v1/show', { id: ids[0] })).status, 200, 'show is not blocked by the cap');
    assert.equal((await c.agent('/v1/status', { id: ids[0] })).status, 200, 'status is not blocked by the cap');
    const op = c.operator(); assert.equal((await op.login({ code: c.freshCode() })).status, 303);
    // newest first: the console lists the NEWEST pending proposal first
    const page = (await op.request('GET', '/console')).text;
    assert.ok(page.indexOf(ids[19]) !== -1 && page.indexOf(ids[19]) < page.indexOf(ids[0]), 'newest pending is listed first');
    // reject needs session + csrf + hash only: four rejects inside ONE TOTP window, with no code field at all
    for (const id of ids.slice(0, 4)) {
      await op.proposalPage(id);
      const r = await op.request('POST', `/proposal/${id}/reject`, { form: { csrf: op.csrf, hash: op.hash } });
      assert.match(r.text, /Rejected/, id);
    }
    assert.equal((await op.request('POST', `/proposal/${ids[4]}/reject`, { form: { csrf: 'bad', hash: op.hash } })).status, 403, 'reject still needs CSRF');
    assert.equal(c.fake.posts.length, 0, 'nothing was ever sent');
    // reject ALL: session + csrf only
    await op.refreshCsrf();
    assert.equal((await op.request('POST', '/console/reject_all', { form: { csrf: 'bad' } })).status, 403);
    assert.equal((await op.request('POST', '/console/reject_all', { form: { csrf: op.csrf }, origin: 'http://evil.example' })).status, 403);
    assert.equal((await op.request('GET', '/console/reject_all')).status, 405);
    assert.equal((await op.request('POST', '/console/reject_all', { form: { csrf: op.csrf }, cookie: null })).status, 303, 'no session -> login');
    const all = await op.request('POST', '/console/reject_all', { form: { csrf: op.csrf } });
    assert.match(all.text, /Rejected 16/);
    assert.equal(c.service._pendingCount(), 0);
    for (const id of ids) assert.equal((await c.agent('/v1/status', { id })).json.result.outcome, 'declined_by_operator');
    const real2 = await c.agent('/v1/propose', { type: 'sales_invoice', input: { ...invoiceInput, notes: 'REAL' }, actor: 'a' });
    assert.equal(real2.status, 200, 'the real proposal is accepted again');
    const audit = await readAudit({ stateDir: c.stateDir, secret: OP_SECRET });
    assert.equal(audit.find((e) => e.event === 'operator_reject_all')?.count, 16);
    assert.equal(c.fake.posts.length, 0);
  } finally { await c.stop(); }
});

test('F4 (step-up): approve still needs a fresh TOTP; wrong codes send nothing; the 5th wrong step-up revokes the session', async () => {
  const c = await startService();
  try {
    const id = (await proposeInvoice(c)).json.result.proposal_id;
    const op = c.operator(); await op.login(); await op.proposalPage(id);
    const approve = (code) => op.request('POST', `/proposal/${id}/approve`, { form: { csrf: op.csrf, hash: op.hash, ...(code === undefined ? {} : { code }) } });
    assert.notEqual((await approve()).status, 200); assert.equal(c.fake.posts.length, 0, 'no code -> nothing sent');
    assert.notEqual((await approve('000000')).status, 200); assert.equal(c.fake.posts.length, 0, 'wrong code -> nothing sent');
    assert.match((await approve(c.freshCode())).text, /submitted/);
    assert.equal(c.fake.posts.length, 1, 'a fresh valid code approves exactly once');
    // revocation after repeated wrong step-ups
    const id2 = (await proposeInvoice(c, { ...invoiceInput, notes: 'second' })).json.result.proposal_id;
    await op.proposalPage(id2);
    const bad = (code) => op.request('POST', `/proposal/${id2}/approve`, { form: { csrf: op.csrf, hash: op.hash, code } });
    const seen = []; for (let i = 0; i < 5; i++) seen.push((await bad('00000' + i)).status);
    assert.equal((await op.request('GET', '/console')).status, 303, 'the session is already dead after the 5th wrong step-up code: ' + seen);
    assert.equal(c.fake.posts.length, 1);
  } finally { await c.stop(); }
});

test('F4 (claim): reject-all skips a proposal whose claim lock is held (an approval in flight is never overwritten)', async () => {
  const c = await startService();
  try {
    const a = (await proposeInvoice(c)).json.result.proposal_id;
    const b = (await proposeInvoice(c, { ...invoiceInput, notes: 'other' })).json.result.proposal_id;
    assert.ok(await acquireLock(c.service._brokerEnv, a + '.claim'), 'simulate an approval that already claimed proposal a');
    const op = c.operator(); await op.login();
    const r = await op.request('POST', '/console/reject_all', { form: { csrf: op.csrf } });
    assert.match(r.text, /Rejected 1 /);
    assert.equal((await c.agent('/v1/status', { id: a })).json.result.outcome, 'pending_operator_approval', 'the claimed proposal was left alone');
    assert.equal((await c.agent('/v1/status', { id: b })).json.result.outcome, 'declined_by_operator');
  } finally { await c.stop(); }
});

test('F4 (device step-up): a trusted phone can still approve while an attacker has locked its (shared) address; the same session without the device cookie cannot', async () => {
  const c = await startService({ env: { BROKER_PREAUTH_RPS: '100000' } });
  try {
    const id = (await proposeInvoice(c)).json.result.proposal_id;
    const op = c.operator(); assert.equal((await op.login()).status, 303); await op.proposalPage(id);
    const attacker = c.operator();
    for (let i = 0; i < 6; i++) await badLogin(attacker);                     // same peer address -> the address is now locked
    const without = await op.request('POST', `/proposal/${id}/approve`, { form: { csrf: op.csrf, hash: op.hash, code: c.totp(1) }, device: null });
    assert.equal(without.status, 429, 'locked address, no device cookie -> refused before evaluation');
    assert.equal(c.fake.posts.length, 0);
    const withDevice = await op.request('POST', `/proposal/${id}/approve`, { form: { csrf: op.csrf, hash: op.hash, code: c.totp(1) } });
    assert.match(withDevice.text, /submitted/, 'the trusted phone approves'); assert.equal(c.fake.posts.length, 1);
  } finally { await c.stop(); }
});

test('F1 (coarse): rotating valid X-Real-IP values from ONE socket cannot dodge the limiter (per-socket bucket)', async () => {
  const c = await startService({ env: { BROKER_TRUST_PROXY: '1', BROKER_PREAUTH_RPS: '2' } });         // coarse bucket: 20/s, burst 40
  try {
    const statuses = [];
    for (let i = 0; i < 150; i++) statuses.push(await from(undefined, c, '/healthz', { 'X-Real-IP': '198.51.100.' + (i % 250) }));
    const ok = statuses.filter((s) => s === 200).length;
    assert.ok(ok <= 80, 'at most the coarse burst + refill got through, got ' + ok);
    assert.ok(statuses.includes(429));
  } finally { await c.stop(); }
});

// ---- F5: audit and log flooding ---------------------------------------------------------------------------------------------
test('F5 (aud): unauthenticated noise becomes ONE summary per minute with top peers, written BEFORE the next login_ok; reads are counted per entity; no per-event stdout lines', async () => {
  const c = await startService({ env: { BROKER_PREAUTH_RPS: '100000' } });
  try {
    const op = c.operator();
    for (let i = 0; i < 6; i++) await badLogin(op);
    await c.agent('/v1/get', { path: '/api2/clients.json' });
    await c.agent('/v1/get', { path: '/api2/invoices/1.json' });
    await c.agent('/v1/status', { id: 'prop_0000000000000000' }, { token: 'x'.repeat(40) });
    c.clock.t += 61_000;
    assert.equal((await c.operator().login({ code: c.totp() })).status, 303);
    await c.service._flushAggregates();
    const a = await readAudit({ stateDir: c.stateDir, secret: OP_SECRET });
    const iSum = a.findIndex((e) => e.event === 'unauth_summary'); const iOk = a.findIndex((e) => e.event === 'login_ok');
    assert.ok(iSum !== -1 && iOk !== -1 && iSum < iOk, 'the summary precedes login_ok');
    const sum = a[iSum];
    assert.equal(sum.counts.login_failed, 6); assert.equal(sum.counts.agent_get, 2); assert.equal(sum.counts['agent_get:clients'], 1); assert.equal(sum.counts['agent_get:invoices'], 1); assert.equal(sum.counts.agent_auth_failed, 1);
    assert.ok(Array.isArray(sum.top_peers) && sum.top_peers.length >= 1 && sum.top_peers.length <= 5 && sum.top_peers.every((p) => typeof p.peer === 'string' && p.n > 0), JSON.stringify(sum.top_peers));
    assert.equal(a.filter((e) => e.event === 'login_failed').length, 0, 'no per-attempt audit lines for unauthenticated noise');
    assert.ok(c.logs.length < 12, 'stdout stays small: ' + c.logs.length);
    for (const l of c.logs) for (const s of ALL_SECRETS) assert.equal(String(l).includes(s), false);
  } finally { await c.stop(); }
});

test('F5 (aud2): a read burst writes one aggregated read log per minute, not one line per request', async () => {
  const c = await startService({ env: { BROKER_PREAUTH_RPS: '100000', BROKER_GET_PER_MIN: '100000' } });
  try {
    const before = c.logs.length;
    for (let i = 0; i < 40; i++) await c.agent('/v1/get', { path: '/api2/clients.json' });
    assert.ok(c.logs.length - before <= 2, 'logged lines during the burst: ' + (c.logs.length - before));
    c.clock.t += 61_000; await c.agent('/v1/get', { path: '/api2/clients.json' }); await c.service._flushAggregates();
    const readLine = c.logs.map(String).find((l) => /agent_reads/.test(l));
    assert.ok(readLine, 'an aggregated agent_reads line exists'); assert.match(readLine, /clients/);
  } finally { await c.stop(); }
});

// ---- F6: read-proxy memory / CPU bounds -------------------------------------------------------------------------------------
test('F6 (mem): a 15 MB upstream reply is refused with a clear error without long event-loop stalls; limit is clamped to 500 BEFORE going upstream', async () => {
  const fake = new FakeDaftra();
  const rows = []; let size = 0; let i = 0;
  while (size < 15.5 * 1024 * 1024) { rows.push({ Client: { id: i++, business_name: 'x'.repeat(200), notes: 'y'.repeat(300) } }); size += 560; }
  const big = JSON.stringify({ code: 200, data: rows, pagination: { page: 1, page_count: 1, total_results: rows.length } });
  const urls = [];
  fake.fetch = async (url) => { urls.push(String(url)); return new Response(big, { status: 200, headers: { 'content-type': 'application/json' } }); };
  const c = await startService({ fake, env: { BROKER_GET_PER_MIN: '100000', BROKER_PREAUTH_RPS: '100000' } });
  try {
    let maxLag = 0, last = Date.now(); const iv = setInterval(() => { const n = Date.now(); maxLag = Math.max(maxLag, n - last - 10); last = n; }, 10);
    const rs = await Promise.all(Array.from({ length: 8 }, () => c.agent('/v1/get', { path: '/api2/clients.json', query: { limit: 999999 } })));
    clearInterval(iv);
    for (const r of rs) { assert.ok(r.status >= 400 && r.status < 500, String(r.status)); assert.match(r.json.error, /too large/i); assert.ok(r.text.length < 300); }
    assert.ok(maxLag < 750, 'event-loop lag ' + maxLag + ' ms');
    assert.ok(urls.length > 0 && urls.every((u) => /[?&]limit=500(&|$)/.test(u)), 'upstream saw the clamped limit: ' + urls[0]);
    assert.ok(urls.every((u) => !u.includes('999999')));
  } finally { await c.stop(); }
});

test('F6 (mem2): concurrency to the upstream is bounded (default 2) so a sustained read flood cannot occupy the process', async () => {
  const fake = new FakeDaftra();
  let inflight = 0, peak = 0;
  fake.fetch = async () => { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 30)); inflight--; return new Response(JSON.stringify({ code: 200, data: [], pagination: { page: 1, page_count: 0, total_results: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const c = await startService({ fake, env: { BROKER_GET_PER_MIN: '100000', BROKER_PREAUTH_RPS: '100000' } });
  try {
    const rs = await Promise.all(Array.from({ length: 12 }, () => c.agent('/v1/get', { path: '/api2/clients.json' })));
    assert.ok(peak <= 2, 'peak upstream concurrency ' + peak);
    assert.ok(rs.some((r) => r.status === 200)); assert.ok(rs.every((r) => [200, 429, 503].includes(r.status)), rs.map((r) => r.status).join());
    assert.equal((await c.operator().pre()).r.status, 200, 'the console stayed responsive');
  } finally { await c.stop(); }
});

// ---- F7: agent CLI fails closed ---------------------------------------------------------------------------------------------
test('F7 (client): a half-configured service mode fails closed in BOTH directions; any Daftra credential on the agent is warned about', async () => {
  const base = { DAFTRA_BASE_URL: 'https://nepras.daftra.com' };
  const never = async () => { throw Error('network must not be touched'); };
  await assert.rejects(run(['list', 'clients'], { env: { ...base, DAFTRA_BROKER_URL: 'http://basht-broker.railway.internal:8081', DAFTRA_API_KEY: 'STRAY-aaaaaaaaaaaaaaaa' }, fetcher: never }), /Incomplete service-mode configuration/);
  await assert.rejects(run(['list', 'clients'], { env: { ...base, DAFTRA_BROKER_TOKEN: AGENT_TOKEN, DAFTRA_API_KEY: 'STRAY-aaaaaaaaaaaaaaaa' }, fetcher: never }), /Incomplete service-mode configuration/);
  const solo = await run(['capabilities'], { env: { ...base, DAFTRA_API_KEY: 'KEY-aaaaaaaaaaaaaaaaaa' } });
  assert.ok(solo.env_warnings.some((w) => /DAFTRA_API_KEY/.test(w) && /WRITE/.test(w)), JSON.stringify(solo.env_warnings));
  const stray = await run(['capabilities'], { env: { ...base, DAFTRA_WRITE_API_KEY: 'KEY-bbbbbbbbbbbbbbbbbb' } });
  assert.ok(stray.env_warnings.some((w) => /DAFTRA_WRITE_API_KEY/.test(w)));
  const none = await run(['capabilities'], { env: { ...base } });
  assert.equal(none.env_warnings.some((w) => /single-process mode/.test(w)), false);
});

test('F7 (client2): in service mode every read goes to the broker only, even with stray Daftra keys in the environment', async () => {
  const c = await startService({ env: { BROKER_ALLOW_LOOPBACK_HOST: '1' } });
  try {
    const direct = [];
    const fetcher = async (url) => { direct.push(String(url)); throw Error('the agent must not contact Daftra directly'); };
    const env = { DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_BROKER_URL: 'http://127.0.0.1:' + c.privatePort, DAFTRA_BROKER_TOKEN: AGENT_TOKEN, DAFTRA_BROKER_ALLOW_LOOPBACK: '1', DAFTRA_API_KEY: 'STRAYKEY-aaaaaaaaaaaa', DAFTRA_WRITE_API_KEY: 'STRAYWRITE-bbbbbbbbbbbb' };
    assert.equal((await run(['list', 'clients'], { env, fetcher })).ok, true);
    await run(['get', 'invoices', '5001'], { env, fetcher });
    assert.deepEqual(direct, [], 'no direct Daftra contact');
    assert.ok(c.fake.calls.length >= 2 && c.fake.calls.every((x) => x.method === 'GET'), 'the broker served them (GET only)');
    const seen = JSON.stringify(c.fake.calls); assert.equal(seen.includes('STRAYKEY'), false); assert.equal(seen.includes('STRAYWRITE'), false);
  } finally { await c.stop(); }
});
