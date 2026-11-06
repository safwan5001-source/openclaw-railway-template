import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDaftra } from './daftra-fake.test-helper.mjs';
import { buildDuplicate, proposeDuplicate } from './daftra-duplicate.mjs';
import { approvalPhrase } from './daftra-auth.mjs';
import { executeProposal } from './daftra-write.mjs';
import { review } from './daftra-approve.mjs';

const OP = 'operator-secret-0123456789-0123456789-abcdef';
const srcInvoice = {
  id: 3, no: 'INV-000123', date: '2025-01-10', client_id: 4, currency_code: 'SAR', notes: 'ملاحظات', draft: 0, payment_status: 2,
  summary_total: '237.00', summary_paid: '237.00', summary_unpaid: '0.00', created: '2025-01-10 10:00:00', password: 'S3CRET',
  invoice_pdf_url: 'https://nepras.daftra.com/invoices/view/3.pdf?hash=abc', einvoice_status: 'REPORTED', discount: 0, shipping_amount: 0,
};
const srcItems = [
  { id: 71, invoice_id: 3, item: 'Diesel', description: 'bulk', quantity: 100, unit_price: 2, tax1: 1, tax2: null, product_id: 9, discount: 10, discount_type: 1, store_id: 1, col_3: 'x' },
  { id: 72, invoice_id: 3, item: 'Delivery', quantity: 1, unit_price: 30, tax1: 0, product_id: null },
];
function world(over = {}) {
  const fake = new FakeDaftra(over.seed);
  const sources = {
    invoices: { 3: { data: { Invoice: { ...srcInvoice, ...over.invoice }, InvoiceItem: over.items ?? srcItems, Payment: [{ id: 1, amount: '230' }] } } },
    estimates: { 8: { data: { Estimate: { id: 8, no: 'EST-8', date: '2025-01-05', client_id: 4, currency_code: 'SAR', summary_total: '10.00' }, InvoiceItem: [{ item: 'Svc', quantity: 1, unit_price: 10, tax1: 1 }] } } },
    purchase_invoices: { 5: { data: { PurchaseOrder: { id: 5, no: 'PO-5', date: '2025-01-05', supplier_id: 7, currency_code: 'SAR' }, PurchaseOrderItem: over.poItems ?? [{ item: 'Oil', quantity: 2, unit_price: 10, tax1: 15, tax2: null, product_id: null }] } } },
  };
  const inner = fake.fetch;
  fake.fetch = async (url, o = {}) => {
    const m = url.pathname.match(/^\/api2\/(invoices|estimates|purchase_invoices)\/(\d+)\.json$/);
    if ((o.method ?? 'GET') === 'GET' && m && sources[m[1]][m[2]]) {
      fake.calls.push({ method: 'GET', path: url.pathname, search: url.search });
      return new Response(JSON.stringify({ code: 200, ...sources[m[1]][m[2]] }), { status: 200 });
    }
    return inner(url, o);
  };
  return fake;
}
async function setup(over) {
  const dir = await mkdtemp(join(tmpdir(), 'basht-dup-'));
  const env = { OPENCLAW_WORKSPACE_DIR: dir, DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'k', DAFTRA_WRITES_ENABLED: '1', DAFTRA_APPROVAL_SECRET: OP };
  return { env, fake: world(over), done: () => rm(dir, { recursive: true, force: true }) };
}
const R = (c) => ({ env: c.env, fetcher: c.fake.fetch, actor: 'u' });

test('duplicating an invoice copies business data, never identity/payments/ZATCA, and shows original vs proposed', async () => {
  const c = await setup();
  try {
    const p = await proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01', line_overrides: { 1: { unit_price: '2.5' } } } }, R(c));
    assert.equal(p.status, 'READY_FOR_APPROVAL');
    assert.equal(p.type, 'sales_invoice');
    assert.equal(p.mode, 'draft');
    assert.equal(c.fake.posts.length, 0);                                   // preview only
    const body = p.request.body;
    assert.deepEqual(body.Invoice, { client_id: 4, draft: 1, date: '2025-03-01', notes: 'ملاحظات', currency_code: 'SAR' });
    assert.deepEqual(body.InvoiceItem[0], { item: 'Diesel', description: 'bulk', quantity: '100', unit_price: '2.5', tax1: 1, tax2: 0, discount: 10, discount_type: 1, product_id: 9 });
    const wire = JSON.stringify(body);
    for (const leaked of ['INV-000123', '"id"', 'payment', 'S3CRET', 'hash=', 'REPORTED', 'summary_', '2025-01-10', 'store_id', 'col_3'])
      assert.equal(wire.includes(leaked), false, leaked);
    assert.ok(JSON.stringify(p).includes('S3CRET') === false);
    const d = p.meta.diff;
    assert.equal(d.original.number, 'INV-000123');
    assert.deepEqual(d.lines[0].changed, ['unit_price']);
    assert.deepEqual(d.lines[1].changed, []);
    assert.ok(d.not_copied.includes('no') && d.not_copied.includes('summary_paid') && d.not_copied.includes('payment_status') && d.not_copied.includes('einvoice_status') && d.not_copied.includes('invoice_pdf_url') && d.not_copied.includes('payments'));
    assert.ok(d.header.some((h) => h.field === 'date' && h.original === '2025-01-10' && h.proposed === '2025-03-01'));
    const text = await review(p.id, c.env);
    assert.match(text, /DUPLICATE OF invoices#3 \(no\. INV-000123\)/);
    assert.match(text, /line 1 \(Diesel\): unit_price 2 => 2.5/);
    assert.match(text, /NOT copied:/);
  } finally { await c.done(); }
});

test('approved duplicate is sent exactly once as a NEW draft invoice, with no original identifiers', async () => {
  const c = await setup();
  c.fake.created.invoices = { 5001: { id: 5001, summary_total: '237.5' } };
  try {
    const p = await proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01' } }, R(c));
    assert.equal(p.status, 'READY_FOR_APPROVAL');
    const r = await executeProposal({ id: p.id, phrase: approvalPhrase(c.env, p) }, { env: c.env, fetcher: c.fake.fetch });
    assert.equal(r.status, 'submitted');
    assert.equal(c.fake.posts.length, 1);
    assert.equal(c.fake.posts[0].path, '/api2/invoices.json');
    assert.equal(JSON.parse(c.fake.posts[0].body).Invoice.draft, 1);
    // identical copy again: same request hash => blocked by the ledger (no double send of the same copy)
    const again = await proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01' } }, R(c));
    assert.equal(again.status, 'BLOCKED');
  } finally { await c.done(); }
});

test('safe defaults: date is mandatory, unknown/invalid overrides fail, empty documents are refused', async () => {
  const c = await setup();
  try {
    const d = (overrides, rx, id = 3, source = 'invoices') => assert.rejects(buildDuplicate({ source, id, overrides }, c.env, c.fake.fetch), rx, JSON.stringify(overrides));
    await d({}, /date .* required/);
    await d({ date: '2025-02-30' }, /required/);
    await d({ date: '2025-03-01', id: 5 }, /Unknown override: id/);
    await d({ date: '2025-03-01', payments: [] }, /Unknown override/);
    await d({ date: '2025-03-01', line_overrides: { 9: { unit_price: '1' } } }, /does not exist/);
    await d({ date: '2025-03-01', line_overrides: { 1: { store_id: 3 } } }, /unsupported field/);
    await d({ date: '2025-03-01', remove_lines: [1, 2] }, /no lines/);
    await d({ date: '2025-03-01' }, /source must be/, 3, 'expenses');
    await d({ date: '2025-03-01' }, /not accessible|404|failed/, 999);
    await assert.rejects(buildDuplicate({ source: 'invoices', id: '3/../4', overrides: { date: '2025-03-01' } }, c.env, c.fake.fetch), /Invalid invoice ID/);
  } finally { await c.done(); }
});

test('overrides can change party, prices, lines and notes; removed/added lines are shown in the diff', async () => {
  const c = await setup();
  try {
    const b = await buildDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01', client_id: 4, notes: 'new', remove_lines: [2], add_lines: [{ item: 'Extra', quantity: '1', unit_price: '5', tax1: 0 }], line_overrides: { 1: { quantity: '50' } } } }, c.env, c.fake.fetch);
    assert.equal(b.input.notes, 'new');
    assert.deepEqual(b.input.items.map((i) => i.item), ['Diesel', 'Extra']);
    assert.equal(b.input.items[0].quantity, '50');
    assert.deepEqual(b.diff.lines.map((l) => l.changed), [['quantity'], ['(line removed)'], ['(line added)']]);
  } finally { await c.done(); }
});

test('references are re-validated, not silently reused: missing product, inactive/unknown tax', async () => {
  let c = await setup({ seed: { records: { clients: { 4: { id: 4, business_name: 'c' } }, products: {} } } });
  try {
    const p = await proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01' } }, R(c));
    assert.equal(p.status, 'BLOCKED'); assert.match(p.blocking.join(' '), /product 9/);
  } finally { await c.done(); }
  c = await setup({ seed: { taxes: [{ id: 1, value: 15, included: 0, is_active: 0 }] } });
  try { await assert.rejects(proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01' } }, R(c)), /inactive/); } finally { await c.done(); }
  c = await setup({ seed: { taxes: [] } });
  try { await assert.rejects(proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01' } }, R(c)), /does not exist/); } finally { await c.done(); }
  c = await setup({ seed: { records: { clients: {}, products: { 9: { id: 9 } } } } });
  try {
    const p = await proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01' } }, R(c));
    assert.match(p.blocking.join(' '), /client 4/);
  } finally { await c.done(); }
});

test('header discount/shipping/deposit cannot be reproduced: blocked unless the requester accepts the difference', async () => {
  const c = await setup({ invoice: { discount: 5, shipping_amount: 12 } });
  try {
    const blocked = await proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01' } }, R(c));
    assert.equal(blocked.status, 'BLOCKED'); assert.match(blocked.blocking.join(' '), /discount\/shipping_amount/);
    const ok = await proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01', accept_total_difference: true } }, R(c));
    assert.equal(ok.status, 'READY_FOR_APPROVAL');
    assert.ok(ok.warnings.some((w) => /NOT reproduced/.test(w)));
  } finally { await c.done(); }
});

test('absolute line discounts are copied faithfully (type 2)', async () => {
  const c = await setup({ items: [{ item: 'Svc', quantity: 2, unit_price: 50, tax1: 1, product_id: null, discount: 10, discount_type: 2 }] });
  try {
    const p = await proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01' } }, R(c));
    assert.deepEqual([p.request.body.InvoiceItem[0].discount, p.request.body.InvoiceItem[0].discount_type], [10, 2]);
    assert.equal(p.totals.total, '103.50');                              // (100 - 10) * 1.15
  } finally { await c.done(); }
});

test('copying with the original date/client/total: the SOURCE alone no longer blocks, but any OTHER matching document does', async () => {
  const c = await setup({ seed: { lists: { invoices: [{ id: 3, summary_total: '237.00' }] } } });
  try {
    const p = await proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-01-10' } }, R(c));
    assert.equal(p.status, 'READY_FOR_APPROVAL', p.blocking?.join(' '));
    assert.deepEqual(p.duplicates, []);
  } finally { await c.done(); }
  const o = await setup({ seed: { lists: { invoices: [{ id: 3, summary_total: '237.00' }, { id: 9, summary_total: '237.00' }] } } });
  try {
    const p = await proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-01-10' } }, R(o));
    assert.equal(p.status, 'BLOCKED'); assert.match(p.blocking.join(' '), /invoices#9/); assert.doesNotMatch(p.blocking.join(' '), /invoices#3\b/);
    const ack = await proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-01-10', acknowledge_duplicates: ['invoices#9'] } }, R(o));
    assert.equal(ack.status, 'READY_FOR_APPROVAL');
  } finally { await o.done(); }
});

test('estimates and purchase invoices: own endpoints, purchase tax VALUE mapped to a unique tax id', async () => {
  const c = await setup();
  try {
    const e = await proposeDuplicate({ source: 'estimates', id: 8, overrides: { date: '2025-03-01' } }, R(c));
    assert.equal(e.type, 'estimate'); assert.equal(e.request.path, '/api2/estimates.json'); assert.equal(e.request.body.Invoice.draft, 1);
    const po = await proposeDuplicate({ source: 'purchase_invoices', id: 5, overrides: { date: '2025-03-01' } }, R(c));
    assert.equal(po.type, 'purchase_invoice'); assert.equal(po.request.path, '/api2/purchase_invoices.json'); assert.equal(po.request.query, 'send=draft');
    assert.equal(po.request.body.PurchaseOrder.supplier_id, 7);
    assert.equal(po.request.body.PurchaseOrderItem[0].tax1, 1);          // value 15 -> tax id 1
  } finally { await c.done(); }
  const amb = await setup({ seed: { taxes: [{ id: 1, value: 15, included: 0, is_active: 1 }, { id: 2, value: 15, included: 0, is_active: 1 }] } });
  try { await assert.rejects(buildDuplicate({ source: 'purchase_invoices', id: 5, overrides: { date: '2025-03-01' } }, amb.env, amb.fake.fetch), /matches 2 active taxes/); } finally { await amb.done(); }
  const none = await setup({ seed: { taxes: [{ id: 1, value: 5, included: 0, is_active: 1 }] } });
  try { await assert.rejects(buildDuplicate({ source: 'purchase_invoices', id: 5, overrides: { date: '2025-03-01' } }, none.env, none.fake.fetch), /matches 0 active taxes/); } finally { await none.done(); }
});

test('fail closed on unreadable sources: no items, malformed numbers, oversize', async () => {
  let c = await setup({ items: [] });
  try { await assert.rejects(buildDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01' } }, c.env, c.fake.fetch), /no readable line items/); } finally { await c.done(); }
  c = await setup({ items: [{ item: 'x', quantity: 1, unit_price: 1e-7, tax1: 0 }] });
  try { await assert.rejects(buildDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01' } }, c.env, c.fake.fetch), /not a plain decimal/); } finally { await c.done(); }
  c = await setup({ items: Array.from({ length: 101 }, () => ({ item: 'x', quantity: 1, unit_price: 1, tax1: 0 })) });
  try { await assert.rejects(buildDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01' } }, c.env, c.fake.fetch), /more than 100/); } finally { await c.done(); }
});

test('REVIEW#6 the copy total must equal the source total unless lines were edited or the difference is accepted', async () => {
  let c = await setup({ invoice: { summary_total: '999.00' } });
  try {
    const p = await proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01' } }, R(c));
    assert.equal(p.status, 'BLOCKED'); assert.match(p.blocking.join(' '), /differs from the source total \(999.00\)/);
    assert.equal((await proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01', accept_total_difference: true } }, R(c))).status, 'READY_FOR_APPROVAL');
    const edited = await proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01', line_overrides: { 1: { quantity: '50' } } } }, R(c));
    assert.equal(edited.status, 'READY_FOR_APPROVAL'); assert.ok(edited.warnings.some((w) => /lines were changed/.test(w)));
  } finally { await c.done(); }
  c = await setup({ invoice: { summary_discount: '12.00' } });
  try { assert.match((await proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01' } }, R(c))).blocking.join(' '), /summary_discount/); } finally { await c.done(); }
  c = await setup({ invoice: { adjustment_value: '5' } });
  try { assert.match((await proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01' } }, R(c))).blocking.join(' '), /adjustment_value/); } finally { await c.done(); }
});

test('REVIEW#6 only standard sources: credit/debit notes are refused; draft sources are flagged', async () => {
  let c = await setup({ invoice: { type: 6 } });
  try { await assert.rejects(buildDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01' } }, c.env, c.fake.fetch), /type 6 is not a standard/); } finally { await c.done(); }
  c = await setup({ invoice: { type: 0, draft: 1 } });
  try { assert.ok((await buildDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01' } }, c.env, c.fake.fetch)).warnings.some((w) => /itself a draft/.test(w))); } finally { await c.done(); }
});

test('REVIEW#6 purchase tax mapping: inclusive-only and duplicated mappings are refused; descriptions are not carried', async () => {
  let c = await setup({ seed: { taxes: [{ id: 1, value: 15, included: 1, is_active: 1 }] } });
  try { await assert.rejects(buildDuplicate({ source: 'purchase_invoices', id: 5, overrides: { date: '2025-03-01' } }, c.env, c.fake.fetch), /tax-INCLUSIVE/); } finally { await c.done(); }
  c = await setup({ poItems: [{ item: 'Oil', description: 'dropped', quantity: 2, unit_price: 10, tax1: 15, tax2: 15 }] });
  try { await assert.rejects(buildDuplicate({ source: 'purchase_invoices', id: 5, overrides: { date: '2025-03-01' } }, c.env, c.fake.fetch), /same tax id/); } finally { await c.done(); }
  c = await setup({ poItems: [{ item: 'Oil', description: 'dropped', quantity: 2, unit_price: 10, tax1: 15, discount: 5, discount_type: 1, product_id: '0' }] });
  try {
    const b = await buildDuplicate({ source: 'purchase_invoices', id: 5, overrides: { date: '2025-03-01' } }, c.env, c.fake.fetch);
    assert.equal('description' in b.input.items[0], false);
    assert.equal('product_id' in b.input.items[0], false);                     // product_id "0" means none
    assert.ok(b.warnings.some((w) => /line discounts are not documented/.test(w)));
    await assert.rejects(buildDuplicate({ source: 'purchase_invoices', id: 5, overrides: { date: '2025-03-01', line_overrides: { 1: { description: 'ANOTHER' } } } }, c.env, c.fake.fetch), /description is not supported on purchase/);
    await assert.rejects(buildDuplicate({ source: 'purchase_invoices', id: 5, overrides: { date: '2025-03-01', add_lines: [{ item: 'x', quantity: '1', unit_price: '1', tax1: 0, description: 'd' }] } }, c.env, c.fake.fetch), /unsupported field description/);
  } finally { await c.done(); }
});

test('REVIEW#3/#4 the operator review shows overridden duplicates and cannot be spoofed by control characters in source data', async () => {
  const evil = 'Diesel\u001b[2J\u001b[H FAKE\u202e\u009b';
  const c = await setup({ items: [{ item: evil, quantity: 1, unit_price: 5, tax1: 0 }, srcItems[0]], seed: { lists: { invoices: [{ id: 3, summary_total: '207.00' }] } }, invoice: { summary_total: '207.00' } });
  try {
    // the hostile line is REMOVED from the copy, so it only ever appears in the comparison shown to the operator
    const p = await proposeDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-01-10', remove_lines: [1], acknowledge_duplicates: ['invoices#3'] } }, R(c));
    assert.equal(p.status, 'READY_FOR_APPROVAL');
    const text = await review(p.id, c.env);
    assert.match(text, /!!! DUPLICATE WARNINGS OVERRIDDEN by the requester: invoices#3/);
    assert.equal(new RegExp('[\\u001b\\u009b\\r\\u202e]').test(text), false, 'no raw control/bidi characters reach the operator terminal');
    assert.match(text, /REMOVED \(Diesel\\u001b/);
    assert.equal((text.match(/^Hash    :/gm) ?? []).length, 1, 'a forged "Hash :" line is impossible');
  } finally { await c.done(); }
  // hostile text that WOULD be copied is refused outright by validation (fail closed)
  const n = await setup({ invoice: { notes: 'n\u001b[31m\rHash : forged' } });
  try { await assert.rejects(buildDuplicate({ source: 'invoices', id: 3, overrides: { date: '2025-03-01' } }, n.env, n.fake.fetch), undefined); } finally { await n.done(); }
});
