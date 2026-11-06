// Read-only diagnosis of a non-PDF "official PDF" answer. All data is fake; every request is a mock GET.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPage, diagnosePdfResponse, mediaType, PAGE_KINDS } from './daftra-pdf-diagnose.mjs';
import { downloadInvoicePdf } from './daftra-readonly.mjs';
import { fetchInvoicePdf } from './daftra-broker-reads.mjs';

const KEY = 'sk-test-DAFTRA-KEY-0123456789';
const TENANT = 'https://nepras.daftra.com';
const HASH = 'c06543fe13bd4850b521733687c53259';
const SECRET_NAME = 'Fake Customer LLC';            // stands for personal data inside the page: it must never come out
const SECRET_TOKEN = 'csrf-tok-ZZZ-987654321';
const env = { DAFTRA_BASE_URL: TENANT, DAFTRA_API_KEY: KEY };
const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });

const LOGIN = `<html><head><title>Login | Daftra</title></head><body><form><input type="hidden" name="t" value="${SECRET_TOKEN}"><input type="password" name="p"></form></body></html>`;
const LOGIN_AR = '<html><head><title>تسجيل الدخول</title></head><body></body></html>';
const VIEW = `<html><head><title>Invoice #97407</title></head><body><table><tr><td>${SECRET_NAME}</td></tr><tr><td>Total 10</td></tr></table></body></html>`;
const VIEW_NO_TITLE = `<html><body><h2>${SECRET_NAME}</h2><table><tr><td>فاتورة</td><td>الإجمالي</td></tr></table></body></html>`;
const ERR = '<html><head><title>404 Not Found</title></head><body>x</body></html>';
const ERR_AR = '<html><head><title>Daftra</title></head><body><h1>الرابط غير صالح</h1></body></html>';

test('classifyPage: login / invoice view / error / unknown / empty', () => {
  assert.equal(classifyPage(LOGIN), 'login');
  assert.equal(classifyPage(LOGIN_AR), 'login');
  assert.equal(classifyPage('<html><title>x</title><input type=password></html>'), 'login');
  assert.equal(classifyPage(VIEW), 'invoice_view');
  assert.equal(classifyPage(VIEW_NO_TITLE), 'invoice_view');
  assert.equal(classifyPage(ERR), 'error');
  assert.equal(classifyPage(ERR_AR), 'error');
  assert.equal(classifyPage('<html><title>Daftra</title><body>hello</body></html>'), 'unknown');
  assert.equal(classifyPage('<html><title>Daftra</title></html>', { status: 500 }), 'error');
  assert.equal(classifyPage('  \n'), 'empty');
  assert.equal(classifyPage(undefined), 'empty');
  assert.equal(classifyPage('<html>anything</html>', { loginPath: true }), 'login');
  assert.equal(classifyPage(LOGIN + ERR, { status: 404 }), 'login', 'login wins over error');
});

test('diagnosePdfResponse returns only status, media type, redirects and a page class from a fixed vocabulary', async () => {
  const d = await diagnosePdfResponse(html(VIEW), { redirects: 2 });
  assert.deepEqual(d, { http_status: 200, content_type: 'text/html', redirects: 2, page: 'invoice_view' });
  assert.ok(PAGE_KINDS.includes(d.page));
  const text = JSON.stringify(await diagnosePdfResponse(html(LOGIN), { redirects: 1 }));
  for (const leak of [SECRET_NAME, SECRET_TOKEN, 'password', '<', '://']) assert.equal(text.includes(leak), false, leak);
  assert.equal((await diagnosePdfResponse(html(ERR, 404))).page, 'error');
  const json = new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await diagnosePdfResponse(json), { http_status: 200, content_type: 'application/json', redirects: 0, page: 'not_html' });
  const pdf = new Response('%PDF-', { status: 200, headers: { 'content-type': 'application/pdf' } });
  assert.equal(await diagnosePdfResponse(pdf), null, 'a PDF is not diagnosed and its body is untouched');
  assert.equal(await pdf.text(), '%PDF-');
  assert.equal(mediaType('Text/HTML; charset=utf-8'), 'text/html');
  assert.equal(mediaType(null), 'none');
});

test('only the first 64 KiB is inspected (huge pages cannot stall or leak)', async () => {
  const big = '<html><head><title>Daftra</title></head><body>' + 'a'.repeat(10 * 1024 * 1024) + '<input type="password"></body></html>';
  assert.equal((await diagnosePdfResponse(html(big))).page, 'unknown');
});

// ---- end to end through both download paths -------------------------------------------------------------------------------
const invoiceBody = { data: { Invoice: { id: 97407, draft: 0, invoice_pdf_url: `${TENANT}/invoices/view/97407.pdf?hash=${HASH}` } } };
function scripted(hops) {
  let i = 0;
  return async (u) => {
    const url = new URL(String(u));
    if (url.pathname.startsWith('/api2/')) return new Response(JSON.stringify(invoiceBody), { status: 200, headers: { 'content-type': 'application/json' } });
    return hops[i++]();
  };
}
const redirect = (loc) => () => new Response('', { status: 302, headers: { location: loc } });
const cases = [
  ['login', LOGIN, 'page=login'],
  ['invoice view', VIEW, 'page=invoice_view'],
  ['error page', ERR, 'page=error'],
];
for (const [name, body, expected] of cases) {
  test(`97407-like case (2 redirects then 200 text/html): ${name} is reported as ${expected}, with no link, hash or page content`, async () => {
    const hops = () => [redirect('/invoices/preview/97407?hash=' + HASH), redirect('/invoices/show/97407'), () => html(body)];
    await assert.rejects(downloadInvoicePdf('97407', '/tmp/never-written.pdf', env, scripted(hops())), (e) =>
      e.message.includes(`[HTTP 200, text/html, 2 redirect(s), ${expected}]`) && !e.message.includes(HASH) && !e.message.includes('http') && !e.message.includes(SECRET_NAME) && !e.message.includes(SECRET_TOKEN));
    const r = await fetchInvoicePdf('97407', { env, fetcher: scripted(hops()) });
    assert.equal(r.status, 502);
    assert.deepEqual(r.diagnostic, { http_status: 200, content_type: 'text/html', redirects: 2, page: expected.slice(5) });
    const wire = JSON.stringify(r);
    for (const leak of [HASH, KEY, SECRET_NAME, SECRET_TOKEN, 'daftra.com']) assert.equal(wire.includes(leak), false, leak);
  });
}

test('a login redirect path still classifies as login even when the body is opaque', async () => {
  const fetcher = scripted([redirect('/users/login'), () => html('<html><body>ok</body></html>')]);
  const r = await fetchInvoicePdf('97407', { env, fetcher });
  assert.equal(r.diagnostic.page, 'login');
  assert.match(r.message, /signed-in session/);
});

test('a real PDF still downloads (no diagnostic)', async () => {
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n');
  const r = await fetchInvoicePdf('97407', { env, fetcher: scripted([() => new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } })]) });
  assert.equal(r.status, 200); assert.equal(r.diagnostic, undefined);
});
