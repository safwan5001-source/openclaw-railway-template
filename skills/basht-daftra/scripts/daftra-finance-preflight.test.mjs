import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareFinancialAction, assertBodyShape, hashRequest, canonicalJson } from './daftra-finance-preflight.mjs';
import { listRecords, getRecord, pdfUrl } from './daftra-readonly.mjs';

const env = { DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'dummy' };
const taxes = [
  { id: 1, name: 'VAT', value: 15, included: 0, is_active: 1 },
  { id: 2, name: 'VAT inclusive', value: 15, included: 1, is_active: 1 },
  { id: 3, name: 'Old', value: 5, included: 0, is_active: 0 },
];
const base = { client_id: 4, date: '2025-03-01', items: [{ item: 'Diesel', quantity: '1000', unit_price: '1.89', tax1: 1 }] };

test('financial actions only return a disabled preview', () => {
  const invoice = prepareFinancialAction('sales_invoice', base, { taxes });
  assert.equal(invoice.canSubmit, false);
  assert.equal(invoice.requiresExplicitApproval, true);
  assert.equal(invoice.status, 'PREVIEW_ONLY_NOT_SUBMITTED');
  const payment = prepareFinancialAction('invoice_payment', { invoice_id: 3, amount: '10.00', payment_method: 'cash' });
  assert.equal(payment.canSubmit, false);
  assert.throws(() => prepareFinancialAction('invoice_payment', { invoice_id: 3, amount: '0', payment_method: 'cash' }));
  assert.throws(() => prepareFinancialAction('unknown', {}));
});

test('totals use exact decimal arithmetic (no float drift) for exclusive tax', () => {
  const r = prepareFinancialAction('sales_invoice', base, { taxes });
  assert.deepEqual({ ...r.totals }, { subtotal: '1890.00', tax1: '283.50', tax2: '0.00', total: '2173.50', estimated: true });
  const tricky = prepareFinancialAction('sales_invoice', { ...base, items: [{ item: 'x', quantity: '3', unit_price: '0.1', tax1: 0 }] }, { taxes });
  assert.equal(tricky.totals.total, '0.30');            // 3 * 0.1 is 0.30000000000000004 in floats
  const rounding = prepareFinancialAction('sales_invoice', { ...base, items: [{ item: 'x', quantity: '1', unit_price: '0.05', tax1: 1 }] }, { taxes });
  assert.equal(rounding.totals.tax1, '0.01');            // 0.0075 rounds half-up
});

test('tax-inclusive prices split into net and tax', () => {
  const r = prepareFinancialAction('sales_invoice', { ...base, items: [{ item: 'x', quantity: '1', unit_price: '115', tax1: 2 }] }, { taxes });
  assert.equal(r.totals.subtotal, '100.00');
  assert.equal(r.totals.tax1, '15.00');
  assert.equal(r.totals.total, '115.00');
});

test('every line must state its tax explicitly and it must exist, be active', () => {
  const noTax = { ...base, items: [{ item: 'Diesel', quantity: '1', unit_price: '1' }] };
  assert.throws(() => prepareFinancialAction('sales_invoice', noTax, { taxes }), /tax1 is required/);
  const unknown = { ...base, items: [{ item: 'Diesel', quantity: '1', unit_price: '1', tax1: 99 }] };
  assert.throws(() => prepareFinancialAction('sales_invoice', unknown, { taxes }), /does not exist/);
  const inactive = { ...base, items: [{ item: 'Diesel', quantity: '1', unit_price: '1', tax1: 3 }] };
  assert.throws(() => prepareFinancialAction('sales_invoice', inactive, { taxes }), /inactive/);
  const zero = prepareFinancialAction('sales_invoice', { ...base, items: [{ item: 'Diesel', quantity: '1', unit_price: '1', tax1: 0 }] }, { taxes });
  assert.equal(zero.totals.tax1, '0.00');
  assert.ok(prepareFinancialAction('sales_invoice', base).warnings.some((w) => /Tax table not loaded/.test(w)));
});

test('rejects malformed amounts, dates, ids and lines', () => {
  const bad = (input, type = 'sales_invoice') => assert.throws(() => prepareFinancialAction(type, input, { taxes }), undefined, JSON.stringify(input));
  bad({ ...base, items: [{ item: 'x', quantity: '1', unit_price: '1e3', tax1: 0 }] });
  bad({ ...base, items: [{ item: 'x', quantity: '-1', unit_price: '1', tax1: 0 }] });
  bad({ ...base, items: [{ item: 'x', quantity: '0', unit_price: '1', tax1: 0 }] });
  bad({ ...base, items: [{ item: 'x', quantity: '1', unit_price: '1', tax1: 0, discount: '101' }] });
  bad({ ...base, items: [] });
  bad({ ...base, client_id: '4; DROP' });
  bad({ ...base, date: '2025-02-30' });
  bad({ ...base, date: '01/03/2025' });
  bad({ ...base, finalize: 'yes' });
  bad({ invoice_id: 3, amount: '10.001', payment_method: 'cash' }, 'invoice_payment');
  bad({ invoice_id: 3, amount: '10', payment_method: 'cash; rm' }, 'invoice_payment');
  bad({ client_id: 4, amount: '-5', payment_method: 'cash' }, 'client_payment');
  bad({ amount: '5', date: '2025-03-01' }, 'expense');
  bad({ amount: '5', description: 'x' }, 'expense');        // expense date is required
});

test('request bodies follow the documented Daftra shapes', () => {
  const inv = prepareFinancialAction('sales_invoice', base, { taxes });
  assert.deepEqual(inv.request.body.Invoice, { client_id: 4, draft: 1, is_offline: 1, date: '2025-03-01' });
  assert.deepEqual(inv.request.body.InvoiceItem[0], { item: 'Diesel', quantity: '1000', unit_price: '1.89', tax1: 1, tax2: 0 });
  assert.equal(inv.request.path, '/api2/invoices.json');
  assert.equal(inv.mode, 'draft');
  const fin = prepareFinancialAction('sales_invoice', { ...base, finalize: true }, { taxes });
  assert.equal(fin.request.body.Invoice.draft, 0);
  assert.equal(Object.hasOwn(fin.request.body.Invoice, 'is_offline'), false);
  assert.ok(fin.effects.includes('may_trigger_e_invoice_submission'));
  const po = prepareFinancialAction('purchase_invoice', { supplier_id: 7, date: '2025-03-01', items: [{ item: 'Oil', quantity: '2', unit_price: '10', tax1: 0 }] }, { taxes });
  assert.equal(po.request.path, '/api2/purchase_invoices.json');
  assert.equal(po.request.query, 'send=draft');
  assert.ok(po.request.body.PurchaseOrder && po.request.body.PurchaseOrderItem);
  const exp = prepareFinancialAction('expense', { amount: '12.5', date: '2025-03-01', description: 'ديزل' });
  assert.equal(exp.request.query, 'send=draft');
  assert.equal(exp.request.body.Expense.status, 'draft');
  assert.equal(exp.request.body.Expense.amount, '12.50');
  const pay = prepareFinancialAction('invoice_payment', { invoice_id: 3, amount: '10', payment_method: 'cash', date: '2025-03-01' });
  assert.deepEqual(pay.request.body, { InvoicePayment: { invoice_id: 3, amount: '10.00', payment_method: 'cash', date: '2025-03-01' } });
  assert.equal(pay.mode, 'final');
  assert.equal(pay.reversible.startsWith('no'), true);
  const cp = prepareFinancialAction('client_payment', { client_id: 4, amount: '10', payment_method: 'bank' });
  assert.ok(cp.request.body.ClientPayment);
});

test('invoices never send unique_id (Daftra then recalculates offers); expenses carry the idempotency key', () => {
  assert.equal(JSON.stringify(prepareFinancialAction('sales_invoice', base, { taxes }).request).includes('unique_id'), false);
  const e = prepareFinancialAction('expense', { amount: '1', date: '2025-03-01', description: 'x' }, { idempotencyKey: 'basht-abc' });
  assert.equal(e.request.body.Expense.unique_id, 'basht-abc');
});

test('request hash is canonical: key order is irrelevant, any change alters it', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  const a = prepareFinancialAction('sales_invoice', base, { taxes });
  const b = prepareFinancialAction('sales_invoice', { ...base, items: [{ ...base.items[0], quantity: '1001' }] }, { taxes });
  assert.notEqual(a.request_hash, b.request_hash);
  assert.equal(a.request_hash, hashRequest(a.request));
  assert.doesNotThrow(() => JSON.stringify(a));            // no BigInt leaks into serialisable output
});

test('read-only entities are allowlisted with GET only', async () => {
  const requests = [];
  const fetcher = async (url, opts) => {
    requests.push({ path: url.pathname, method: opts.method, header: opts.headers.APIKEY });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  await listRecords('estimates', env, fetcher);
  await getRecord('products', 23, env, fetcher);
  assert.deepEqual(requests.map(x => x.path), ['/api2/estimates.json', '/api2/products/23.json']);
  assert.ok(requests.every(x => x.method === 'GET' && x.header === 'dummy'));
  await assert.rejects(listRecords('../admin', env, fetcher), /not authorized/);
});

test('PDF URL retains official path and rejects other origins', () => {
  const url = pdfUrl({data:{Invoice:{invoice_pdf_url:'https://nepras.daftra.com/invoices/view/2621.pdf?hash=abc'}}},env);
  assert.equal(url.pathname, '/invoices/view/2621.pdf');
  assert.throws(() => pdfUrl({data:{Invoice:{invoice_pdf_url:'https://evil.example/a.pdf'}}},env));
});

test('sales-invoice draft is created offline (is_offline:1, draft:1); final invoice and estimate are unchanged', () => {
  const draft = prepareFinancialAction('sales_invoice', base, { taxes });
  assert.equal(draft.mode, 'draft');
  assert.equal(draft.request.body.Invoice.draft, 1);
  assert.equal(draft.request.body.Invoice.is_offline, 1);
  assert.equal(draft.request.query, '');
  assert.doesNotThrow(() => assertBodyShape('sales_invoice', draft.request.body));
  const final = prepareFinancialAction('sales_invoice', { ...base, finalize: true }, { taxes });
  assert.equal(final.mode, 'final');
  assert.deepEqual(final.request.body.Invoice, { client_id: 4, draft: 0, date: '2025-03-01' });
  assert.ok(final.effects.includes('may_trigger_e_invoice_submission'));
  const est = prepareFinancialAction('estimate', base, { taxes });
  assert.equal(Object.hasOwn(est.request.body.Invoice, 'is_offline'), false);
  // input cannot influence the flag
  assert.equal(prepareFinancialAction('sales_invoice', { ...base, is_offline: 0 }, { taxes }).request.body.Invoice.is_offline, 1);
  assert.equal(Object.hasOwn(prepareFinancialAction('sales_invoice', { ...base, finalize: true, is_offline: 1 }, { taxes }).request.body.Invoice, 'is_offline'), false);
});

test('body allowlist: is_offline must be integer 1 on a draft only; email/send fields and other values are refused', () => {
  const items = [{ item: 'x', quantity: '1', unit_price: '1', tax1: 0, tax2: 0 }];
  const body = (Invoice) => ({ Invoice: { client_id: 4, date: '2025-03-01', ...Invoice }, InvoiceItem: items });
  assert.doesNotThrow(() => assertBodyShape('sales_invoice', body({ draft: 1, is_offline: 1 })));
  assert.doesNotThrow(() => assertBodyShape('sales_invoice', body({ draft: 0 })));
  for (const bad of [
    { draft: 1, is_offline: 0 }, { draft: 1, is_offline: '1' }, { draft: 1, is_offline: true }, { draft: 1, is_offline: 2 },
    { draft: 1, is_offline: null }, { draft: 0, is_offline: 1 }, { draft: '1', is_offline: 1 }, { draft: 2 },
    { draft: 1, is_offline: 1, send_email: 1 }, { draft: 1, is_offline: 1, email: 'a@b.c' }, { draft: 1, is_offline: 1, send_to_client: 1 },
    { draft: 1, is_offline: 1, is_online: 1 }, { draft: 1, is_offline: 1, no: 'X-1' },
  ]) assert.throws(() => assertBodyShape('sales_invoice', body(bad)), /Invoice/, JSON.stringify(bad));
  // is_offline is not part of any other document's allowlist
  assert.throws(() => assertBodyShape('estimate', body({ draft: 1, is_offline: 1 })), /unexpected fields/);
});
