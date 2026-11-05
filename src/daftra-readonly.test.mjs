import test from 'node:test';
import assert from 'node:assert/strict';
import { getInvoice, invoiceId, pdfUrl, downloadInvoicePdf } from './daftra-readonly.mjs';

const env = { DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'placeholder-test-key' };
test('rejects invalid invoice ids', () => {
  for (const id of ['../users', '1/2', '0', '01', 'x', '']) assert.throws(() => invoiceId(id));
});
test('only fetches GET with APIKEY header and no redirects', async () => {
  let checked = false;
  const fetcher = async (url, options) => {
    checked = true;
    assert.equal(url.pathname, '/api2/invoices/123.json');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.APIKEY, env.DAFTRA_API_KEY);
    return new Response(JSON.stringify({ data: { Invoice: { invoice_pdf_url: 'https://nepras.daftra.com/invoices/view/123.pdf?hash=test' } } }), { status: 200 });
  };
  await getInvoice('123', env, fetcher);
  assert.equal(checked, true);
});
test('rejects cross-tenant PDF URLs', () => {
  for (const url of ['https://evil.example/invoice.pdf', 'http://nepras.daftra.com/a.pdf', 'https://other.daftra.com/a.pdf']) {
    assert.throws(() => pdfUrl({ data: { Invoice: { invoice_pdf_url: url } } }, env));
  }
});
test('does not save HTML disguised as PDF', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ data: { Invoice: { invoice_pdf_url: 'https://nepras.daftra.com/invoices/view/123.pdf?hash=test' } } }), { status: 200 });
    return new Response('<html>not a pdf</html>', { headers: { 'content-type': 'text/html' } });
  };
  await assert.rejects(downloadInvoicePdf('123', '/tmp/basht-test-invalid.pdf', env, fetcher), /not PDF/);
});
