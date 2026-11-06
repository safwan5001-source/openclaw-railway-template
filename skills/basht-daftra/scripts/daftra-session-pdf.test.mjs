// Official PDF through the operator's Daftra session: GET-only, tenant-only, no redirects to anywhere unexpected. Fake data, mock fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSessionPdf, SESSION_PDF_PATHS } from './daftra-session-pdf.mjs';

const TENANT = 'https://nepras.daftra.com';
const COOKIE = 'OISystem=abc123DEF456ghi789JKL012mno345; lang=ar';
const KEY = 'sk-test-DAFTRA-KEY-0123456789';
const env = { DAFTRA_BASE_URL: TENANT, DAFTRA_API_KEY: KEY };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const pdf = () => new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });
const redirect = (location, status = 302) => new Response('', { status, headers: { location } });

function scripted(...hops) {
  const calls = []; let i = 0;
  const fetcher = async (u, o = {}) => {
    calls.push({ url: new URL(String(u)), method: o.method, redirect: o.redirect, headers: o.headers });
    const hop = hops[i++];
    if (!hop) throw new Error('unexpected extra request');
    return typeof hop === 'function' ? hop() : hop;
  };
  return { fetcher, calls };
}
const run = (id, s, over = {}) => fetchSessionPdf(id, { cookieHeader: COOKIE, env, fetcher: s.fetcher, ...over });

test('the owner-area PDF page is requested first; a PDF is returned with the redirect count', async () => {
  const s = scripted(pdf());
  const r = await run('97900', s);
  assert.equal(r.kind, 'pdf'); assert.equal(Buffer.from(r.bytes).equals(PDF), true); assert.equal(r.redirects, 0);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url.href, TENANT + '/owner/invoices/view/97900.pdf');
  assert.deepEqual(SESSION_PDF_PATHS('5'), ['/owner/invoices/view/5.pdf', '/invoices/view/5.pdf']);
});

test('GET only, tenant host only, cookie sent, and NO api key / Authorization / any other credential', async () => {
  const s = scripted(redirect('/invoices/view/97900.pdf?x=1'), pdf());
  assert.equal((await run('97900', s)).kind, 'pdf');
  for (const c of s.calls) {
    assert.equal(c.method, 'GET'); assert.equal(c.redirect, 'manual'); assert.equal(c.url.hostname, 'nepras.daftra.com');
    assert.deepEqual(Object.keys(c.headers).map((h) => h.toLowerCase()).sort(), ['accept', 'cookie', 'user-agent']);
    assert.equal(c.headers.Cookie, COOKIE);
    assert.equal(JSON.stringify(c.headers).includes(KEY), false);
  }
});

test('a redirect to a login route ends the attempt WITHOUT requesting it and reports an expired session', async () => {
  // '/' and the absolute root are what the live tenant answers when no valid session is sent (observed on both PDF routes)
  for (const loc of ['/', 'https://nepras.daftra.com/', '/users/login', '/login?next=/owner/invoices/view/97900', 'https://nepras.daftra.com/owner/login', '/sign-in']) {
    const s = scripted(redirect(loc), pdf());
    const r = await run('97900', s);
    assert.equal(r.kind, 'problem'); assert.equal(r.expired, true);
    assert.match(r.message, /^Daftra session expired or rejected \[HTTP 302, 1 redirect\(s\), page=login\]: reconnect it in the operator console$/);
    assert.deepEqual(r.diagnostic, { http_status: 302, content_type: 'none', redirects: 1, page: 'login' });
    assert.equal(s.calls.length, 1, 'the login page is never fetched: ' + loc);
  }
});

test('a login PAGE served with HTTP 200 is also an expired session (classified from the body, nothing stored)', async () => {
  const s = scripted(html('<html><head><title>Login</title></head><body><input type="password"></body></html>'));
  const r = await run('97900', s);
  assert.equal(r.expired, true); assert.equal(r.diagnostic.page, 'login'); assert.equal(s.calls.length, 1);
  assert.equal(JSON.stringify(r).includes('password'), false);
});

test('unexpected redirects are refused before being requested: other host, http, other path (e.g. a delete action), credentials, port', async () => {
  const bad = ['https://evil.example/owner/invoices/view/97900.pdf', 'https://files.daftra.com/owner/invoices/view/97900.pdf', 'http://nepras.daftra.com/owner/invoices/view/97900.pdf',
    '/owner/invoices/delete/97900', '/owner/invoices/view/97901.pdf', '/owner/invoices/view/97900.pdf/../../logout', 'https://u:p@nepras.daftra.com/owner/invoices/view/97900.pdf', 'https://nepras.daftra.com:8443/owner/invoices/view/97900.pdf', 'javascript:alert(1)', ''];
  for (const loc of bad) {
    const s = scripted(redirect(loc), pdf());
    const r = await run('97900', s);
    assert.equal(r.kind, 'problem', loc); assert.equal(r.expired, false);
    assert.match(r.message, /unexpected (destination|page)/);
    assert.equal(s.calls.length, 1, 'never requested: ' + loc);
    for (const leak of ['evil.example', 'delete', COOKIE, 'abc123DEF456']) assert.equal(JSON.stringify(r).includes(leak), false, leak);
  }
});

test('at most 3 redirects, then the attempt stops', async () => {
  const same = () => redirect('/invoices/view/97900.pdf');
  const s = scripted(same, same, same, same, pdf());
  const r = await run('97900', s);
  assert.equal(r.kind, 'problem'); assert.match(r.message, /too many redirects/);
  assert.equal(s.calls.length, 4);
});

test('a 404 / HTML view on the first path falls through to the second fixed path; both failing reports status, media type, redirects and page class only', async () => {
  const ok = scripted(html('<html><title>404 Not Found</title></html>', 404), pdf());
  const r1 = await run('97900', ok);
  assert.equal(r1.kind, 'pdf'); assert.deepEqual(ok.calls.map((c) => c.url.pathname), ['/owner/invoices/view/97900.pdf', '/invoices/view/97900.pdf']);
  const view = '<html><head><title>Invoice #97900</title></head><body><table><tr><td>Fake Customer LLC</td></tr><tr><td>Total 5</td></tr></table></body></html>';
  const both = scripted(html(view), html(view));
  const r2 = await run('97900', both);
  assert.equal(r2.kind, 'problem'); assert.equal(r2.expired, false);
  assert.equal(r2.message, 'Daftra did not return a PDF for this invoice [HTTP 200, text/html, 0 redirect(s), page=invoice_view]');
  assert.equal(JSON.stringify(r2).includes('Fake Customer'), false);
});

test('size and content guards: HTML named .pdf is not saved, a truncated PDF and an oversized one are refused', async () => {
  const truncated = scripted(new Response('%PDF-1.4 no end marker', { status: 200, headers: { 'content-type': 'application/pdf' } }));
  assert.match((await run('97900', truncated)).message, /Invalid, truncated or oversized PDF/);
  const big = scripted(new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': String(21 * 1024 * 1024) } }));
  assert.equal((await run('97900', big)).message, 'PDF exceeds size limit');
});

test('input is validated: only a numeric id and a non-empty cookie are accepted; the URL is never built from anything else', async () => {
  const s = scripted(pdf());
  for (const bad of ['0', '../1', '1/../2', '1.pdf', 'abc', '', '1234567890123456', 12]) await assert.rejects(run(bad, s), /Invalid invoice id/);
  await assert.rejects(fetchSessionPdf('1', { cookieHeader: '', env, fetcher: s.fetcher }), /No Daftra session/);
  await assert.rejects(fetchSessionPdf('1', { cookieHeader: null, env, fetcher: s.fetcher }), /No Daftra session/);
  assert.equal(s.calls.length, 0);
});
