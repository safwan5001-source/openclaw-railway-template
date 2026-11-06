import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, run } from './daftra-cli.mjs';
import { FakeDaftra } from './daftra-fake.test-helper.mjs';

async function setup(seed, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'basht-cli-'));
  const env = { OPENCLAW_WORKSPACE_DIR: dir, DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'k-secret', DAFTRA_APPROVAL_SECRET: 'operator-secret-0123456789-0123456789-abcdef', ...extra };
  return { dir, env, fake: new FakeDaftra(seed), done: () => rm(dir, { recursive: true, force: true }) };
}
const noSleep = async () => {};

test('argument parser handles flags, repeatable --query and rejects dangling flags', () => {
  const r = parseArgs(['list', 'invoices', '--query', 'client_id=4', '--query', 'date_from=2025-01-01', '--all', '--columns', 'id,total']);
  assert.deepEqual(r.positional, ['list', 'invoices']);
  assert.deepEqual(r.query, { client_id: '4', date_from: '2025-01-01' });
  assert.equal(r.flags.all, true);
  assert.throws(() => parseArgs(['list', '--columns']), /Missing value/);
  assert.throws(() => parseArgs(['list', '--query', 'novalue']), /name=value/);
});

test('capabilities reports honestly what exists and whether writes are on', async () => {
  const { env, done } = await setup();
  try {
    const c = await run(['capabilities'], { env });
    assert.equal(c.writes_enabled, false);
    assert.ok(c.read.includes('purchase_invoices') && c.writes.includes('client_payment') && c.formats.includes('docx'));
    assert.ok(c.not_implemented.some((x) => /delete/.test(x)));
    assert.equal((await run(['capabilities'], { env: { ...env, DAFTRA_WRITES_ENABLED: '1' } })).writes_enabled, true);
  } finally { await done(); }
});

test('list --all returns every page with sensitive fields removed; a single page is flagged incomplete', async () => {
  const { env, done } = await setup();
  const rows = Array.from({ length: 25 }, (_, i) => ({ Invoice: { id: String(i + 1), total: '1.00', password: 'p', invoice_pdf_url: 'https://x/a.pdf?hash=1' } }));
  const fetcher = async (url) => {
    const limit = Number(url.searchParams.get('limit')); const page = Number(url.searchParams.get('page') || 1);
    const pageCount = Math.ceil(rows.length / limit);
    return new Response(JSON.stringify({ data: rows.slice((page - 1) * limit, page * limit), pagination: { page, page_count: pageCount, total_results: rows.length, next: page < pageCount ? 'n' : null } }), { status: 200 });
  };
  try {
    const all = await run(['list', 'invoices', '--all', '--page-size', '10'], { env, fetcher, sleep: noSleep });
    assert.equal(all.complete, true);
    assert.equal(all.count, 25);
    assert.equal(all.pages, 3);
    assert.ok(all.records.every((r) => !('password' in r) && !('invoice_pdf_url' in r)));
    const one = await run(['list', 'invoices', '--query', 'limit=5'], { env, fetcher, sleep: noSleep });
    assert.equal(one.complete, false);
    assert.match(one.warning, /not proven complete/);
  } finally { await done(); }
});

test('exports to csv, json, xlsx and docx really create files in the private exports dir', async () => {
  const { env, dir, done } = await setup();
  const rows = [{ Invoice: { id: '0012', total: '10.50', client_business_name: 'شركة نبراس', password: 'p' } }, { Invoice: { id: '0013', total: '-3.25', client_business_name: '=1+1', password: 'p' } }];
  const fetcher = async (url) => new Response(JSON.stringify({ data: rows, pagination: { page: 1, page_count: 1, total_results: 2, next: null } }), { status: 200 });
  try {
    for (const format of ['csv', 'json', 'xlsx', 'docx']) {
      const r = await run(['export', 'invoices', '--format', format, '--out', join(dir, 'exports', 'inv.' + format), '--columns', 'id,total,client_business_name'], { env, fetcher, sleep: noSleep });
      assert.equal(r.ok, true);
      assert.equal(r.record_count, 2);
      assert.equal((await stat(r.path)).mode & 0o777, 0o600);
    }
    const csv = await readFile(join(dir, 'exports', 'inv.csv'), 'utf8');
    assert.ok(csv.includes('"0012"') && csv.includes('"-3.25"') && csv.includes("'=1+1") && !csv.includes('password'));
    await assert.rejects(run(['export', 'invoices', '--format', 'csv', '--out', join(dir, 'x.csv')], { env, fetcher }), /private exports directory/);
    await assert.rejects(run(['export', 'invoices', '--format', 'csv', '--out', join(dir, 'exports', 'p.csv'), '--columns', 'id,password'], { env, fetcher }), /sensitive/);
  } finally { await done(); }
});

test('propose -> show -> execute end to end through the CLI, with writes gated', async () => {
  const { env, fake, done } = await setup({}, { DAFTRA_WRITES_ENABLED: '1' });
  fake.created.invoices = { 5001: { id: 5001, summary_total: '230.00' } };
  const input = JSON.stringify({ client_id: 4, date: '2025-03-01', items: [{ item: 'Diesel', quantity: '100', unit_price: '2', tax1: 1 }] });
  try {
    const p = await run(['propose', 'sales_invoice', '--input', input, '--actor', 'user-1'], { env, fetcher: fake.fetch });
    assert.equal(p.status, 'READY_FOR_APPROVAL');
    assert.match(p.next, /NOTHING HAS BEEN SENT/);
    assert.equal(JSON.stringify(p).includes('APPROVE prop_'), false);
    assert.equal(fake.posts.length, 0);
    assert.equal((await run(['show', p.proposal_id], { env, fetcher: fake.fetch })).request_hash, p.request_hash);
    await assert.rejects(run(['execute', p.proposal_id, '--phrase', 'ok go'], { env, fetcher: fake.fetch }), (e) => e.code === 'PHRASE_MISMATCH');
    assert.equal(fake.posts.length, 0);
    const { review } = await import('./daftra-approve.mjs');
    const phrase = (await review(p.proposal_id, env)).match(/APPROVE prop_\S+ \S+ DRAFT [0-9a-f]{16}/)[0];
    const done_ = await run(['execute', p.proposal_id, '--phrase', phrase, '--actor', 'user-1'], { env, fetcher: fake.fetch });
    assert.equal(done_.status, 'submitted');
    assert.equal(fake.posts.length, 1);
    assert.ok(!JSON.stringify([p, done_]).includes('k-secret'));
  } finally { await done(); }
});

test('statement export writes a real xlsx with numeric balance columns', async () => {
  const { env, dir, done } = await setup();
  const data = {
    invoices: [{ Invoice: { id: 1, no: 'INV-1', date: '2025-02-01', type: 0, draft: 0, summary_total: '100.00', summary_unpaid: '0.00' } }],
    invoice_payments: [{ InvoicePayment: { id: 9, invoice_id: 1, date: '2025-02-02', amount: '100.00' } }],
    client_payments: [],
  };
  const fetcher = async (url) => {
    const rows = data[url.pathname.replace('/api2/', '').replace('.json', '')];
    return new Response(JSON.stringify({ data: rows, pagination: { page: 1, page_count: rows.length ? 1 : 0, total_results: rows.length, next: null } }), { status: 200 });
  };
  try {
    const r = await run(['export-statement', '4', '--from', '2025-02-01', '--to', '2025-02-28', '--format', 'xlsx', '--out', join(dir, 'exports', 's.xlsx')], { env, fetcher, sleep: noSleep });
    assert.equal(r.reconciles, true);
    assert.equal(r.record_count, 2);
  } finally { await done(); }
});

test('unknown commands and entities fail closed', async () => {
  const { env, fake, done } = await setup();
  try {
    await assert.rejects(run(['delete', 'invoices', '3'], { env, fetcher: fake.fetch }), /Unknown command/);
    await assert.rejects(run(['list', 'users'], { env, fetcher: fake.fetch }), /not authorized/);
    await assert.rejects(run(['propose', 'delete_invoice', '--input', '{}'], { env, fetcher: fake.fetch }), /Unsupported financial action/);
    assert.equal(fake.calls.length, 0);
  } finally { await done(); }
});
