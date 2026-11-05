import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDaftra } from './daftra-fake.test-helper.mjs';
import { createProposal } from './daftra-proposal.mjs';
import { approvalPhrase, resolveCode, proposalAuth } from './daftra-auth.mjs';
import { review } from './daftra-approve.mjs';
import { executeProposal, resolveProposal, assertWriteAllowed, WriteRefused, WRITE_ROUTES } from './daftra-write.mjs';
import { readLedger, loadProposal, ledgerDir } from './daftra-ledger.mjs';

const SECRET = 'sk-test-SECRET-KEY-123';
const OP_SECRET = 'operator-secret-0123456789-0123456789-abcdef';
let ENV;
async function setup(seed, extraEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'basht-ledger-'));
  const env = { OPENCLAW_WORKSPACE_DIR: dir, DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: SECRET, DAFTRA_WRITES_ENABLED: '1', DAFTRA_APPROVAL_SECRET: OP_SECRET, ...extraEnv };
  ENV = env;
  const fake = new FakeDaftra(seed);
  return { dir, env, fake, done: () => rm(dir, { recursive: true, force: true }) };
}
const invoiceInput = { client_id: 4, date: '2025-03-01', items: [{ item: 'Diesel', quantity: '100', unit_price: '2', tax1: 1 }] };
const phraseOf = (p, env = ENV) => approvalPhrase(env, p);
const approve = (p) => ({ id: p.id, phrase: phraseOf(p), actor: 'user-1' });

test('proposing never writes: only GET requests, nothing created, ledger stays empty', async () => {
  const { env, fake, done } = await setup();
  try {
    const p = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch, actor: 'user-1' });
    assert.equal(p.status, 'READY_FOR_APPROVAL');
    assert.equal(p.mode, 'draft');
    assert.equal(p.totals.total, '230.00');
    assert.equal(p.party.name, 'شركة نبراس');
    assert.equal(fake.posts.length, 0);
    assert.ok(fake.calls.every((c) => c.method === 'GET'));
    assert.deepEqual(await readLedger(env), []);
    assert.match(phraseOf(p), /^APPROVE prop_[0-9a-f]{16} [0-9a-f]{8} DRAFT [0-9a-f]{16}$/);
    assert.equal(JSON.stringify(p).includes(phraseOf(p)), false);
  } finally { await done(); }
});

test('writes are OFF by default: a correct approval still sends nothing', async () => {
  const { env, fake, done } = await setup({}, { DAFTRA_WRITES_ENABLED: undefined });
  try {
    const p = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    await assert.rejects(executeProposal(approve(p), { env, fetcher: fake.fetch }), (e) => e.code === 'WRITES_DISABLED');
    assert.equal(fake.posts.length, 0);
  } finally { await done(); }
});

test('approved draft invoice: exactly one POST with the approved body, then verified and ledgered', async () => {
  const seed = { post: () => ({ status: 202, json: { code: 202, result: 'successful', id: 5001 } }) };
  const { env, fake, done } = await setup(seed);
  try {
    fake.created.invoices = { 5001: { id: 5001, summary_total: '230.00' } };
    const p = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    const result = await executeProposal(approve(p), { env, fetcher: fake.fetch });
    assert.equal(result.ok, true);
    assert.equal(result.record_id, '5001');
    assert.deepEqual({ matched: result.verification.matched, expected: result.verification.expected }, { matched: true, expected: '230.00' });
    assert.equal(fake.posts.length, 1);
    const post = fake.posts[0];
    assert.equal(post.method, 'POST');
    assert.equal(post.path, '/api2/invoices.json');
    assert.equal(post.search, '');
    assert.deepEqual(JSON.parse(post.body), p.request.body);
    assert.equal(post.headers.APIKEY, SECRET);
    const ledger = await readLedger(env);
    assert.deepEqual(ledger.map((e) => e.state), ['submitting', 'submitted']);
    assert.equal(ledger[1].record_id, '5001');
    // the ledger and proposal files must never contain the API key
    const files = [join(ledgerDir(env), 'ledger.jsonl'), ...(await readdir(join(ledgerDir(env), 'proposals'))).map((f) => join(ledgerDir(env), 'proposals', f))];
    for (const f of files) assert.ok(!(await readFile(f, 'utf8')).includes(SECRET), f);
    assert.equal((await loadProposal(p.id, env)).status, 'SUBMITTED');
  } finally { await done(); }
});

test('a verification mismatch is reported loudly after creation', async () => {
  const { env, fake, done } = await setup();
  try {
    fake.created.invoices = { 5001: { id: 5001, summary_total: '229.00' } };
    const p = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    const r = await executeProposal(approve(p), { env, fetcher: fake.fetch });
    assert.equal(r.ok, true);
    assert.equal(r.verification.matched, false);
    assert.equal(r.verification.actual, '229.00');
  } finally { await done(); }
});

test('approval is bound to the exact proposal: wrong id, hash, mode or wording is refused', async () => {
  const { env, fake, done } = await setup();
  try {
    const p = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    const other = await createProposal('sales_invoice', { ...invoiceInput, items: [{ ...invoiceInput.items[0], quantity: '101' }] }, { env, fetcher: fake.fetch });
    for (const phrase of ['', 'yes', 'continue', 'APPROVE', phraseOf(other), phraseOf(p).replace('DRAFT', 'FINAL'), phraseOf(p).toLowerCase(), phraseOf(p) + ' extra', 'APPROVE ' + p.id + ' ' + p.request_hash.slice(0, 8) + ' DRAFT']) {
      await assert.rejects(executeProposal({ id: p.id, phrase }, { env, fetcher: fake.fetch }), (e) => e.code === 'PHRASE_MISMATCH', phrase);
    }
    assert.equal(fake.posts.length, 0);
    await assert.rejects(executeProposal({ id: '../../etc/passwd', phrase: 'x' }, { env, fetcher: fake.fetch }), /Invalid proposal id/);
  } finally { await done(); }
});

test('a tampered stored request is refused even with the right phrase', async () => {
  const { env, fake, done } = await setup();
  try {
    const p = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    const file = join(ledgerDir(env), 'proposals', p.id + '.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    stored.request.body.InvoiceItem[0].unit_price = '0.01';
    await writeFile(file, JSON.stringify(stored));
    await assert.rejects(executeProposal(approve(p), { env, fetcher: fake.fetch }), (e) => e.code === 'TAMPERED');
    assert.equal(fake.posts.length, 0);
  } finally { await done(); }
});

test('proposals expire after 15 minutes and are single use', async () => {
  const { env, fake, done } = await setup();
  try {
    const p = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch, now: Date.now() - 16 * 60 * 1000 });
    await assert.rejects(executeProposal(approve(p), { env, fetcher: fake.fetch }), (e) => e.code === 'EXPIRED');
    const fresh = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    fake.created.invoices = { 5001: { id: 5001, summary_total: '230.00' } };
    await executeProposal(approve(fresh), { env, fetcher: fake.fetch });
    await assert.rejects(executeProposal(approve(fresh), { env, fetcher: fake.fetch }), (e) => e.code === 'ALREADY_USED');
    assert.equal(fake.posts.length, 1);
  } finally { await done(); }
});

test('the identical request cannot be proposed again once submitted', async () => {
  const { env, fake, done } = await setup();
  try {
    fake.created.invoices = { 5001: { id: 5001, summary_total: '230.00' } };
    const p = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    await executeProposal(approve(p), { env, fetcher: fake.fetch });
    const again = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    assert.equal(again.status, 'BLOCKED');
    assert.match(again.blocking.join(' '), /already submitted/);
    await assert.rejects(executeProposal(approve(again), { env, fetcher: fake.fetch }), (e) => e.code === 'NOT_READY');
    assert.equal(fake.posts.length, 1);
  } finally { await done(); }
});

test('network failure is AMBIGUOUS: never auto-retried; re-send needs a human resolve', async () => {
  const { env, fake, done } = await setup({ postError: Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }) });
  try {
    const p = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    const r = await executeProposal(approve(p), { env, fetcher: fake.fetch });
    assert.equal(r.status, 'ambiguous');
    assert.equal(fake.posts.length, 1);
    await assert.rejects(executeProposal(approve(p), { env, fetcher: fake.fetch }), (e) => e.code === 'ALREADY_USED');
    const again = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    assert.equal(again.status, 'BLOCKED');
    await assert.rejects(resolveProposal({ id: p.id, created: 'maybe' }, { env }), /true or false/);
    await assert.rejects(resolveProposal({ id: p.id, created: false, code: 'guess' }, { env }), (e) => e.code === 'PHRASE_MISMATCH');
    await resolveProposal({ id: p.id, created: false, code: resolveCode(env, p.id, false), actor: 'user-1' }, { env });
    fake.postError = null;
    fake.created.invoices = { 5001: { id: 5001, summary_total: '230.00' } };
    const retry = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    assert.equal(retry.status, 'READY_FOR_APPROVAL');
    assert.equal((await executeProposal(approve(retry), { env, fetcher: fake.fetch })).ok, true);
  } finally { await done(); }
});

test('resolved_created permanently blocks the same request', async () => {
  const { env, fake, done } = await setup({ post: () => ({ status: 503, json: {} }) });
  try {
    const p = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    assert.equal((await executeProposal(approve(p), { env, fetcher: fake.fetch })).status, 'ambiguous');
    await resolveProposal({ id: p.id, created: true, recordId: 77, code: resolveCode(env, p.id, true) }, { env });
    assert.equal((await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch })).status, 'BLOCKED');
    await assert.rejects(resolveProposal({ id: p.id, created: true, code: resolveCode(env, p.id, true) }, { env }), (e) => e.code === 'NOT_AMBIGUOUS');
  } finally { await done(); }
});

test('Daftra 4xx rejection is definitive (nothing created) and allows a corrected retry', async () => {
  const { env, fake, done } = await setup({ post: () => ({ status: 422, json: { message: 'Date is in a closed period <b>' } }) });
  try {
    const p = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    const r = await executeProposal(approve(p), { env, fetcher: fake.fetch });
    assert.equal(r.status, 'rejected');
    assert.match(r.message, /closed period/);
    assert.doesNotMatch(r.message, /<b>/);
    assert.equal((await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch })).status, 'READY_FOR_APPROVAL');
  } finally { await done(); }
});

test('2xx without a record id is treated as ambiguous, not as success', async () => {
  const { env, fake, done } = await setup({ post: () => ({ status: 202, json: { result: 'successful' } }) });
  try {
    const p = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    assert.equal((await executeProposal(approve(p), { env, fetcher: fake.fetch })).status, 'ambiguous');
  } finally { await done(); }
});

test('blocking checks: unknown client, forbidden API role, duplicates, overpayment, draft invoice', async () => {
  let ctx = await setup();
  try {
    const missing = await createProposal('sales_invoice', { ...invoiceInput, client_id: 999 }, { env: ctx.env, fetcher: ctx.fake.fetch });
    assert.equal(missing.status, 'BLOCKED');
    assert.match(missing.blocking.join(' '), /client 999/);
  } finally { await ctx.done(); }
  ctx = await setup({ forbidden: ['expenses'] });
  try {
    const p = await createProposal('expense', { amount: '10', date: '2025-03-01', description: 'x' }, { env: ctx.env, fetcher: ctx.fake.fetch });
    assert.equal(p.status, 'BLOCKED');
    assert.match(p.blocking.join(' '), /does not allow expenses/);
  } finally { await ctx.done(); }
  ctx = await setup({ lists: { invoices: [{ id: 41, summary_total: '230.00' }] } });
  try {
    const dup = await createProposal('sales_invoice', invoiceInput, { env: ctx.env, fetcher: ctx.fake.fetch });
    assert.equal(dup.status, 'BLOCKED');
    assert.match(dup.blocking.join(' '), /invoices#41/);
    const ack = await createProposal('sales_invoice', { ...invoiceInput, acknowledge_duplicates: ['invoices#41'] }, { env: ctx.env, fetcher: ctx.fake.fetch });
    assert.equal(ack.status, 'READY_FOR_APPROVAL');
    assert.deepEqual(ack.acknowledged_duplicates, ['invoices#41']);
  } finally { await ctx.done(); }
  ctx = await setup();
  try {
    const over = await createProposal('invoice_payment', { invoice_id: 3, amount: '115.01', payment_method: 'cash', date: '2025-03-01' }, { env: ctx.env, fetcher: ctx.fake.fetch });
    assert.equal(over.status, 'BLOCKED');
    assert.match(over.blocking.join(' '), /exceed unpaid/);
    const ok = await createProposal('invoice_payment', { invoice_id: 3, amount: '115.00', payment_method: 'cash', date: '2025-03-01' }, { env: ctx.env, fetcher: ctx.fake.fetch });
    assert.equal(ok.status, 'READY_FOR_APPROVAL');
    assert.match(phraseOf(ok), / FINAL [0-9a-f]{16}$/);
  } finally { await ctx.done(); }
  ctx = await setup({ records: { invoices: { 3: { id: 3, draft: 1, summary_unpaid: '115' } } } });
  try {
    const p = await createProposal('invoice_payment', { invoice_id: 3, amount: '10', payment_method: 'cash', date: '2025-03-01' }, { env: ctx.env, fetcher: ctx.fake.fetch });
    assert.match(p.blocking.join(' '), /draft/);
  } finally { await ctx.done(); }
});

test('balance changing between proposal and approval stops the payment before any POST', async () => {
  const { env, fake, done } = await setup();
  try {
    const p = await createProposal('invoice_payment', { invoice_id: 3, amount: '100', payment_method: 'cash', date: '2025-03-01' }, { env, fetcher: fake.fetch });
    assert.equal(p.status, 'READY_FOR_APPROVAL');
    fake.records.invoices[3].summary_unpaid = '40.00';       // someone else paid in the meantime
    await assert.rejects(executeProposal(approve(p), { env, fetcher: fake.fetch }), (e) => e.code === 'RECHECK_FAILED' && /exceed unpaid/.test(e.message));
    assert.equal(fake.posts.length, 0);
  } finally { await done(); }
});

test('expense uses Daftra idempotency: stable unique_id, and an echoed duplicate creates nothing new', async () => {
  const { env, fake, done } = await setup({ post: () => ({ status: 202, json: { result: 'duplicated', id: 321 } }) });
  try {
    const input = { amount: '88.5', date: '2025-03-01', description: 'وقود' };
    const p1 = await createProposal('expense', input, { env, fetcher: fake.fetch });
    const p2 = await createProposal('expense', input, { env, fetcher: fake.fetch });
    assert.equal(p1.request.body.Expense.unique_id, p2.request.body.Expense.unique_id);
    assert.match(p1.request.body.Expense.unique_id, /^basht-[0-9a-f]{40}$/);
    const r = await executeProposal(approve(p1), { env, fetcher: fake.fetch });
    assert.equal(r.status, 'duplicate_echoed');
    assert.equal(fake.posts[0].search, '?send=draft');
  } finally { await done(); }
});

test('rate limit stops runaway writes', async () => {
  const { env, fake, done } = await setup({}, { DAFTRA_MAX_WRITES_PER_HOUR: '1' });
  try {
    fake.created.invoices = { 5001: { id: 5001, summary_total: '230.00' } };
    const a = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    await executeProposal(approve(a), { env, fetcher: fake.fetch });
    const b = await createProposal('sales_invoice', { ...invoiceInput, items: [{ ...invoiceInput.items[0], quantity: '7' }] }, { env, fetcher: fake.fetch });
    await assert.rejects(executeProposal(approve(b), { env, fetcher: fake.fetch }), (e) => e.code === 'RATE_LIMIT');
    assert.equal(fake.posts.length, 1);
  } finally { await done(); }
});

test('route allowlist: POST create endpoints only; PUT/PATCH/DELETE and foreign paths are impossible', () => {
  assert.deepEqual(Object.values(WRITE_ROUTES).map((r) => r.method), Array(6).fill('POST'));
  const inv = { Invoice: { client_id: 4, draft: 1, date: '2025-03-01' }, InvoiceItem: [{ item: 'x', quantity: '1', unit_price: '1', tax1: 0, tax2: 0 }] };
  const ok = { method: 'POST', path: '/api2/invoices.json', query: '', body: inv };
  assert.doesNotThrow(() => assertWriteAllowed('sales_invoice', ok));
  assert.doesNotThrow(() => assertWriteAllowed('expense', { method: 'POST', path: '/api2/expenses.json', query: 'send=draft', body: { Expense: { amount: '1.00', date: '2025-03-01', status: 'draft' } } }));
  for (const bad of [
    { ...ok, method: 'PUT' }, { ...ok, method: 'DELETE' }, { ...ok, method: 'PATCH' }, { ...ok, method: 'GET' },
    { ...ok, path: '/api2/invoices/3.json' }, { ...ok, path: '/api2/users.json' }, { ...ok, path: '/api2/invoices.json/../x' },
    { ...ok, query: 'send=draft&force=1' }, { ...ok, query: 'draft=0' },
  ]) assert.throws(() => assertWriteAllowed('sales_invoice', bad), WriteRefused, JSON.stringify(bad));
  assert.throws(() => assertWriteAllowed('delete_invoice', ok), WriteRefused);
  assert.throws(() => assertWriteAllowed('__proto__', ok), WriteRefused);
});

test('approvalPhrase differs per proposal and per mode', async () => {
  const { env, fake, done } = await setup();
  try {
    const d = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    const f = await createProposal('sales_invoice', { ...invoiceInput, finalize: true }, { env, fetcher: fake.fetch });
    assert.notEqual(phraseOf(d), phraseOf(f));
    assert.match(phraseOf(f), / FINAL /);
    assert.ok(f.effects.includes('posts_to_accounts'));
  } finally { await done(); }
});

test('two identical proposals prepared in parallel: only the first can ever be sent', async () => {
  const { env, fake, done } = await setup();
  try {
    fake.created.invoices = { 5001: { id: 5001, summary_total: '230.00' } };
    const a = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    const b = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    assert.equal(a.request_hash, b.request_hash);
    assert.equal(b.status, 'READY_FOR_APPROVAL');                       // ledger was still empty when b was prepared
    await executeProposal(approve(a), { env, fetcher: fake.fetch });
    await assert.rejects(executeProposal(approve(b), { env, fetcher: fake.fetch }), (e) => e.code === 'DUPLICATE');
    assert.equal(fake.posts.length, 1);
  } finally { await done(); }
});

test('a proposal rewritten with a consistent hash but without the operator secret is rejected', async () => {
  const { env, fake, done } = await setup();
  try {
    const p = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    const file = join(ledgerDir(env), 'proposals', p.id + '.json');
    const { hashRequest } = await import('./daftra-finance-preflight.mjs');
    for (const patch of [{ path: '/api2/users.json' }, { method: 'DELETE', path: '/api2/invoices/3.json' }, { query: 'force=1' }]) {
      const stored = JSON.parse(await readFile(file, 'utf8'));
      stored.request = { ...p.request, ...patch };
      stored.request_hash = hashRequest(stored.request);
      await writeFile(file, JSON.stringify(stored));
      await assert.rejects(executeProposal({ id: p.id, phrase: phraseOf(stored) }, { env, fetcher: fake.fetch }), (e) => e.code === 'TAMPERED');
    }
    assert.equal(fake.posts.length, 0);
  } finally { await done(); }
});

// ---- findings from the independent security review: each one is an attack that must now fail ----------

test('REVIEW#1 an agent cannot approve its own write: no phrase is ever printed, and a guessed/derived phrase fails', async () => {
  const { env, fake, done } = await setup();
  try {
    const { run } = await import('./daftra-cli.mjs');
    const out = await run(['propose', 'sales_invoice', '--input', JSON.stringify(invoiceInput)], { env, fetcher: fake.fetch });
    assert.equal(JSON.stringify(out).includes('APPROVE prop_'), false);
    assert.equal('approval_phrase' in out, false);
    const guessed = 'APPROVE ' + out.proposal_id + ' ' + out.request_hash.slice(0, 8) + ' DRAFT';
    await assert.rejects(run(['execute', out.proposal_id, '--phrase', guessed], { env, fetcher: fake.fetch }), (e) => e.code === 'PHRASE_MISMATCH');
    await assert.rejects(run(['execute', out.proposal_id, '--phrase', guessed + ' 0000000000000000'], { env, fetcher: fake.fetch }), (e) => e.code === 'PHRASE_MISMATCH');
    assert.equal(fake.posts.length, 0);
    // the operator tool, holding the secret, shows the stored request and yields the phrase that does work
    const text = await review(out.proposal_id, env);
    const phrase = text.match(/APPROVE prop_\S+ \S+ DRAFT [0-9a-f]{16}/)[0];
    assert.match(text, /\/api2\/invoices\.json/);
    fake.created.invoices = { 5001: { id: 5001, summary_total: '230.00' } };
    assert.equal((await run(['execute', out.proposal_id, '--phrase', phrase], { env, fetcher: fake.fetch })).status, 'submitted');
  } finally { await done(); }
});

test('REVIEW#1/#2 a proposal or phrase made with a different secret is worthless; blocked proposals show no phrase', async () => {
  const { env, fake, done } = await setup();
  try {
    const p = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    const attackerEnv = { ...env, DAFTRA_APPROVAL_SECRET: 'attacker-secret-0123456789-0123456789-xyz' };
    await assert.rejects(executeProposal({ id: p.id, phrase: phraseOf(p, attackerEnv) }, { env, fetcher: fake.fetch }), (e) => e.code === 'PHRASE_MISMATCH');
    // forged proposal, authenticated with the attacker's secret
    const forged = { ...p, id: 'prop_' + 'a'.repeat(16), request: { ...p.request, body: { ClientPayment: { client_id: 4, amount: '99999.00', payment_method: 'cash' } }, path: '/api2/client_payments.json' }, type: 'client_payment' };
    const { hashRequest } = await import('./daftra-finance-preflight.mjs');
    forged.request_hash = hashRequest(forged.request);
    await writeFile(join(ledgerDir(env), 'proposals', forged.id + '.json'), JSON.stringify({ ...forged, auth: proposalAuth(attackerEnv, forged) }));
    await assert.rejects(executeProposal({ id: forged.id, phrase: phraseOf(forged, attackerEnv) }, { env, fetcher: fake.fetch }), (e) => e.code === 'TAMPERED');
    const blocked = await createProposal('sales_invoice', { ...invoiceInput, client_id: 999 }, { env, fetcher: fake.fetch });
    assert.equal(blocked.status, 'BLOCKED');
    assert.match(await review(blocked.id, env), /No approval phrase: the proposal is blocked/);
    assert.equal(fake.posts.length, 0);
  } finally { await done(); }
});

test('REVIEW#4 editing ANY signed side-field (status/ready/party/totals/expiry/acknowledgements/mode) is detected', async () => {
  const { env, fake, done } = await setup();
  try {
    const bad = await createProposal('invoice_payment', { invoice_id: 3, amount: '500.00', payment_method: 'cash', date: '2025-03-01' }, { env, fetcher: fake.fetch });
    assert.equal(bad.status, 'BLOCKED');                      // overpayment
    const file = join(ledgerDir(env), 'proposals', bad.id + '.json');
    const original = JSON.parse(await readFile(file, 'utf8'));
    const edits = [
      (s) => { s.status = 'READY_FOR_APPROVAL'; s.ready = true; },
      (s) => { s.party.invoice_id = 8; s.ready = true; },
      (s) => { s.acknowledged_duplicates = ['invoices#1']; s.ready = true; },
      (s) => { s.expires_at = 'garbage'; s.ready = true; },
      (s) => { s.expires_at = '2999-01-01T00:00:00Z'; s.ready = true; },
      (s) => { s.mode = 'draft'; s.ready = true; },
      (s) => { s.totals.total = '1.00'; s.ready = true; },
      (s) => { delete s.auth; s.ready = true; },
    ];
    for (const edit of edits) {
      const s = structuredClone(original); edit(s);
      await writeFile(file, JSON.stringify(s));
      await assert.rejects(executeProposal({ id: bad.id, phrase: 'x' }, { env, fetcher: fake.fetch }), (e) => e.code === 'TAMPERED', edit.toString());
    }
    assert.equal(fake.posts.length, 0);
  } finally { await done(); }
});

test('REVIEW#4b a BLOCKED proposal can never run even though only the unsigned status was flipped', async () => {
  const { env, fake, done } = await setup();
  try {
    const bad = await createProposal('invoice_payment', { invoice_id: 3, amount: '500.00', payment_method: 'cash', date: '2025-03-01' }, { env, fetcher: fake.fetch });
    const file = join(ledgerDir(env), 'proposals', bad.id + '.json');
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), status: 'READY_FOR_APPROVAL' }));
    await assert.rejects(executeProposal({ id: bad.id, phrase: phraseOf(bad) }, { env, fetcher: fake.fetch }), (e) => e.code === 'NOT_READY');
    assert.equal(fake.posts.length, 0);
  } finally { await done(); }
});

test('REVIEW#2b editing, truncating or re-chaining the ledger is detected and stops all writes', async () => {
  const { env, fake, done } = await setup();
  try {
    fake.created.invoices = { 5001: { id: 5001, summary_total: '230.00' } };
    const a = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    await executeProposal(approve(a), { env, fetcher: fake.fetch });
    const file = join(ledgerDir(env), 'ledger.jsonl');
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    for (const forged of [
      lines[1] + '\n',                                                      // drop the "submitting" line: chain no longer starts at genesis
      lines[0] + '\n' + lines[1].replace('"submitted"', '"rejected"') + '\n', // flip a state
      lines[0].replace('"submitting"', '"rejected"') + '\n',               // rewrite line 1
    ]) {
      await writeFile(file, forged);
      await assert.rejects(createProposal('sales_invoice', { ...invoiceInput, items: [{ ...invoiceInput.items[0], quantity: '9' }] }, { env, fetcher: fake.fetch }), (e) => e.code === 'LEDGER_TAMPERED');
    }
    assert.equal(fake.posts.length, 1);
  } finally { await done(); }
});

test('REVIEW#3 parallel execute of one approved proposal sends exactly once', async () => {
  const { env, fake, done } = await setup();
  try {
    fake.created.invoices = { 5001: { id: 5001, summary_total: '230.00' } };
    const p = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => executeProposal(approve(p), { env, fetcher: fake.fetch })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(fake.posts.length, 1);
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => ['ALREADY_USED', 'DUPLICATE'].includes(r.reason.code)));
  } finally { await done(); }
});

test('REVIEW#3b parallel execute of two proposals with the SAME request sends exactly once', async () => {
  const { env, fake, done } = await setup();
  try {
    fake.created.invoices = { 5001: { id: 5001, summary_total: '230.00' } };
    const a = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    const b = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    await Promise.allSettled([executeProposal(approve(a), { env, fetcher: fake.fetch }), executeProposal(approve(b), { env, fetcher: fake.fetch })]);
    assert.equal(fake.posts.length, 1);
  } finally { await done(); }
});

test('REVIEW#5 resolve needs an operator-derived code: the agent cannot clear an ambiguous block itself', async () => {
  const { env, fake, done } = await setup({ post: () => ({ status: 503, json: {} }) });
  try {
    const p = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    assert.equal((await executeProposal(approve(p), { env, fetcher: fake.fetch })).status, 'ambiguous');
    for (const code of [undefined, '', 'x', resolveCode(env, p.id, true)])            // right code for the WRONG decision also fails
      await assert.rejects(resolveProposal({ id: p.id, created: false, code }, { env }), (e) => e.code === 'PHRASE_MISMATCH');
    assert.equal((await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch })).status, 'BLOCKED');
    await resolveProposal({ id: p.id, created: false, code: resolveCode(env, p.id, false) }, { env });
    assert.equal((await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch })).status, 'READY_FOR_APPROVAL');
  } finally { await done(); }
});

test('REVIEW#6 duplicate scan reads ALL pages: a match on page 2 blocks the proposal', async () => {
  const lists = { invoices: [...Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, summary_total: '1.00' })), { id: 2000, summary_total: '230.00' }] };
  const { env, fake, done } = await setup({ lists });
  try {
    const p = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    assert.equal(p.status, 'BLOCKED');
    assert.match(p.blocking.join(' '), /invoices#2000/);
  } finally { await done(); }
});

test('operator secret is mandatory: without it nothing can be proposed or executed', async () => {
  const { env, fake, done } = await setup({}, { DAFTRA_APPROVAL_SECRET: undefined });
  try {
    await assert.rejects(createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch }), (e) => e.code === 'APPROVAL_NOT_CONFIGURED');
    await assert.rejects(createProposal('sales_invoice', invoiceInput, { env: { ...env, DAFTRA_APPROVAL_SECRET: 'short' }, fetcher: fake.fetch }), (e) => e.code === 'APPROVAL_NOT_CONFIGURED');
    await assert.rejects(executeProposal({ id: 'prop_' + '1'.repeat(16), phrase: 'x' }, { env, fetcher: fake.fetch }), (e) => e.code === 'APPROVAL_NOT_CONFIGURED');
  } finally { await done(); }
});

test('strict body shape: unknown sections/keys (id, status, extra fields) can never be sent', () => {
  const ok = { method: 'POST', path: '/api2/expenses.json', query: '', body: { Expense: { amount: '1.00', date: '2025-03-01', note: 'x' } } };
  assert.doesNotThrow(() => assertWriteAllowed('expense', ok));
  for (const body of [
    { Expense: { amount: '1.00', date: '2025-03-01', id: 7 } },
    { Expense: { amount: '1.00', date: '2025-03-01' }, Extra: {} },
    { Expense: [] }, { Expense: null }, {}, { InvoicePayment: { invoice_id: 1, amount: '1', payment_method: 'cash' } },
  ]) assert.throws(() => assertWriteAllowed('expense', { ...ok, body }), (e) => e instanceof WriteRefused && e.code === 'BODY_DENIED', JSON.stringify(body));
});

test('document totals above 12 integer digits are refused', async () => {
  const { prepareFinancialAction } = await import('./daftra-finance-preflight.mjs');
  assert.throws(() => prepareFinancialAction('sales_invoice', { client_id: 4, date: '2025-03-01', items: [{ item: 'x', quantity: '999999999999', unit_price: '999999999999', tax1: 0 }] }), /maximum/);
});

test('defence in depth: even a properly SIGNED proposal cannot bypass expiry, route/body allowlist or the ledger', async () => {
  const { env, fake, done } = await setup();
  try {
    const { hashRequest } = await import('./daftra-finance-preflight.mjs');
    const { forceUnlock } = await import('./daftra-ledger.mjs');
    const base = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    const sign = async (patch, idChar) => {
      const p = { ...base, ...patch, id: 'prop_' + idChar.repeat(16) };
      p.request_hash = hashRequest(p.request);
      await writeFile(join(ledgerDir(env), 'proposals', p.id + '.json'), JSON.stringify({ ...p, auth: proposalAuth(env, p) }));
      return p;
    };
    const garbage = await sign({ expires_at: 'garbage' }, 'b');
    await assert.rejects(executeProposal({ id: garbage.id, phrase: phraseOf(garbage) }, { env, fetcher: fake.fetch }), (e) => e.code === 'EXPIRED');
    const route = await sign({ request: { ...base.request, path: '/api2/users.json' } }, 'c');
    await assert.rejects(executeProposal({ id: route.id, phrase: phraseOf(route) }, { env, fetcher: fake.fetch }), (e) => e.code === 'ROUTE_DENIED');
    const body = await sign({ request: { ...base.request, body: { ...base.request.body, Invoice: { ...base.request.body.Invoice, id: 1 } } } }, 'd');
    await assert.rejects(executeProposal({ id: body.id, phrase: phraseOf(body) }, { env, fetcher: fake.fetch }), (e) => e.code === 'BODY_DENIED');
    assert.equal(fake.posts.length, 0);
    // ledger is an independent second line behind the hash lock
    fake.created.invoices = { 5001: { id: 5001, summary_total: '230.00' } };
    const b = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    await executeProposal(approve(base), { env, fetcher: fake.fetch });
    await forceUnlock(env, base.request_hash + '.lock');
    await assert.rejects(executeProposal(approve(b), { env, fetcher: fake.fetch }), (e) => e.code === 'DUPLICATE');
    assert.equal(fake.posts.length, 1);
  } finally { await done(); }
});
