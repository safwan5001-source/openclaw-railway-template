// Tests that pin the independent-review findings of the separate-service broker (audit amplification, store bounds, secret
// refusal, anonymous disclosure, connection limits, pre-auth limiter, edge-only console, enrollment, sticky I/O errors).
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { rename, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { startService, proposeInvoice, rawRequest, AGENT_TOKEN, OPERATOR_PASSWORD, PRIVATE_HOST, PUBLIC_HOST, invoiceInput, OP_SECRET, WRITE_KEY } from './daftra-broker-service.test-helper.mjs';
import { readAudit } from './daftra-broker-service.mjs';

const lines = async (c) => (await readFile(join(c.stateDir, 'audit.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
const blocked = (n) => ({ ...invoiceInput, client_id: 99999, notes: 'blocked ' + n });          // client 99999 does not exist -> BLOCKED
const ready = (n) => ({ ...invoiceInput, notes: 'ready ' + n });

test('REVIEW audit amplification: thousands of unauthenticated requests add O(1) audit lines and never slow the operator', async () => {
  const c = await startService({ env: { BROKER_PREAUTH_RPS: '100000' } });
  try {
    const r = await proposeInvoice(c); const id = r.json.result.proposal_id;
    const op = c.operator(); await op.login(); await op.proposalPage(id);
    const before = (await lines(c)).length;
    const N = 1500, batch = 50;
    for (let i = 0; i < N; i += batch) await Promise.all(Array.from({ length: batch }, (_, j) => (i + j) % 2
      ? rawRequest({ port: c.privatePort, method: 'POST', path: '/v1/status', headers: { Host: 'x' + (i + j) + '.example', 'Content-Type': 'application/json' }, body: '{}' })
      : rawRequest({ port: c.privatePort, method: 'POST', path: '/v1/status', headers: { Host: PRIVATE_HOST, Authorization: 'Bearer wrong-' + (i + j), 'Content-Type': 'application/json' }, body: '{}' })));
    await c._flush?.();
    const t0 = Date.now();
    const d = await op.decide(id, 'approve', { code: c.freshCode() });
    assert.equal(d.status, 200); assert.ok(Date.now() - t0 < 2000, 'approval is not queued behind the flood');
    await c.service._flushAggregates();
    const added = (await lines(c)).length - before;
    assert.ok(added <= 12, 'audit grew by ' + added + ' lines for ' + N + ' hostile requests');
    assert.equal(c.fake.posts.length, 1);
    const audit = await readAudit({ stateDir: c.stateDir, secret: OP_SECRET });              // the chain is still valid
    const total = audit.filter((a) => a.event === 'unauth_summary').reduce((s, a) => s + Object.values(a.counts).reduce((x, y) => x + y, 0), 0);
    assert.ok(total >= N - 100, 'the flood is counted, not lost (' + total + ')');
  } finally { await c.stop(); }
});

test('REVIEW pre-auth limiter protects BOTH listeners (429 without touching auth, audit or state)', async () => {
  const c = await startService({ env: { BROKER_PREAUTH_RPS: '2' } });
  try {
    const burst = async (port, host, path) => {
      const out = await Promise.all(Array.from({ length: 60 }, () => rawRequest({ port, method: 'GET', path, headers: { Host: host } })));
      return out.map((x) => x.status);
    };
    const pub = await burst(c.publicPort, '127.0.0.1:' + c.publicPort, '/');
    const prv = await burst(c.privatePort, PRIVATE_HOST, '/v1/status');
    assert.ok(pub.filter((s) => s === 429).length >= 30, 'public listener sheds load: ' + pub.filter((s) => s === 429).length);
    assert.ok(prv.filter((s) => s === 429).length >= 30, 'private listener sheds load: ' + prv.filter((s) => s === 429).length);
    assert.ok(pub.some((s) => s !== 429) && prv.some((s) => s !== 429));
  } finally { await c.stop(); }
});

test('REVIEW store bounds: BLOCKED proposals count towards the store cap; pending proposals stay visible; expired ones are pruned from disk', async () => {
  const clock = { t: Date.UTC(2026, 10, 6, 12, 0, 5) };
  const c = await startService({ clock, env: { BROKER_MAX_PROPOSALS: '5', BROKER_PROPOSE_PER_MIN: '1000', BROKER_RATE_PER_MIN: '1000', BROKER_MAX_PENDING: '3' } });
  try {
    const files = async () => (await readdir(join(c.stateDir, 'daftra-ledger', 'proposals')).catch(() => [])).length;
    const bl = [];
    for (let i = 0; i < 4; i++) { const r = await c.agent('/v1/propose', { type: 'sales_invoice', input: blocked(i), actor: 'bot' }); bl.push(r); }
    assert.ok(bl.every((r) => r.status === 200 && r.json.result.status === 'BLOCKED'), 'blocked proposals are persisted');
    const ok = await c.agent('/v1/propose', { type: 'sales_invoice', input: ready(1), actor: 'bot' });
    assert.equal(ok.status, 200); assert.equal(ok.json.result.status, 'READY_FOR_APPROVAL');
    const full = await c.agent('/v1/propose', { type: 'sales_invoice', input: ready(2), actor: 'bot' });
    assert.equal(full.status, 429); assert.equal(full.json.refused, 'STORE_FULL', 'BLOCKED proposals count: the cap is on all stored files');
    assert.equal(await files(), 5); assert.equal(c.service._indexSize(), 5);
    // the legitimate pending proposal is still listed first in the console, however many blocked ones exist
    const op = c.operator(); await op.login();
    const list = await op.request('GET', '/console');
    assert.ok(list.text.includes(ok.json.result.proposal_id), 'pending proposal is not hidden by the blocked ones');
    assert.ok(list.text.indexOf(ok.json.result.proposal_id) < list.text.indexOf(bl[0].json.result.proposal_id), 'pending first');
    // 20 minutes later (TTL 15 min + 5 min grace) the dead ones are removed from disk and memory; the cap frees up
    clock.t += 21 * 60_000; await c.service._prune();
    assert.equal(await files(), 0); assert.equal(c.service._indexSize(), 0); assert.equal(c.service._indexBytes(), 0);
    assert.equal((await c.agent('/v1/propose', { type: 'sales_invoice', input: ready(3), actor: 'bot' })).status, 200);
  } finally { await c.stop(); }
});

test('REVIEW byte cap: BROKER_MAX_BYTES stops the store from growing; one proposal is also capped for human review', async () => {
  const c = await startService({ env: { BROKER_MAX_BYTES: '9000', BROKER_PROPOSE_PER_MIN: '1000', BROKER_RATE_PER_MIN: '1000', BROKER_MAX_PENDING: '1000' } });
  try {
    let refused = null;
    for (let i = 0; i < 40 && !refused; i++) { const r = await c.agent('/v1/propose', { type: 'sales_invoice', input: ready(i), actor: 'bot' }); if (r.status !== 200) refused = r; }
    assert.ok(refused && refused.json.refused === 'STORE_FULL', 'the byte cap is enforced');
    assert.ok(c.service._indexBytes() < 9000 + 8000);
  } finally { await c.stop(); }
  const big = await startService();
  try {
    const items = Array.from({ length: 100 }, () => ({ item: 'x'.repeat(300), description: 'd'.repeat(2000), quantity: '1', unit_price: '1', tax1: 1 }));
    const r = await big.agent('/v1/propose', { type: 'sales_invoice', input: { client_id: 4, date: '2025-03-01', items }, actor: 'bot' });
    assert.ok([400, 413].includes(r.status), 'status ' + r.status);
    assert.equal(await readdir(join(big.stateDir, 'daftra-ledger', 'proposals')).then((x) => x.length).catch(() => 0), 0, 'nothing was stored');
  } finally { await big.stop(); }
});

test('REVIEW display=sent: a proposal containing any broker secret (agent token, write key, approval secret, operator password) is refused, not scrubbed', async () => {
  const c = await startService();
  try {
    for (const secret of [AGENT_TOKEN, WRITE_KEY, OP_SECRET, OPERATOR_PASSWORD]) {
      const r = await c.agent('/v1/propose', { type: 'sales_invoice', input: { ...invoiceInput, items: [{ item: 'Diesel ' + secret + ' premium', quantity: '1', unit_price: '2', tax1: 1 }] }, actor: 'bot' });
      assert.equal(r.status, 400); assert.equal(r.json.refused, 'SECRET_IN_REQUEST');
      assert.equal(r.text.includes(secret), false);
    }
    assert.equal(c.service._indexSize(), 0, 'nothing stored');
    assert.equal(c.fake.posts.length, 0);
  } finally { await c.stop(); }
});

test('REVIEW declined memory: after the operator rejects a request the identical request cannot be re-presented as READY', async () => {
  const c = await startService({ env: { BROKER_PROPOSE_PER_MIN: '100' } });
  try {
    const op = c.operator(); await op.login();
    const first = await proposeInvoice(c); const id = first.json.result.proposal_id;
    await op.proposalPage(id);
    assert.equal((await op.decide(id, 'reject', { code: c.freshCode() })).status, 200);
    for (let i = 0; i < 3; i++) {
      const again = await proposeInvoice(c);
      assert.equal(again.json.result.status, 'DECLINED', 'repeat of a declined request is not offered again');
      assert.match(String(again.json.result.next), /BLOCKED/);
    }
    const different = await proposeInvoice(c, { ...invoiceInput, notes: 'changed' });
    assert.equal(different.json.result.status, 'READY_FOR_APPROVAL', 'a genuinely different request is fine');
    assert.equal(c.fake.posts.length, 0);
  } finally { await c.stop(); }
});

test('REVIEW anonymous disclosure: the unauthenticated pages never show exposure alarms, config state or hints; the operator sees them after login', async () => {
  const c = await startService({ env: { DAFTRA_WRITES_ENABLED: undefined } });
  try {
    await rawRequest({ port: c.privatePort, method: 'POST', path: '/v1/status', headers: { Host: PUBLIC_HOST, 'X-Forwarded-For': '203.0.113.9', 'Content-Type': 'application/json' }, body: '{}' });
    const anon = c.operator();
    for (const p of ['/', '/login', '/console', '/enroll', '/proposal/prop_0123456789abcdef', '/nothing']) {
      const r = await anon.request('GET', p);
      assert.equal(/PRIVATE API REACHABLE|Writes are DISABLED|DAFTRA_WRITES_ENABLED|not configured|BROKER_|OPERATOR_|railway/i.test(r.text), false, p + ' discloses configuration');
    }
    const op = c.operator(); await op.login();
    const page = await op.request('GET', '/console');
    assert.match(page.text, /PRIVATE API REACHABLE|Writes are DISABLED/, 'the authenticated operator DOES see the banners');
  } finally { await c.stop(); }
  const off = await startService({ env: { OPERATOR_PASSWORD: undefined } });
  try {
    const r = await off.operator().request('GET', '/');
    assert.equal(/OPERATOR_PASSWORD|not configured|DAFTRA_|BROKER_/i.test(r.text), false, 'an unconfigured service says only "unavailable"');
  } finally { await off.stop(); }
});

test('REVIEW connection limits: one keep-alive socket is served at most maxRequestsPerSocket requests', async () => {
  const c = await startService({ env: { BROKER_PREAUTH_RPS: '100000' } });
  try {
    const answered = await new Promise((ok) => {
      const s = net.connect(c.privatePort, '127.0.0.1'); let out = ''; s.on('error', () => {}); s.on('data', (d) => { out += d; });
      for (let i = 0; i < 300; i++) s.write('POST /v1/status HTTP/1.1\r\nHost: ' + PRIVATE_HOST + '\r\nContent-Length: 2\r\nContent-Type: application/json\r\n\r\n{}');
      setTimeout(() => { s.destroy(); ok(out); }, 1500);
    });
    const statuses = (answered.match(/HTTP\/1\.1 (\d{3})/g) || []).map((x) => x.slice(9));
    const served = statuses.filter((s) => s !== '503').length;
    assert.ok(served <= 100, 'served ' + served + ' requests on one socket');
    assert.ok(statuses.length < 300 || statuses.includes('503'));
  } finally { await c.stop(); }
});

test('REVIEW enrollment shows the authenticator key ONCE per process start, then disables itself', async () => {
  const c = await startService({ env: { OPERATOR_ENROLLMENT: '1' } });
  try {
    const op = c.operator();
    const show = async () => {
      const pre = /name="pre" value="([^"]+)"/.exec((await op.request('GET', '/enroll')).text)?.[1];
      return pre ? op.request('POST', '/enroll', { form: { pre, password: OPERATOR_PASSWORD } }) : { status: 404, text: '' };
    };
    // two forms are fetched BEFORE either is submitted: only the first submission may display the key
    const pres = []; for (let i = 0; i < 2; i++) pres.push(/name="pre" value="([^"]+)"/.exec((await op.request('GET', '/enroll')).text)?.[1]);
    assert.ok(pres[0] && pres[1]);
    assert.equal((await op.request('POST', '/enroll', { form: { pre: pres[0], password: OPERATOR_PASSWORD } })).status, 200);
    assert.equal((await op.request('POST', '/enroll', { form: { pre: pres[1], password: OPERATOR_PASSWORD } })).status, 404, 'second display refused even with an already-issued form');
    assert.equal((await op.request('GET', '/enroll')).status, 404);
    void show;
  } finally { await c.stop(); }
});

test('REVIEW BROKER_CONSOLE_REQUIRE_EDGE=1: the console is served only to requests that came through the public edge', async () => {
  const c = await startService({ env: { BROKER_CONSOLE_REQUIRE_EDGE: '1' } });
  try {
    const op = c.operator();
    assert.equal((await op.request('GET', '/')).status, 404, 'no edge header (e.g. from the private network) -> uniform 404');
    const via = await op.request('GET', '/', { headers: { 'X-Forwarded-For': '198.51.100.7', 'X-Railway-Edge': 'railway/europe-west4' } });
    assert.equal(via.status, 200);
    const off = await startService();
    try { assert.equal((await off.operator().request('GET', '/')).status, 200, 'default: reachable without edge headers'); } finally { await off.stop(); }
  } finally { await c.stop(); }
});

test('REVIEW sticky I/O: one transient failure of the state volume does not break the operator login/approval until restart', async () => {
  const c = await startService();
  try {
    const r0 = await proposeInvoice(c); const id = r0.json.result.proposal_id;
    const op = c.operator();
    await rename(c.stateDir, c.stateDir + '.away');
    const bad = await op.request('POST', '/login', { form: { pre: (await op.pre()).pre, password: 'wrong', code: '000000' }, cookie: null });
    assert.ok([401, 429, 500, 503].includes(bad.status));
    await rename(c.stateDir + '.away', c.stateDir);
    assert.equal((await op.login({ code: c.freshCode() })).status, 303, 'login works again once the volume is back');
    await op.proposalPage(id);
    assert.equal((await op.decide(id, 'approve', { code: c.freshCode() })).status, 200);
    assert.equal(c.fake.posts.length, 1);
    assert.ok((await stat(join(c.stateDir, 'operator-state.json'))).isFile());
  } finally { await c.stop(); }
});

test('REVIEW token hygiene: a too-short previous agent token fails closed and is never accepted', async () => {
  const c = await startService({ env: { BROKER_AGENT_TOKEN_PREVIOUS: 'abc' } });
  try {
    assert.equal((await c.agent('/v1/status', { id: 'prop_0123456789abcdef' }, { token: 'abc' })).status, 401, 'the weak token never authenticates');
    assert.equal((await c.agent('/v1/status', { id: 'prop_0123456789abcdef' })).status, 503, 'and the misconfigured service fails closed');
  } finally { await c.stop(); }
});
