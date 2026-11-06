import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeDaftra } from './daftra-fake.test-helper.mjs';
import { startService, proposeInvoice, ALL_SECRETS, AGENT_TOKEN, READ_KEY, WRITE_KEY, OP_SECRET, PRIVATE_HOST, invoiceInput } from './daftra-broker-service.test-helper.mjs';
import { readAudit } from './daftra-broker-service.mjs';
import { run } from './daftra-cli.mjs';

const noSecrets = (text, label) => { for (const s of ALL_SECRETS) assert.equal(String(text).includes(s), false, label + ' leaks a secret'); };

test('END TO END: agent proposes over the private API, operator approves in the console with a fresh TOTP, exactly ONE POST with the broker write key', async () => {
  const c = await startService();
  try {
    const p = await proposeInvoice(c);
    assert.equal(p.status, 200); assert.equal(p.json.result.status, 'READY_FOR_APPROVAL');
    const id = p.json.result.proposal_id;
    assert.equal(JSON.stringify(p.json).includes('APPROVE '), false, 'no phrase anywhere in the agent reply');
    assert.match(p.json.result.next, /Only the operator can approve/);
    assert.equal(c.fake.posts.length, 0);
    const s0 = await c.agent('/v1/status', { id });
    assert.equal(s0.json.result.outcome, 'pending_operator_approval');

    const op = c.operator();
    const login = await op.login();
    assert.equal(login.status, 303);
    assert.match(login.headers['set-cookie'][0], /^__Host-bsess=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    const page = await op.proposalPage(id);
    assert.equal(page.status, 200);
    assert.match(page.text, /\/api2\/invoices\.json/);
    assert.match(page.text, /APPROVE &amp; SEND/);
    // the login code cannot also authorise the approval (same step): a stale code is refused, a FRESH one works
    const reuse = await op.decide(id, 'approve', { code: c.totp() });
    assert.equal(reuse.status, 401);
    assert.equal(c.fake.posts.length, 0);
    const ok = await op.decide(id, 'approve');
    assert.equal(ok.status, 200); assert.match(ok.text, /submitted/);
    assert.equal(c.fake.posts.length, 1);
    assert.equal(c.fake.posts[0].path, '/api2/invoices.json');
    assert.equal(c.fake.posts[0].headers.APIKEY, WRITE_KEY);
    assert.ok(c.fake.calls.every((x) => x.headers.APIKEY === WRITE_KEY), 'every Daftra call used the broker key');
    const s1 = await c.agent('/v1/status', { id });
    assert.equal(s1.json.result.outcome, 'submitted'); assert.equal(s1.json.result.record_id, '5001');
    // audit + ledger exist, chain verifies, no secret anywhere on disk or in logs
    const audit = await readAudit({ stateDir: c.stateDir, secret: OP_SECRET });
    assert.ok(audit.some((a) => a.event === 'login_ok') && audit.some((a) => a.event === 'operator_approve') && audit.some((a) => a.event === 'approve_result'));
    for (const f of ['audit.jsonl', 'daftra-ledger/ledger.jsonl', 'operator-state.json']) noSecrets(await readFile(join(c.stateDir, f), 'utf8'), f);
    for (const f of await readdir(join(c.stateDir, 'daftra-ledger', 'proposals'))) noSecrets(await readFile(join(c.stateDir, 'daftra-ledger', 'proposals', f), 'utf8'), f);
    noSecrets(c.logs.join('\n'), 'stdout logs');
  } finally { await c.stop(); }
});

test('AGENT CLI in service mode: propose/show/status work, execute/resolve do not exist, capabilities warns about operator secrets', async () => {
  const c = await startService({ env: { BROKER_ALLOW_LOOPBACK_HOST: '1' } });
  try {
    const agentEnv = { DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: READ_KEY, DAFTRA_BROKER_URL: 'http://127.0.0.1:' + c.privatePort, DAFTRA_BROKER_TOKEN: AGENT_TOKEN, DAFTRA_BROKER_ALLOW_LOOPBACK: '1' };
    const p = await run(['propose', 'sales_invoice', '--input', JSON.stringify(invoiceInput), '--actor', 'bot'], { env: agentEnv, fetcher: async () => { throw Error('agent must not call Daftra for propose'); } });
    assert.equal(p.status, 'READY_FOR_APPROVAL');
    assert.equal(JSON.stringify(p).includes('APPROVE '), false);
    assert.equal((await run(['show', p.proposal_id], { env: agentEnv })).request_hash, p.request_hash);
    assert.equal((await run(['status', p.proposal_id], { env: agentEnv })).outcome, 'pending_operator_approval');
    for (const cmd of [['execute', p.proposal_id, '--phrase', 'APPROVE x'], ['resolve', p.proposal_id, '--created', 'false', '--code', 'x']])
      await assert.rejects(run(cmd, { env: agentEnv }), (e) => e.code === 'AGENT_CANNOT_APPROVE' && /operator in the approval console/.test(e.message));
    const caps = await run(['capabilities'], { env: { ...agentEnv, DAFTRA_APPROVAL_SECRET: OP_SECRET, DAFTRA_WRITE_API_KEY: WRITE_KEY } });
    assert.equal(caps.broker_mode, 'service'); assert.equal(caps.writes_enabled, false);
    assert.ok(caps.env_warnings.some((w) => /DAFTRA_APPROVAL_SECRET is present/.test(w)) && caps.env_warnings.some((w) => /DAFTRA_WRITE_API_KEY is present/.test(w)));
    assert.equal(c.fake.posts.length, 0);
    // duplicates go through the service too
    await assert.rejects(run(['duplicate', 'expenses', '3', '--input', '{"date":"2025-03-01"}'], { env: agentEnv }), /source/i);
    // misconfiguration fails closed
    await assert.rejects(run(['propose', 'sales_invoice', '--input', '{}'], { env: { ...agentEnv, DAFTRA_BROKER_TOKEN: undefined } }), /needs both/);
    await assert.rejects(run(['propose', 'sales_invoice', '--input', '{}'], { env: { ...agentEnv, DAFTRA_BROKER_SOCKET: '/tmp/x.sock' } }), /only one of/);
    await assert.rejects(run(['status', 'prop_x'], { env: { DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'k' } }), /only available in service mode/);
  } finally { await c.stop(); }
});

test('CLIENT-side SSRF guard: only http://<name>.railway.internal:<port> (loopback only with the test flag)', async () => {
  const base = { DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: READ_KEY, DAFTRA_BROKER_TOKEN: AGENT_TOKEN };
  const never = async () => { throw Error('network must not be touched'); };
  for (const url of ['https://basht-broker.railway.internal:8081', 'http://evil.example:8081', 'http://127.0.0.1:8081', 'http://localhost:8081', 'http://basht-broker.railway.internal', 'http://basht-broker.railway.internal:8081/x',
    'http://user:pw@basht-broker.railway.internal:8081', 'http://basht-broker.railway.internal:8081?x=1', 'http://broker.railway.internal.evil.com:8081', 'http://169.254.169.254:80', 'http://[::1]:8081', 'file:///etc/passwd', 'not a url', 'http://basht-broker.railway.internal:99999'])
    await assert.rejects(run(['show', 'prop_0123456789abcdef'], { env: { ...base, DAFTRA_BROKER_URL: url }, fetcher: never }), /DAFTRA_BROKER_URL|valid URL/, url);
  // a redirecting broker is never followed
  const seen = [];
  const redirecting = async (u, o) => { seen.push([String(u), o.redirect]); return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } }); };
  const { callBrokerService } = await import('./daftra-broker-service-client.mjs');
  await assert.rejects(callBrokerService({ url: 'http://broker.railway.internal:8081', token: AGENT_TOKEN, cmd: 'show', body: { id: 'prop_0123456789abcdef' }, fetcher: redirecting }), /invalid JSON/);
  assert.deepEqual(seen, [['http://broker.railway.internal:8081/v1/show', 'manual']]);
});

test('NOT CONFIGURED is fail-closed: health + login page only, no proposals, no writes, nothing crashes', async () => {
  const c = await startService({ env: { DAFTRA_APPROVAL_SECRET: undefined, OPERATOR_PASSWORD: undefined } });
  try {
    assert.equal(c.service.configured, false);
    assert.ok(c.service.issues.length >= 2);
    const op = c.operator();
    assert.equal((await op.request('GET', '/healthz')).text, 'ok');
    assert.equal((await op.request('GET', '/setup/healthz')).text, 'ok');
    const home = await op.request('GET', '/');
    assert.equal(home.status, 503); assert.match(home.text, /not configured/i);
    assert.equal(/OPERATOR_PASSWORD|DAFTRA_APPROVAL/.test(home.text), false, 'the public page does not reveal which variables are missing');
    assert.equal((await op.login({ pre: 'x' })).status, 503);
    const r = await proposeInvoice(c);
    assert.equal(r.status, 503); assert.equal(r.json.refused, 'NOT_CONFIGURED');
    assert.equal(c.fake.calls.length, 0);
    assert.ok(c.logs.some((l) => /NOT CONFIGURED/.test(l)));
  } finally { await c.stop(); }
});

test('WRITES DISABLED by default: a perfect operator approval still sends nothing, and the console says so', async () => {
  const c = await startService({ env: { DAFTRA_WRITES_ENABLED: undefined } });
  try {
    assert.equal(c.service.writesEnabled(), false);
    const id = (await proposeInvoice(c)).json.result.proposal_id;       // proposing (read-only) is still allowed
    const op = c.operator(); await op.login();
    const page = await op.proposalPage(id);
    assert.match(page.text, /Writes are DISABLED/); assert.equal(/APPROVE &amp; SEND/.test(page.text), false);
    const r = await op.decide(id, 'approve');
    assert.equal(r.status, 409); assert.match(r.text, /Writes are disabled/);
    assert.equal(c.fake.posts.length, 0);
    for (const v of ['0', 'true', 'yes', '']) { const d = await startService({ env: { DAFTRA_WRITES_ENABLED: v } }); try { assert.equal(d.service.writesEnabled(), false, JSON.stringify(v)); } finally { await d.stop(); } }
  } finally { await c.stop(); }
});

test('operator can reject (consumes the proposal) and the agent sees declined_by_operator', async () => {
  const c = await startService();
  try {
    const id = (await proposeInvoice(c)).json.result.proposal_id;
    const op = c.operator(); await op.login(); await op.proposalPage(id);
    const r = await op.decide(id, 'reject');
    assert.equal(r.status, 200); assert.match(r.text, /nothing was sent/i);
    assert.equal((await c.agent('/v1/status', { id })).json.result.outcome, 'declined_by_operator');
    const again = await op.decide(id, 'approve');
    assert.notEqual(again.status, 200);
    assert.equal(c.fake.posts.length, 0);
  } finally { await c.stop(); }
});

test('ambiguous outcome is resolved by the operator in the console (with a fresh code), never by the agent', async () => {
  const c = await startService({ fake: new FakeDaftra({ post: () => ({ status: 503, json: {} }) }) });
  try {
    const id = (await proposeInvoice(c)).json.result.proposal_id;
    const op = c.operator(); await op.login(); await op.proposalPage(id);
    const r = await op.decide(id, 'approve'); assert.match(r.text, /ambiguous/);
    assert.equal((await c.agent('/v1/status', { id })).json.result.outcome, 'ambiguous_needs_operator');
    const page = await op.proposalPage(id); assert.match(page.text, /Ambiguous outcome/);
    const res = await op.decide(id, 'resolve', { extra: { created: 'false' } });
    assert.equal(res.status, 200); assert.match(res.text, /Recorded/);
    assert.equal((await c.agent('/v1/status', { id })).json.result.outcome, 'resolved_not_created');
    assert.equal(c.fake.posts.length, 1);
  } finally { await c.stop(); }
});

test('a proposal made for the pinned tenant only: tenant is signed and shown state from another tenant is refused', async () => {
  const c = await startService();
  try {
    const id = (await proposeInvoice(c)).json.result.proposal_id;
    const proposal = JSON.parse(await readFile(join(c.stateDir, 'daftra-ledger', 'proposals', id + '.json'), 'utf8'));
    assert.equal(proposal.tenant, 'nepras.daftra.com');
  } finally { await c.stop(); }
});
