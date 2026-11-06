// Explicit `duplicate` of invoice 97407: the SOURCE itself must not block its own copy, every other match must,
// and the source is verified from the document Daftra returns and re-verified (signed fingerprint) before approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDaftra } from './daftra-fake.test-helper.mjs';
import { proposeDuplicate } from './daftra-duplicate.mjs';
import { createProposal } from './daftra-proposal.mjs';
import { approvalPhrase } from './daftra-auth.mjs';
import { executeProposal } from './daftra-write.mjs';
import { review } from './daftra-approve.mjs';

const OP = 'operator-secret-0123456789-0123456789-abcdef';
const SRC = 97407;
const header = {
  id: SRC, no: '007472', date: '2026-05-01', client_id: 48, currency_code: 'SAR', draft: 0, type: 0, payment_status: 2,
  summary_total: '18100.00', summary_paid: '18100.00', summary_unpaid: '0.00', created: '2026-05-01 09:00:00', einvoice_status: 'REPORTED',
  invoice_pdf_url: 'https://nepras.daftra.com/invoices/view/97407.pdf?hash=zzz', password: 'S3CRET',
};
const item = { id: 1, invoice_id: SRC, item: 'Diesel', quantity: 10000, unit_price: '1.81', tax1: 1, tax2: null, product_id: 4, store_id: 1 };
const dupBody = { date: '2026-05-20' };

async function setup({ lists = {}, invoice = {}, items = [item], seed = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'basht-src-'));
  const env = { OPENCLAW_WORKSPACE_DIR: dir, DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'k', DAFTRA_WRITES_ENABLED: '1', DAFTRA_APPROVAL_SECRET: OP };
  const fake = new FakeDaftra({
    taxes: [{ id: 1, name: 'VAT', value: 15, included: 1, is_active: 1 }],
    records: { clients: { 48: { id: 48, business_name: 'عميل' } }, products: { 4: { id: 4, name: 'Diesel', unit_price: '1.81', tax1: 1, status: 0 } }, suppliers: {}, product_categories: {} },
    lists: structuredClone(lists), ...seed,
  });
  const state = { header: { ...header, ...invoice }, items, payments: [{ id: 1, amount: '18100' }], status: 200, bodyOverride: null };
  const inner = fake.fetch;
  fake.fetch = async (url, o = {}) => {
    if ((o.method ?? 'GET') === 'GET' && url.pathname === '/api2/invoices/' + SRC + '.json') {
      fake.calls.push({ method: 'GET', path: url.pathname, search: url.search });
      if (state.status !== 200) return new Response(JSON.stringify({ message: 'x' }), { status: state.status });
      return new Response(JSON.stringify(state.bodyOverride ?? { code: 200, data: { Invoice: state.header, InvoiceItem: state.items, Payment: state.payments } }), { status: 200 });
    }
    return inner(url, o);
  };
  return { env, fake, state, dir, done: () => rm(dir, { recursive: true, force: true }) };
}
const R = (c) => ({ env: c.env, fetcher: c.fake.fetch, actor: 'u' });
const dup = (c, overrides = dupBody) => proposeDuplicate({ source: 'invoices', id: SRC, overrides }, R(c));
const same = { invoices: [{ id: SRC, summary_total: '18100.00', client_id: 48, date: '2026-05-20' }] };

test('duplicate with ONLY the source present: READY, source excluded, new-document warning shown, nothing written', async () => {
  const c = await setup({ lists: same });
  try {
    const p = await dup(c);
    assert.equal(p.status, 'READY_FOR_APPROVAL', p.blocking?.join(' '));
    assert.deepEqual(p.duplicates, []);
    assert.equal(p.checks.find((x) => x.name === 'no_remote_duplicate').ok, true);
    assert.match(p.checks.find((x) => x.name === 'duplicate_source_excluded').detail, /invoices#97407/);
    assert.equal(p.checks.find((x) => x.name === 'duplicate_source_unchanged').ok, true);
    assert.ok(p.warnings.some((w) => /CREATES A NEW FINANCIAL DOCUMENT/.test(w) && /DRAFT/.test(w) && /invoices#97407/.test(w)), p.warnings.join(' | '));
    assert.equal(c.fake.posts.length, 0);
    assert.match(await review(p.id, c.env), /CREATES A NEW FINANCIAL DOCUMENT/);
  } finally { await c.done(); }
});

test('the copy keeps lines, quantity, price, tax and total, and carries NO identity/payment/e-invoice fields', async () => {
  const c = await setup({ lists: same });
  try {
    const p = await dup(c);
    assert.equal(p.status, 'READY_FOR_APPROVAL');
    assert.equal(p.totals.total, '18100.00');
    assert.deepEqual(p.request.body.InvoiceItem, [{ item: 'Diesel', quantity: '10000', unit_price: '1.81', tax1: 1, tax2: 0, product_id: 4 }]);
    assert.deepEqual(p.request.body.Invoice, { client_id: 48, draft: 1, is_offline: 1, date: '2026-05-20', currency_code: 'SAR' });
    const wire = JSON.stringify(p.request);
    for (const leaked of ['97407', '007472', 'payment', 'S3CRET', 'hash=zzz', 'REPORTED', 'summary_', 'einvoice', '2026-05-01', 'store_id'])
      assert.equal(wire.includes(leaked), false, leaked);
  } finally { await c.done(); }
});

test('another matching invoice blocks the duplicate (source alongside it is still ignored); acknowledging that exact id releases it', async () => {
  const c = await setup({ lists: { invoices: [...same.invoices, { id: 97500, summary_total: '18100.00' }] } });
  try {
    const p = await dup(c);
    assert.equal(p.status, 'BLOCKED');
    assert.match(p.blocking.join(' '), /invoices#97500/); assert.doesNotMatch(p.blocking.join(' '), /invoices#97407/);
    assert.deepEqual(p.duplicates.map((d) => d.id), ['97500']);
    assert.equal((await dup(c, { ...dupBody, acknowledge_duplicates: ['invoices#97407'] })).status, 'BLOCKED');   // acknowledging the SOURCE does not hide the other one
    assert.equal((await dup(c, { ...dupBody, acknowledge_duplicates: ['invoices#97500'] })).status, 'READY_FOR_APPROVAL');
  } finally { await c.done(); }
});

test('a NORMAL new invoice (no duplicate command) is still blocked by an identical existing invoice, including 97407', async () => {
  const c = await setup({ lists: same });
  try {
    const input = { client_id: 48, date: '2026-05-20', items: [{ item: 'Diesel', quantity: '10000', unit_price: '1.81', tax1: 1, product_id: 4 }] };
    const p = await createProposal('sales_invoice', input, R(c));
    assert.equal(p.status, 'BLOCKED'); assert.match(p.blocking.join(' '), /invoices#97407/);
    // the exemption cannot be requested through caller input
    for (const k of ['duplicate_of', 'meta', 'source_fingerprint', 'exclude_source']) {      // unknown input keys are never honoured
      const q = await createProposal('sales_invoice', { ...input, [k]: { entity: 'invoices', id: SRC } }, R(c));
      assert.equal(q.status, 'BLOCKED', k); assert.match(q.blocking.join(' '), /invoices#97407/, k);
      assert.equal(q.meta.duplicate_of, undefined, k); assert.equal(JSON.stringify(q.request).includes(k), false, k);
    }
  } finally { await c.done(); }
});

test('invalid or untrustworthy sources are refused: missing, unreadable, wrong id, no id, wrong document type, bad id', async () => {
  const cases = [
    ['source not found', (c) => { c.state.status = 404; }, /not accessible|404|failed/],
    ['source API error', (c) => { c.state.status = 500; }, /failed|500/],
    ['returned id differs from the requested id', (c) => { c.state.header.id = 11111; }, /identity mismatch/],
    ['returned document has no id', (c) => { delete c.state.header.id; }, /no id of its own/],
    ['credit note as source', (c) => { c.state.header.type = 6; }, /cannot be duplicated/],
  ];
  for (const [name, mutate, rx] of cases) {
    const c = await setup({ lists: same });
    try { mutate(c); await assert.rejects(dup(c), rx, name); assert.equal(c.fake.posts.length, 0); } finally { await c.done(); }
  }
  const c = await setup({ lists: same });
  try { await assert.rejects(proposeDuplicate({ source: 'invoices', id: '97407/../1', overrides: dupBody }, R(c)), /Invalid invoice ID/); } finally { await c.done(); }
});

test('source changed after the preview => approval is refused at execution (nothing sent); payment-only changes do not matter', async () => {
  const mutations = {
    'quantity': (st) => { st.items = [{ ...item, quantity: 10001 }]; },
    'unit price': (st) => { st.items = [{ ...item, unit_price: '1.82' }]; },
    'extra line': (st) => { st.items = [item, { ...item, id: 2, item: 'Extra' }]; },
    'client': (st) => { st.header = { ...st.header, client_id: 49 }; },
    'header total': (st) => { st.header = { ...st.header, summary_total: '18101.00' }; },
    'tax': (st) => { st.items = [{ ...item, tax1: 2 }]; },
    'source deleted/unreadable': (st) => { st.status = 404; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const c = await setup({ lists: same });
    try {
      const p = await dup(c);
      assert.equal(p.status, 'READY_FOR_APPROVAL', name);
      mutate(c.state);
      await assert.rejects(executeProposal({ id: p.id, phrase: approvalPhrase(c.env, p) }, { env: c.env, fetcher: c.fake.fetch }),
        (e) => e.code === 'RECHECK_FAILED' && /Source invoices#97407/.test(e.message), name);
      assert.equal(c.fake.posts.length, 0, name);
    } finally { await c.done(); }
  }
  const c = await setup({ lists: same });
  c.fake.created.invoices = { 5001: { id: 5001, summary_total: '18100.00' } };
  try {
    const p = await dup(c);
    c.state.header = { ...c.state.header, payment_status: 0, summary_paid: '0.00', summary_unpaid: '18100.00' };   // settlement is never copied
    const r = await executeProposal({ id: p.id, phrase: approvalPhrase(c.env, p) }, { env: c.env, fetcher: c.fake.fetch });
    assert.equal(r.status, 'submitted'); assert.equal(c.fake.posts.length, 1); assert.equal(c.fake.posts[0].path, '/api2/invoices.json');
  } finally { await c.done(); }
});

test('a new matching invoice created after the preview still blocks at execution; the source stays ignored', async () => {
  const c = await setup({ lists: same });
  try {
    const p = await dup(c);
    assert.equal(p.status, 'READY_FOR_APPROVAL');
    c.fake.lists.invoices.push({ id: 97600, summary_total: '18100.00' });
    await assert.rejects(executeProposal({ id: p.id, phrase: approvalPhrase(c.env, p) }, { env: c.env, fetcher: c.fake.fetch }), (e) => e.code === 'RECHECK_FAILED' && /invoices#97600/.test(e.message));
    assert.equal(c.fake.posts.length, 0);
  } finally { await c.done(); }
});

test('FAIL CLOSED: duplicate-scan API failure or incomplete list blocks, even though the source is known', async () => {
  const bad = {
    'HTTP 500': () => new Response('{}', { status: 500 }),
    'missing pagination': () => new Response(JSON.stringify({ code: 200, data: [{ Invoice: { id: SRC } }] }), { status: 200 }),
    'fewer rows than total': () => new Response(JSON.stringify({ code: 200, data: [{ Invoice: { id: SRC, summary_total: '18100.00' } }], pagination: { prev: null, next: null, page: 1, page_count: 1, total_results: 3 } }), { status: 200 }),
  };
  for (const [name, respond] of Object.entries(bad)) {
    const c = await setup({ lists: same });
    const inner = c.fake.fetch;
    const fetcher = async (url, o) => (url.pathname === '/api2/invoices.json' && url.searchParams.get('limit') !== '1' ? respond() : inner(url, o));
    try {
      const p = await proposeDuplicate({ source: 'invoices', id: SRC, overrides: dupBody }, { env: c.env, fetcher, actor: 'u' });
      assert.equal(p.status, 'BLOCKED', name);
      assert.equal(p.checks.find((x) => x.name === 'no_remote_duplicate').ok, false, name);
    } finally { await c.done(); }
  }
});

test('the exemption is bound to the SIGNED proposal: editing duplicate_of / fingerprint in the stored file is TAMPERED; writes-disabled still refuses', async () => {
  const c = await setup({ lists: same });
  try {
    const p = await dup(c);
    const file = join(c.dir, 'daftra-ledger', 'proposals', p.id + '.json');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...raw, meta: { ...raw.meta, duplicate_of: { entity: 'invoices', id: '97500' } } }));
    await assert.rejects(executeProposal({ id: p.id, phrase: approvalPhrase(c.env, p) }, { env: c.env, fetcher: c.fake.fetch }), (e) => e.code === 'TAMPERED');
    await writeFile(file, JSON.stringify({ ...raw, meta: { ...raw.meta, source_fingerprint: '0'.repeat(64) } }));
    await assert.rejects(executeProposal({ id: p.id, phrase: approvalPhrase(c.env, p) }, { env: c.env, fetcher: c.fake.fetch }), (e) => e.code === 'TAMPERED');
    await writeFile(file, JSON.stringify(raw));
    await assert.rejects(executeProposal({ id: p.id, phrase: approvalPhrase(c.env, p) }, { env: { ...c.env, DAFTRA_WRITES_ENABLED: '0' }, fetcher: c.fake.fetch }), (e) => e.code === 'WRITES_DISABLED');
    await assert.rejects(executeProposal({ id: p.id, phrase: 'APPROVE wrong' }, { env: c.env, fetcher: c.fake.fetch }), (e) => e.code === 'PHRASE_MISMATCH');
    assert.equal(c.fake.posts.length, 0);
  } finally { await c.done(); }
});
