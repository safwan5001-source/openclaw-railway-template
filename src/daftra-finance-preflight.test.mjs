import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareFinancialAction } from './daftra-finance-preflight.mjs';
import { listRecords, getRecord, pdfUrl } from './daftra-readonly.mjs';
const env = { DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'dummy' };
test('financial actions only return a disabled preview', () => {
  const invoice = prepareFinancialAction('sales_invoice', { client_id: 4, items: [{ item: 'Diesel', quantity: '1000', unit_price: '1.89' }] });
  assert.equal(invoice.canSubmit, false);
  assert.equal(invoice.requiresExplicitApproval, true);
  assert.equal(invoice.status, 'PREVIEW_ONLY_NOT_SUBMITTED');
  const payment = prepareFinancialAction('invoice_payment', { invoice_id: 3, amount: '10.00', payment_method: 'cash' });
  assert.equal(payment.canSubmit, false);
  assert.throws(() => prepareFinancialAction('invoice_payment', { invoice_id: 3, amount: '0', payment_method: 'cash' }));
  assert.throws(() => prepareFinancialAction('sales_invoice', {client_id: 3, items:[{item:'x', quantity: '1', unit_price:'0.999'}]}));
  assert.throws(() => prepareFinancialAction('unknown', {}));
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
