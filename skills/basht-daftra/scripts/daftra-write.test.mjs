import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDaftra } from './daftra-fake.test-helper.mjs';
import { createProposal, approvalPhrase } from './daftra-proposal.mjs';
import { executeProposal, resolveProposal, assertWriteAllowed, WriteRefused, WRITE_ROUTES } from './daftra-write.mjs';
import { readLedger, loadProposal, ledgerDir } from './daftra-ledger.mjs';

const SECRET = 'sk-test-SECRET-KEY-123';
async function setup(seed, extraEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'basht-ledger-'));
  const env = { OPENCLAW_WORKSPACE_DIR: dir, DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: SECRET, DAFTRA_WRITES_ENABLED: '1', ...extraEnv };
  const fake = new FakeDaftra(seed);
  return { dir, env, fake, done: () => rm(dir, { recursive: true, force: true }) };
}
const invoiceInput = { client_id: 4, date: '2025-03-01', items: [{ item: 'Diesel', quantity: '100', unit_price: '2', tax1: 1 }] };
const approve = (p) => ({ id: p.id, phrase: p.required_phrase, actor: 'user-1' });

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
    assert.match(p.required_phrase, /^APPROVE prop_[0-9a-f]{16} [0-9a-f]{8} DRAFT$/);
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
    for (const phrase of ['', 'yes', 'continue', 'APPROVE', other.required_phrase, p.required_phrase.replace('DRAFT', 'FINAL'), p.required_phrase.toLowerCase(), p.required_phrase + ' extra']) {
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
    await assert.rejects(executeProposal(approve(fresh), { env, fetcher: fake.fetch }), (e) => e.code === 'NOT_READY');
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
    await assert.rejects(executeProposal(approve(p), { env, fetcher: fake.fetch }), (e) => e.code === 'NOT_READY');
    const again = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    assert.equal(again.status, 'BLOCKED');
    await assert.rejects(resolveProposal({ id: p.id, created: 'maybe' }, { env }), /true or false/);
    await resolveProposal({ id: p.id, created: false, actor: 'user-1' }, { env });
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
    await resolveProposal({ id: p.id, created: true, recordId: 77 }, { env });
    assert.equal((await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch })).status, 'BLOCKED');
    await assert.rejects(resolveProposal({ id: p.id, created: true }, { env }), (e) => e.code === 'NOT_AMBIGUOUS');
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
    assert.match(ok.required_phrase, / FINAL$/);
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
  const ok = { method: 'POST', path: '/api2/invoices.json', query: '' };
  assert.doesNotThrow(() => assertWriteAllowed('sales_invoice', ok));
  assert.doesNotThrow(() => assertWriteAllowed('expense', { method: 'POST', path: '/api2/expenses.json', query: 'send=draft' }));
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
    assert.notEqual(approvalPhrase(d), approvalPhrase(f));
    assert.match(approvalPhrase(f), / FINAL$/);
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

test('even a proposal file rewritten with a consistent hash cannot POST outside the allowlist', async () => {
  const { env, fake, done } = await setup();
  try {
    const p = await createProposal('sales_invoice', invoiceInput, { env, fetcher: fake.fetch });
    const file = join(ledgerDir(env), 'proposals', p.id + '.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    const { hashRequest } = await import('./daftra-finance-preflight.mjs');
    for (const patch of [{ path: '/api2/users.json' }, { method: 'DELETE', path: '/api2/invoices/3.json' }, { query: 'force=1' }]) {
      stored.request = { ...p.request, ...patch };
      stored.request_hash = hashRequest(stored.request);
      stored.required_phrase = approvalPhrase(stored);
      await writeFile(file, JSON.stringify(stored));
      await assert.rejects(executeProposal({ id: p.id, phrase: stored.required_phrase }, { env, fetcher: fake.fetch }), (e) => e.code === 'ROUTE_DENIED');
    }
    assert.equal(fake.posts.length, 0);
  } finally { await done(); }
});
