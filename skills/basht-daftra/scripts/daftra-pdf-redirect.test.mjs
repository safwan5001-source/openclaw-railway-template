// Official invoice PDF: redirect handling is safe, key-less and leak-free. All data is fake; every request is a mock GET.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadInvoicePdf, assertPdfRedirectTarget, trustedPdfRedirectHosts, fetchOfficialPdfResponse, invoiceIsDraft } from './daftra-readonly.mjs';
import { fetchInvoicePdf } from './daftra-broker-reads.mjs';

const KEY = 'sk-test-DAFTRA-KEY-0123456789';
const TENANT = 'https://nepras.daftra.com';
const HASH = 'c06543fe13bd4850b521733687c53259';
const PDF_URL = `${TENANT}/invoices/view/97900.pdf?hash=${HASH}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const env = { DAFTRA_BASE_URL: TENANT, DAFTRA_API_KEY: KEY };
const pdfRes = () => new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
const redirect = (location, status = 302) => new Response('', { status, headers: location === null ? {} : { location } });
const jsonRes = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const invoiceBody = (draft = 0) => ({ data: { Invoice: { id: 97900, draft, invoice_pdf_url: PDF_URL } } });

// fetcher: invoice JSON on /api2/, otherwise the scripted document hops (by request order). Records every request.
function scripted(docHops, { draft = 0 } = {}) {
  const calls = []; let i = 0;
  const fetcher = async (u, o = {}) => {
    const url = new URL(String(u));
    calls.push({ url: url.href, headers: o.headers, redirect: o.redirect, method: o.method });
    if (url.pathname.startsWith('/api2/')) return jsonRes(invoiceBody(draft));
    const hop = docHops[i++];
    if (!hop) throw new Error('unexpected extra request: ' + url.origin);
    return typeof hop === 'function' ? hop(url) : hop;
  };
  return { fetcher, calls, docCalls: () => calls.filter((c) => !new URL(c.url).pathname.startsWith('/api2/')) };
}
const tmp = async () => { const dir = await mkdtemp(join(tmpdir(), 'basht-pdf-redirect-')); return { dir, out: join(dir, 'inv.pdf'), done: () => rm(dir, { recursive: true, force: true }) }; };

// ---------- functional ----------------------------------------------------------------------------------------------------
test('a 302 to a same-tenant URL is followed and the official PDF is saved (invoice 97900 case)', async () => {
  const t = await tmp(); const s = scripted([redirect(`/invoices/download/97900.pdf?hash=${HASH}`), pdfRes()]);
  try {
    const r = await downloadInvoicePdf('97900', t.out, env, s.fetcher);
    assert.deepEqual({ size: r.size, source: r.source, redirects: r.redirects, draft: r.draft }, { size: PDF.length, source: 'daftra_official', redirects: 1, draft: false });
    assert.equal((await readFile(t.out)).equals(PDF), true);
    assert.equal(((await stat(t.out)).mode & 0o777), 0o600);
    assert.equal(s.docCalls().length, 2);
    assert.equal(s.docCalls()[1].url, `${TENANT}/invoices/download/97900.pdf?hash=${HASH}`);   // relative Location resolved against the current hop
  } finally { await t.done(); }
});

test('301/303/307/308 are followed as GET; a redirect chain of 3 works, 4 is refused', async () => {
  for (const status of [301, 303, 307, 308]) {
    const s = scripted([redirect('/a.pdf', status), pdfRes()]);
    const { response, redirects } = await fetchOfficialPdfResponse(new URL(PDF_URL), { env, fetcher: s.fetcher });
    assert.equal(response.status, 200); assert.equal(redirects, 1, String(status));
    assert.ok(s.docCalls().every((c) => c.method === 'GET'));
  }
  const three = scripted([redirect('/1.pdf'), redirect('/2.pdf'), redirect('/3.pdf'), pdfRes()]);
  assert.equal((await fetchOfficialPdfResponse(new URL(PDF_URL), { env, fetcher: three.fetcher })).redirects, 3);
  const four = scripted([redirect('/1.pdf'), redirect('/2.pdf'), redirect('/3.pdf'), redirect('/4.pdf'), pdfRes()]);
  await assert.rejects(fetchOfficialPdfResponse(new URL(PDF_URL), { env, fetcher: four.fetcher }), /too many redirects/);
  assert.equal(four.docCalls().length, 4);
  const loop = scripted([redirect(PDF_URL), redirect(PDF_URL), redirect(PDF_URL), redirect(PDF_URL), redirect(PDF_URL)]);
  await assert.rejects(fetchOfficialPdfResponse(new URL(PDF_URL), { env, fetcher: loop.fetcher }), /too many redirects/);
});

test('a first-party *.daftra.com host is accepted; a storage/CDN host needs the operator allowlist (exact hostnames only)', async () => {
  const first = scripted([redirect(`https://files.daftra.com/pdf/97900.pdf?sig=zz`), pdfRes()]);
  assert.equal((await fetchOfficialPdfResponse(new URL(PDF_URL), { env, fetcher: first.fetcher })).redirects, 1);
  const cdn = 'https://pdfs.example-storage.com/97900.pdf?X-Amz-Signature=abc';
  const denied = scripted([redirect(cdn), pdfRes()]);
  await assert.rejects(fetchOfficialPdfResponse(new URL(PDF_URL), { env, fetcher: denied.fetcher }), /untrusted destination host pdfs\.example-storage\.com/);
  assert.equal(denied.docCalls().length, 1, 'the untrusted host is never requested');
  const allowedEnv = { ...env, DAFTRA_PDF_REDIRECT_HOSTS: ' pdfs.example-storage.com , *.wild.example, 10.0.0.1, http://x.example, bad host ' };
  assert.deepEqual([...trustedPdfRedirectHosts(allowedEnv)], ['pdfs.example-storage.com']);
  const allowed = scripted([redirect(cdn), pdfRes()]);
  assert.equal((await fetchOfficialPdfResponse(new URL(PDF_URL), { env: allowedEnv, fetcher: allowed.fetcher })).redirects, 1);
});

test('official PDF of a DRAFT invoice is attempted; the result carries draft:true and a failure explains it without leaking the link', async () => {
  const t = await tmp();
  try {
    const ok = scripted([pdfRes()], { draft: 1 });
    assert.equal((await downloadInvoicePdf('97900', t.out, env, ok.fetcher)).draft, true);
  } finally { await t.done(); }
  const t2 = await tmp();
  try {
    const gone = scripted([new Response('nope', { status: 404 })], { draft: 1 });
    await assert.rejects(downloadInvoicePdf('97900', t2.out, env, gone.fetcher), (e) => /HTTP 404/.test(e.message) && /draft/.test(e.message) && !e.message.includes(HASH));
    const finalGone = scripted([new Response('nope', { status: 404 })], { draft: 0 });
    await assert.rejects(downloadInvoicePdf('97900', t2.out, env, finalGone.fetcher), (e) => /HTTP 404/.test(e.message) && !/draft/.test(e.message));
  } finally { await t2.done(); }
  assert.equal(invoiceIsDraft({ data: { Invoice: { draft: '1' } } }), true);
  assert.equal(invoiceIsDraft({ Invoice: { draft: true } }), true);
  assert.equal(invoiceIsDraft({ data: { Invoice: { draft: 0 } } }), false);
  assert.equal(invoiceIsDraft(null), false);
});

test('a redirect to a login/HTML page is not saved as a PDF; nothing is written', async () => {
  const t = await tmp(); const s = scripted([redirect('/users/login'), new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } })]);
  try {
    await assert.rejects(downloadInvoicePdf('97900', t.out, env, s.fetcher), (e) =>
      /not PDF \[HTTP 200, text\/html, 1 redirect\(s\), page=login\] Daftra requires a signed-in session/.test(e.message) && !e.message.includes(HASH) && !e.message.includes('http'));
    await assert.rejects(stat(t.out));
  } finally { await t.done(); }
});

test('non-PDF 200 without redirect reports status and media type only (no URL, no hash)', async () => {
  const t = await tmp(); const s = scripted([new Response('<html>x</html>', { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } })], { draft: 1 });
  try {
    await assert.rejects(downloadInvoicePdf('97900', t.out, env, s.fetcher), (e) =>
      /not PDF \[HTTP 200, text\/html, 0 redirect\(s\), page=unknown\]/.test(e.message) && /draft/.test(e.message) && !/login/.test(e.message) && !e.message.includes(HASH));
  } finally { await t.done(); }
});

test('broker read proxy follows the safe redirect, reports draft/redirects, and refuses an unsafe one without requesting it', async () => {
  const ok = scripted([redirect('/invoices/download/97900.pdf'), pdfRes()], { draft: 1 });
  const r = await fetchInvoicePdf('97900', { env, fetcher: ok.fetcher });
  assert.deepEqual({ status: r.status, draft: r.draft, redirects: r.redirects }, { status: 200, draft: true, redirects: 1 });
  assert.equal(Buffer.from(r.base64, 'base64').equals(PDF), true);
  const bad = scripted([redirect(`https://evil.example/x.pdf?hash=${HASH}`), pdfRes()]);
  const b = await fetchInvoicePdf('97900', { env, fetcher: bad.fetcher });
  assert.equal(b.status, 502); assert.match(b.message, /redirect refused/); assert.equal(b.message.includes(HASH), false);
  assert.equal(bad.docCalls().length, 1);
});

// ---------- security ------------------------------------------------------------------------------------------------------
test('NO hop ever carries the API key, Authorization, Cookie or any header; only the invoice lookup does', async () => {
  const t = await tmp(); const s = scripted([redirect('/a.pdf'), redirect('https://files.daftra.com/b.pdf'), pdfRes()]);
  try {
    await downloadInvoicePdf('97900', t.out, env, s.fetcher);
    const docs = s.docCalls(); assert.equal(docs.length, 3);
    for (const c of docs) { assert.equal(c.headers, undefined); assert.equal(c.redirect, 'manual'); assert.equal(c.method, 'GET'); }
    const api = s.calls.find((c) => new URL(c.url).pathname.startsWith('/api2/'));
    assert.equal(api.headers.APIKEY, KEY);
    assert.equal(JSON.stringify(docs).includes(KEY), false);
  } finally { await t.done(); }
});

test('unsafe redirect targets are refused BEFORE being requested, and the error never contains the link, path or token', async () => {
  const unsafe = [
    'http://nepras.daftra.com/a.pdf',                       // downgrade to http
    'https://evil.example/a.pdf?hash=SECRET',               // foreign domain
    'https://nepras.daftra.com.evil.example/a.pdf',         // suffix-lookalike
    'https://evildaftra.com/a.pdf',                         // not a *.daftra.com subdomain
    'https://daftra.com.evil.example/a.pdf',
    'https://user:pass@nepras.daftra.com/a.pdf',            // credentials
    'https://nepras.daftra.com:8443/a.pdf',                 // non-standard port
    'https://127.0.0.1/a.pdf', 'https://[::1]/a.pdf', 'https://169.254.169.254/latest/meta-data/', 'https://0x7f000001/a.pdf', 'https://2130706433/a.pdf',
    'https://localhost/a.pdf', 'https://internal/a.pdf', 'https://metadata.google.internal/a.pdf',
    '//evil.example/a.pdf',                                 // protocol-relative to a foreign host
    'javascript:alert(1)', 'data:application/pdf;base64,JVBERi0=', 'file:///etc/passwd', 'ftp://nepras.daftra.com/a.pdf',
    'https://evil.example\\@nepras.daftra.com/a.pdf',       // backslash confusion
    '', 'x'.repeat(5000),
  ];
  for (const location of unsafe) {
    const s = scripted([redirect(location), pdfRes()]);
    await assert.rejects(fetchOfficialPdfResponse(new URL(PDF_URL), { env, fetcher: s.fetcher }), (e) => /PDF redirect refused|redirect without a destination/.test(e.message) && !/SECRET|a\.pdf|latest|passwd|pass@/.test(e.message), JSON.stringify(location).slice(0, 60));
    assert.equal(s.docCalls().length, 1, 'only the original document request was made: ' + JSON.stringify(location).slice(0, 60));
  }
  const missing = scripted([redirect(null)]);
  await assert.rejects(fetchOfficialPdfResponse(new URL(PDF_URL), { env, fetcher: missing.fetcher }), /without a destination/);
});

test('a refused hop in the middle of a chain stops the chain; a later hop is never fetched', async () => {
  const s = scripted([redirect('/ok.pdf'), redirect('https://evil.example/x.pdf'), pdfRes()]);
  await assert.rejects(fetchOfficialPdfResponse(new URL(PDF_URL), { env, fetcher: s.fetcher }), /untrusted destination host evil\.example/);
  assert.equal(s.docCalls().length, 2);
});

test('assertPdfRedirectTarget: relative paths resolve on the current host, the fragment is dropped, only validated URLs come back', () => {
  const from = new URL(PDF_URL);
  assert.equal(assertPdfRedirectTarget('/x/y.pdf?h=1#frag', from, env).href, `${TENANT}/x/y.pdf?h=1`);
  assert.equal(assertPdfRedirectTarget('z.pdf', from, env).href, `${TENANT}/invoices/view/z.pdf`);
  assert.throws(() => assertPdfRedirectTarget('https://evil.example/', from, env), /untrusted/);
  for (const bad of ['https://nepras.daftra.com/a.pdf\r\nX-Injected: 1', 'https://nepras.daftra.com/a\u0000.pdf', null, 42, {}]) assert.throws(() => assertPdfRedirectTarget(bad, from, env), /invalid destination/);
  assert.throws(() => assertPdfRedirectTarget('https://nepras.daftra.com/a', from, { DAFTRA_BASE_URL: 'https://evil.example', DAFTRA_API_KEY: 'k' }), /HTTPS Daftra tenant/);
});

test('size and content guards still apply after a redirect (HTML, truncated, oversize declared length)', async () => {
  const t = await tmp();
  try {
    await assert.rejects(downloadInvoicePdf('97900', t.out, env, scripted([redirect('/a.pdf'), new Response('%PDF-1.4 cut', { status: 200, headers: { 'content-type': 'application/pdf' } })]).fetcher), /Invalid|truncated/);
    await assert.rejects(downloadInvoicePdf('97900', t.out, env, scripted([redirect('/a.pdf'), new Response('x', { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': String(21 * 1024 * 1024) } })]).fetcher), /size limit/);
    await assert.rejects(stat(t.out));
  } finally { await t.done(); }
});

// ---------- CLI: official PDF end to end (fake Daftra, local files only) ---------------------------------------------------
import { run } from './daftra-cli.mjs';
test('CLI pdf <id>: follows the 302, saves invoice-<id>-<random>.pdf in exports and returns only a gateway download path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'basht-cli-pdf-'));
  const cliEnv = { OPENCLAW_WORKSPACE_DIR: dir, DAFTRA_BASE_URL: TENANT, DAFTRA_API_KEY: KEY };
  try {
    const r = await run(['pdf', '97900'], { env: cliEnv, fetcher: scripted([redirect('/invoices/download/97900.pdf'), pdfRes()], { draft: 1 }).fetcher });
    assert.deepEqual({ ok: r.ok, official: r.official, draft: r.draft, redirects: r.redirects }, { ok: true, official: true, draft: true, redirects: 1 });
    assert.match(r.download_path, /^\/setup\/exports\/invoice-97900-[0-9a-f]{32}\.pdf$/);
    assert.equal(r.path, join(dir, 'exports', r.download_path.split('/').pop()));
    assert.equal((await readFile(r.path)).equals(PDF), true);
    assert.equal(JSON.stringify(r).includes(HASH) || JSON.stringify(r).includes(KEY), false);
    const second = await run(['pdf', '97900'], { env: cliEnv, fetcher: scripted([pdfRes()]).fetcher });
    assert.notEqual(second.download_path, r.download_path);                                    // every download link is unique
    const named = await run(['pdf', '97900', join(dir, 'exports', 'mine.pdf')], { env: cliEnv, fetcher: scripted([pdfRes()]).fetcher });
    assert.equal(named.download_path, undefined);                                              // an explicit file name gets no download link
    await assert.rejects(run(['pdf', '97900', join(dir, 'escape.pdf')], { env: cliEnv, fetcher: scripted([pdfRes()]).fetcher }), /private exports directory/);
    await assert.rejects(run(['pdf', '../x'], { env: cliEnv, fetcher: scripted([]).fetcher }), /Usage/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
