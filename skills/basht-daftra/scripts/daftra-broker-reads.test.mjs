import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDaftra } from './daftra-fake.test-helper.mjs';
import { validateGet, validateInvoicePdfRequest, performGet, fetchInvoicePdf, BadRead, MAX_GET_RESPONSE } from './daftra-broker-reads.mjs';
import { createBrokerFetcher, downloadInvoicePdfViaBroker, validateServiceUrl } from './daftra-broker-service-client.mjs';
import { run } from './daftra-cli.mjs';
import { startService, AGENT_TOKEN, WRITE_KEY, READ_KEY, OP_SECRET, OPERATOR_PASSWORD, TOTP_SEED, AGENT_TOKEN_PREVIOUS, ALL_SECRETS, invoiceInput } from './daftra-broker-service.test-helper.mjs';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const TENANT = 'https://nepras.daftra.com';
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

// Wrap the FakeDaftra so every upstream request is recorded and special paths can be scripted. Must run BEFORE startService.
function scripted(fake, handlers = []) {
  const inner = fake.fetch; const calls = [];
  fake.fetch = async (url, o = {}) => {
    calls.push({ method: o.method ?? 'GET', url: String(url), headers: { ...(o.headers ?? {}) }, redirect: o.redirect });
    for (const h of handlers) { const r = await h(new URL(String(url)), o); if (r) return r; }
    return inner(url, o);
  };
  return calls;
}
const pdfHandlers = (extra = {}) => [
  (u) => (u.pathname === '/api2/invoices/3.json' ? json({ code: 200, data: { Invoice: { id: 3, invoice_pdf_url: extra.pdfUrl ?? TENANT + '/invoices/view/3.pdf?hash=abc' } } }) : null),
  (u) => (u.pathname === '/invoices/view/3.pdf' ? (extra.pdfResponse ?? new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } })) : null),
];
const get = (c, body, opts) => c.agent('/v1/get', body, opts);
const svc = (extraEnv = {}, fake = new FakeDaftra()) => ({ fake, env: { BROKER_ALLOW_LOOPBACK_HOST: '1', BROKER_PREAUTH_RPS: '2000', ...extraEnv } });

async function agentEnv(c, extra = {}) {
  const ws = await mkdtemp(join(tmpdir(), 'basht-agent-ws-'));
  return { ws, env: { DAFTRA_BASE_URL: TENANT, DAFTRA_BROKER_URL: 'http://127.0.0.1:' + c.privatePort, DAFTRA_BROKER_TOKEN: AGENT_TOKEN, DAFTRA_BROKER_ALLOW_LOOPBACK: '1', OPENCLAW_WORKSPACE_DIR: ws, ...extra } };
}

// ---------- validateGet: pure -----------------------------------------------------------------------------------------
test('validateGet accepts only registry paths and rebuilds the query through the allowlist', () => {
  assert.equal(validateGet({ path: '/api2/invoices.json', query: { page: 2, limit: '100', date_from: '2025-01-31' } }).search.toString(), 'page=2&limit=100&date_from=2025-01-31');
  assert.equal(validateGet({ path: '/api2/invoices/123.json' }).kind, 'one');
  assert.equal(validateGet({ path: '/api2/reports/revenue', query: { report_type: 'client' } }).kind, 'report');
  assert.equal(validateGet({ path: '/api2/product_categories.json' }).name, 'product_categories');
  const bad = (b) => assert.throws(() => validateGet(b), BadRead, String(JSON.stringify(b)).slice(0, 120));
  for (const path of ['/api2/users.json', '/api2/user.json', '../api2/invoices.json', '/api2/../api2/invoices.json', '//api2/invoices.json', '/api2//invoices.json', '/api2/%69nvoices.json',
    '/api2/%2e%2e/users.json', '/api2/invoices.json/../x', '/api2/invoices.json?x=1', '/api2/invoices.json#a', '/api2/Invoices.json', '/api2/invoices.json ', ' /api2/invoices.json',
    '/api2/invoices.json\n', '/api2/invoices\\.json', '/api2/invoices/0.json', '/api2/invoices/01.json', '/api2/invoices/1/2.json', '/api2/invoices/1234567890123456.json',
    '/api2/invoices/-1.json', '/api2/invoices/1.5.json', '/api2/invoices/١٢٣.json', '/api2/reports/unknown', '/api2/reports/../users', '/api2/reports/revenue.json', '/api2/reports/',
    '/api2/reports', '/api2', '/api2/', '/', '', 'api2/invoices.json', 'https://evil.example/api2/invoices.json', '/v2/api/entity/invoice/list/1', '/site_payment_gateway/list/1',
    '/api2/invoices.json/', '/api2/invoices.jsonx', '/api2/site_info.json', '/api2/journal_entries.json', '/api2/deposits.json', '/api2/advances.json', '/api2/expense_categories.json', '/api2/bank_accounts.json', '/api2/staff.json', '/api2/invoices/3/pdf.json'])
    bad({ path });
  for (const path of [undefined, null, 5, {}, [], ['/api2/invoices.json'], true]) bad({ path });
  for (const query of [[], 'a=b', { page: [1] }, { page: { a: 1 } }, { page: null }, { page: true }, { foo: 1 }, { page: 0 }, { limit: '1e3' }, { client_id: '1;2' }, { keywords: 'a\nb' },
    { date_from: '2025-02-30' }, JSON.parse('{"__proto__":{"x":1}}'), JSON.parse('{"constructor":"x"}'), JSON.parse('{"page":1,"__proto__":"x"}')])
    bad({ path: '/api2/invoices.json', query });
  bad({ path: '/api2/invoices/3.json', query: { page: 1 } });                         // single-record reads take no query
  bad({ path: '/api2/reports/revenue', query: { evil: 1 } });
  for (const extra of ['method', 'headers', 'url', 'host', 'baseUrl', 'apikey', 'APIKEY', 'body', 'redirect', 'cmd', '__proto__'])
    bad(JSON.parse('{"path":"/api2/invoices.json","' + extra + '":"x"}'));
  for (const body of [null, undefined, 5, 'x', [], [{ path: '/api2/invoices.json' }]]) bad(body);
});

test('validateInvoicePdfRequest: positive integer ids only, nothing else', () => {
  assert.equal(validateInvoicePdfRequest({ id: '3' }), '3'); assert.equal(validateInvoicePdfRequest({ id: 3 }), '3');
  for (const b of [{ id: '0' }, { id: '01' }, { id: '1/2' }, { id: 'abc' }, { id: -1 }, { id: 1.5 }, { id: null }, {}, { id: '3', url: 'x' }, { id: '3', host: 'evil' }, null, [], 'x', { id: '1234567890123456' }])
    assert.throws(() => validateInvoicePdfRequest(b), BadRead, JSON.stringify(b));
});

// ---------- the broker emits ONLY allowlisted GETs --------------------------------------------------------------------
test('READ PROXY ADVERSARIAL: every malicious path/query/field is refused BEFORE any upstream call; the broker only ever emits GET', async () => {
  const { fake, env } = svc(); const calls = scripted(fake);
  const c = await startService({ fake, env });
  try {
    const refused = async (body, label) => { const r = await get(c, body); assert.equal(r.status, 400, label + ' -> ' + r.text); assert.equal(r.json.refused, 'BAD_REQUEST'); };
    for (const path of ['/api2/users.json', '../x', '//api2/invoices.json', '/api2/%2e%2e/users.json', '/api2/invoices.json/../x', '/api2/invoices.json?x=1', '/api2/unknown.json',
      '/api2/invoices/0.json', '/api2/invoices/01.json', '/api2/invoices/1/2.json', '/api2/reports/unknown', 'https://evil.example/api2/invoices.json']) await refused({ path }, path);
    for (const query of [{ foo: 1 }, { page: [1, 2] }, { page: { a: 1 } }, JSON.parse('{"__proto__":{"x":1}}'), { page: 0 }]) await refused({ path: '/api2/invoices.json', query }, JSON.stringify(query));
    for (const extra of ['method', 'headers', 'url', 'host', 'baseUrl', 'apikey', 'body']) await refused(JSON.parse('{"path":"/api2/invoices.json","' + extra + '":"x"}'), extra);
    await refused({ path: '/api2/invoices.json', method: 'DELETE' }, 'method DELETE smuggled in the body');
    await refused({ path: '/api2/invoices.json', headers: { APIKEY: 'x' } }, 'headers smuggled in the body');
    // other HTTP methods on the route are not routes
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) assert.equal((await c.agent('/v1/get', undefined, { method })).status, 405, method);
    assert.equal(calls.length, 0, 'not a single upstream request for any of the above');
    // the good request is a GET with the BROKER key, an allowlisted path and exactly the validated query
    const ok = await get(c, { path: '/api2/invoices.json', query: { limit: 5, client_id: '4' } });
    assert.equal(ok.status, 200); assert.equal(ok.json.result.status, 200);
    assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].redirect, 'manual');
    assert.equal(new URL(calls[0].url).pathname, '/api2/invoices.json'); assert.equal(new URL(calls[0].url).searchParams.toString(), 'limit=5&client_id=4');
    assert.equal(calls[0].headers.APIKEY, WRITE_KEY); assert.equal(Object.keys(calls[0].headers).sort().join(), 'APIKEY,Accept');
    // a single record and a report
    assert.equal((await get(c, { path: '/api2/invoices/3.json' })).json.result.status, 200);
    assert.equal((await get(c, { path: '/api2/reports/revenue', query: { report_type: 'client' } })).status, 200);
    assert.ok(calls.every((x) => x.method === 'GET' && new URL(x.url).origin === TENANT), 'every upstream call: GET, pinned tenant');
    assert.equal(c.fake.posts.length, 0);
  } finally { await c.stop(); }
});

test('READ PROXY needs the same transport guards as the rest of the private API: token, private Host, no edge headers, JSON, size, not configured', async () => {
  const { fake, env } = svc(); const calls = scripted(fake);
  const c = await startService({ fake, env });
  try {
    const body = { path: '/api2/invoices.json' };
    assert.equal((await get(c, body, { token: null })).status, 401);
    assert.equal((await get(c, body, { token: READ_KEY })).status, 401);
    assert.equal((await get(c, body, { host: 'basht-broker-production.up.railway.app' })).status, 404);
    assert.equal((await get(c, body, { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 404);
    assert.equal((await get(c, body, { headers: { 'X-Real-IP': '1.2.3.4' } })).status, 404);
    assert.equal((await get(c, body, { contentType: 'text/plain' })).status, 415);
    assert.equal((await get(c, undefined, { raw: 'x'.repeat(300 * 1024) })).status, 413);
    assert.equal((await get(c, undefined, { raw: '{not json' })).status, 400);
    assert.equal((await get(c, undefined, { raw: '[]' })).status, 400);
    assert.equal((await c.agent('/v1/get', body, { port: c.publicPort })).status, 404, 'not served on the public port');
    assert.equal(calls.length, 0);
    const down = await startService({ env: { ...env, OPERATOR_PASSWORD: undefined } });
    try { const r = await get(down, body); assert.equal(r.status, 503); assert.equal(r.json.refused, 'NOT_CONFIGURED'); } finally { await down.stop(); }
  } finally { await c.stop(); }
});

// ---------- upstream behaviour is reproduced faithfully ---------------------------------------------------------------
test('READ PROXY passes upstream status through (429/5xx with Retry-After, 4xx with a sanitized message), refuses redirects and non-JSON', async () => {
  const fake = new FakeDaftra(); let n = 0;
  const calls = scripted(fake, [
    (u) => (u.pathname === '/api2/clients.json' ? (++n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '3' } }) : json({ code: 200, data: [], pagination: { page: 1, page_count: 0, total_results: 0 } })) : null),
    (u) => (u.pathname === '/api2/suppliers.json' ? new Response('', { status: 503, headers: { 'retry-after': '99999' } }) : null),
    (u) => (u.pathname === '/api2/products/9.json' ? json({ message: 'Not found <script>alert(1)</script> ' + WRITE_KEY }, 404) : null),
    (u) => (u.pathname === '/api2/taxes.json' ? new Response('', { status: 302, headers: { location: 'https://evil.example/steal' } }) : null),
    (u) => (u.pathname === '/api2/treasuries.json' ? new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } }) : null),
    (u) => (u.pathname === '/api2/expenses.json' ? json({ message: 'boom' }, 500) : null),
  ]);
  const c = await startService({ fake, env: svc().env });
  try {
    const first = (await get(c, { path: '/api2/clients.json' })).json.result; assert.deepEqual([first.status, first.retry_after], [429, 3]);
    assert.equal((await get(c, { path: '/api2/clients.json' })).json.result.status, 200);
    const unavailable = (await get(c, { path: '/api2/suppliers.json' })).json.result; assert.deepEqual([unavailable.status, unavailable.retry_after], [503, 10], 'Retry-After capped at 10 s');
    const nf = await get(c, { path: '/api2/products/9.json' }); assert.equal(nf.json.result.status, 404);
    assert.doesNotMatch(nf.text, /<script>/); assert.equal(nf.text.includes(WRITE_KEY), false);
    const redirect = (await get(c, { path: '/api2/taxes.json' })).json.result; assert.equal(redirect.status, 502); assert.match(redirect.message, /redirect refused/);
    assert.equal(calls.some((x) => x.url.includes('evil.example')), false, 'the redirect target is never requested');
    assert.equal((await get(c, { path: '/api2/treasuries.json' })).json.result.status, 502);
    assert.equal((await get(c, { path: '/api2/expenses.json' })).json.result.status, 502);
  } finally { await c.stop(); }
});

test('READ PROXY caps upstream responses (declared and streamed) and reports upstream network failures as 502', async () => {
  const fake = new FakeDaftra();
  const big = Buffer.alloc(MAX_GET_RESPONSE + 10, 0x61);
  scripted(fake, [
    (u) => (u.pathname === '/api2/clients.json' ? new Response(big, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(big.length) } }) : null),
    (u) => (u.pathname === '/api2/suppliers.json' ? new Response(new ReadableStream({ start(ctl) { for (let i = 0; i < 20; i++) ctl.enqueue(Buffer.alloc(1024 * 1024, 0x61)); ctl.close(); } }), { status: 200, headers: { 'content-type': 'application/json' } }) : null),
    (u) => { if (u.pathname === '/api2/taxes.json') throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' }); return null; },
  ]);
  const c = await startService({ fake, env: svc().env });
  try {
    assert.equal((await get(c, { path: '/api2/clients.json' })).status, 400, 'declared Content-Length above the cap');
    assert.equal((await get(c, { path: '/api2/suppliers.json' })).status, 400, 'streamed body above the cap');
    const r = await get(c, { path: '/api2/taxes.json' }); assert.equal(r.status, 200); assert.equal(r.json.result.status, 502);
    assert.equal((await get(c, { path: '/api2/invoices.json' })).status, 200, 'service still healthy');
  } finally { await c.stop(); }
});

// ---------- invoice PDF ------------------------------------------------------------------------------------------------
test('INVOICE PDF through the broker: official bytes, downloaded WITHOUT the API key, and every unsafe link/response is refused', async () => {
  const ok = new FakeDaftra(); const okCalls = scripted(ok, pdfHandlers());
  const c = await startService({ fake: ok, env: svc().env });
  try {
    const r = await c.agent('/v1/invoice_pdf', { id: '3' });
    assert.equal(r.status, 200); assert.equal(r.json.result.status, 200); assert.equal(Buffer.from(r.json.result.base64, 'base64').equals(PDF), true);
    const pdfCall = okCalls.find((x) => x.url.includes('/invoices/view/3.pdf'));
    assert.ok(pdfCall); assert.equal(pdfCall.headers.APIKEY, undefined, 'the document request carries no API key'); assert.equal(pdfCall.redirect, 'manual');
    assert.equal(okCalls.find((x) => x.url.includes('/api2/invoices/3.json')).headers.APIKEY, WRITE_KEY);
    for (const bad of [{ id: '0' }, { id: '01' }, { id: '1/2' }, { id: 'x' }, { id: '3', url: 'https://evil' }, {}, { id: '3', host: 'evil' }]) assert.equal((await c.agent('/v1/invoice_pdf', bad)).status, 400, JSON.stringify(bad));
    assert.equal((await c.agent('/v1/invoice_pdf', { id: '404404' })).json.result.status, 404);
  } finally { await c.stop(); }
  for (const [label, extra, expectStatus, rx] of [
    ['another origin', { pdfUrl: 'https://evil.example/invoices/view/3.pdf?hash=x' }, 422, /same-tenant/],
    ['another tenant', { pdfUrl: 'https://other.daftra.com/invoices/view/3.pdf?hash=x' }, 422, /same-tenant/],
    ['plain http', { pdfUrl: 'http://nepras.daftra.com/invoices/view/3.pdf?hash=x' }, 422, /same-tenant/],
    ['credentials in the link', { pdfUrl: 'https://u:p@nepras.daftra.com/invoices/view/3.pdf?hash=x' }, 422, /same-tenant/],
    ['not a .pdf path', { pdfUrl: TENANT + '/invoices/view/3?hash=x' }, 422, /same-tenant/],
    ['HTML disguised as PDF', { pdfResponse: new Response('<html>x</html>', { status: 200, headers: { 'content-type': 'text/html' } }) }, 502, /not PDF/],
    ['truncated PDF', { pdfResponse: new Response('%PDF-1.4 no trailer', { status: 200, headers: { 'content-type': 'application/pdf' } }) }, 502, /truncated|Invalid/],
    ['redirect', { pdfResponse: new Response('', { status: 302, headers: { location: 'https://evil.example/x.pdf' } }) }, 502, /HTTP 302/],
    ['oversize', { pdfResponse: new Response(Buffer.alloc(21 * 1024 * 1024, 0x25), { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': String(21 * 1024 * 1024) } }) }, 502, /too large/],
  ]) {
    const f = new FakeDaftra(); const calls = scripted(f, pdfHandlers(extra));
    const s = await startService({ fake: f, env: svc().env });
    try {
      const r = await s.agent('/v1/invoice_pdf', { id: '3' });
      assert.equal(r.status, 200, label); assert.equal(r.json.result.status, expectStatus, label); assert.match(r.json.result.message, rx, label);
      assert.equal(calls.some((x) => x.url.includes('evil.example') || x.url.includes('other.daftra.com') || x.url.startsWith('http://')), false, label + ': the bad link is never requested');
    } finally { await s.stop(); }
  }
});

// ---------- quotas ---------------------------------------------------------------------------------------------------
test('READ QUOTAS: per-token rate limit and concurrency cap; reads are counted, not audited line by line', async () => {
  const fake = new FakeDaftra(); let release; const gate = new Promise((ok) => { release = ok; }); let entered = 0;
  scripted(fake, [async (u) => { if (u.pathname === '/api2/taxes.json') { entered++; await gate; return json({ code: 200, data: [], pagination: { page: 1, page_count: 0, total_results: 0 } }); } return null; }]);
  const c = await startService({ fake, env: svc({ BROKER_GET_PER_MIN: '8', BROKER_GET_CONCURRENCY: '2' }).env });
  try {
    const slow = [get(c, { path: '/api2/taxes.json' }), get(c, { path: '/api2/taxes.json' })];
    while (entered < 2) await new Promise((ok) => setTimeout(ok, 5));
    const third = await get(c, { path: '/api2/taxes.json' });
    assert.equal(third.status, 429); assert.equal(third.json.refused, 'CONCURRENCY');
    release(); await Promise.all(slow);
    let last; for (let i = 0; i < 8; i++) last = await get(c, { path: '/api2/invoices.json' });
    assert.equal(last.status, 429); assert.equal(last.json.refused, 'RATE_LIMIT');
    assert.equal((await c.agent('/v1/status', { id: 'prop_0123456789abcdef' })).status, 422, 'the propose/status budget is separate (not exhausted by reads)');
    await c.service._flushAggregates();
    const { readAudit } = await import('./daftra-broker-service.mjs');
    const audit = await readAudit({ stateDir: c.stateDir, secret: OP_SECRET });
    assert.equal(audit.filter((a) => /agent_get/.test(a.event)).length, 0);
    assert.ok(audit.some((a) => a.event === 'unauth_summary' && a.counts.agent_get >= 5 && a.counts.agent_get_rate_limited >= 1 && a.counts.agent_get_concurrency === 1));
  } finally { await c.stop(); }
});

// ---------- the agent side: a keyless CLI ------------------------------------------------------------------------------
test('KEYLESS AGENT END TO END: list --all (multi-page), get, report, export csv/xlsx, statement and the official PDF all work with NO Daftra credential in the agent env', async () => {
  const fake = new FakeDaftra();
  fake.lists.invoices = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, no: 'INV-' + (i + 1), date: '2025-02-01', type: 0, draft: 0, summary_total: '10.00', summary_unpaid: '0.00', password: 'secret-hash', invoice_pdf_url: 'https://x/a.pdf?hash=1' }));
  fake.lists.invoice_payments = [{ id: 9, invoice_id: 1, date: '2025-02-02', amount: '10.00' }];
  fake.lists.client_payments = [];
  const calls = scripted(fake, [
    ...pdfHandlers(),
    (u) => (u.pathname === '/api2/reports/revenue' ? json({ code: 200, report: 'revenue', data: [{ group: 'SAR', total: '100.00' }] }) : null),
  ]);
  const c = await startService({ fake, env: svc().env });
  const { ws, env } = await agentEnv(c);
  const sent = []; const brokerFetcher = async (u, o) => { sent.push({ url: String(u), headers: o.headers, body: o.body }); return fetch(u, o); };
  try {
    assert.equal(env.DAFTRA_API_KEY, undefined); assert.equal(env.DAFTRA_WRITE_API_KEY, undefined);
    const all = await run(['list', 'invoices', '--all', '--page-size', '10'], { env, brokerFetcher });
    assert.equal(all.complete, true); assert.equal(all.count, 25); assert.equal(all.pages, 3);
    assert.ok(all.records.every((r) => !('password' in r) && !('invoice_pdf_url' in r)), 'sensitive fields stripped');
    assert.equal((await run(['list', 'invoices', '--query', 'limit=5'], { env, brokerFetcher })).complete, false);
    assert.equal((await run(['get', 'invoices', '3'], { env, brokerFetcher })).record.id, 3);
    const rep = await run(['report', 'revenue', '--param', 'report_type=client'], { env, brokerFetcher }); assert.equal(rep.complete, true); assert.equal(rep.payload.report, 'revenue');
    for (const format of ['csv', 'xlsx']) {
      const r = await run(['export', 'invoices', '--format', format, '--out', join(ws, 'exports', 'inv.' + format), '--columns', 'id,no'], { env, brokerFetcher });
      assert.equal(r.record_count, 25); assert.equal((await stat(r.path)).mode & 0o777, 0o600);
    }
    assert.match(await readFile(join(ws, 'exports', 'inv.csv'), 'utf8'), /INV-25/);
    const st = await run(['statement', '4', '--from', '2025-02-01', '--to', '2025-02-28'], { env, brokerFetcher });
    assert.equal(st.provenance.complete, true);
    const pdf = await run(['pdf', '3', join(ws, 'exports', 'inv3.pdf')], { env, brokerFetcher });
    assert.equal(pdf.source, 'daftra_official'); assert.equal((await readFile(pdf.path)).equals(PDF), true);
    assert.deepEqual(await readdir(join(ws, 'exports')).then((f) => f.sort()), ['inv.csv', 'inv.xlsx', 'inv3.pdf']);
    // what the broker did upstream: only GETs, only the pinned tenant, always with ITS key; what the agent sent: no Daftra header, no key
    assert.ok(calls.length > 10); assert.ok(calls.every((x) => x.method === 'GET' && x.url.startsWith(TENANT + '/')));
    assert.ok(calls.filter((x) => x.url.includes('/api2/')).every((x) => x.headers.APIKEY === WRITE_KEY));
    assert.equal(c.fake.posts.length, 0);
    for (const s of sent) { assert.equal(new URL(s.url).origin, 'http://127.0.0.1:' + c.privatePort); assert.equal(Object.keys(s.headers).map((h) => h.toLowerCase()).includes('apikey'), false); }
  } finally { await c.stop(); await rm(ws, { recursive: true, force: true }); }
});

test('KEYLESS AGENT ignores any real Daftra key present in its env (never sent anywhere) and says so in `capabilities`', async () => {
  const fake = new FakeDaftra(); const calls = scripted(fake);
  const c = await startService({ fake, env: svc().env });
  const REAL = 'REAL-AGENT-DAFTRA-KEY-0123456789';
  const { ws, env } = await agentEnv(c, { DAFTRA_API_KEY: REAL, DAFTRA_WRITE_API_KEY: REAL + '-w' });
  const sent = []; const brokerFetcher = async (u, o) => { sent.push(JSON.stringify({ u: String(u), h: o.headers, b: o.body })); return fetch(u, o); };
  try {
    assert.equal((await run(['list', 'clients'], { env, brokerFetcher })).ok, true);
    assert.equal(sent.some((s) => s.includes(REAL)), false, 'the real key never leaves the agent process');
    assert.equal(calls.every((x) => x.headers.APIKEY === WRITE_KEY), true);
    const caps = await run(['capabilities'], { env });
    assert.equal(caps.daftra_credentials_on_agent, true);
    assert.ok(caps.env_warnings.length >= 2 && caps.env_warnings.every((w) => /per ENTITY, not per method/.test(w) || /operator/.test(w)));
  } finally { await c.stop(); await rm(ws, { recursive: true, force: true }); }
});

test('KEYLESS CLIENT SHIM: GET only, tenant /api2 only, no repeated params; rate limits become a retryable 429; the broker cannot be asked to write', async () => {
  const fake = new FakeDaftra(); const calls = scripted(fake);
  const c = await startService({ fake, env: svc({ BROKER_GET_PER_MIN: '2' }).env });
  const { ws, env } = await agentEnv(c);
  try {
    const f = createBrokerFetcher({ url: env.DAFTRA_BROKER_URL, token: AGENT_TOKEN, env });
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) await assert.rejects(f(new URL(TENANT + '/api2/invoices.json'), { method }), (e) => e.code === 'AGENT_CANNOT_WRITE', method);
    await assert.rejects(f(new URL('https://evil.example/api2/invoices.json'), { method: 'GET' }), /Only the tenant/);
    await assert.rejects(f(new URL(TENANT + '/invoices/view/3.pdf'), { method: 'GET' }), /Only the tenant/);
    await assert.rejects(f(new URL(TENANT + '/api2/invoices.json?page=1&page=2'), { method: 'GET' }), /Repeated query parameter/);
    await assert.rejects(f(new URL(TENANT + '/api2/users.json'), { method: 'GET' }), /BAD_REQUEST|not allowed|Path/i);
    assert.equal(calls.length, 0);
    const r1 = await f(new URL(TENANT + '/api2/invoices.json?limit=1'), { method: 'GET' }); assert.equal(r1.status, 200);
    await f(new URL(TENANT + '/api2/invoices.json?limit=1'), { method: 'GET' });
    const limited = await f(new URL(TENANT + '/api2/invoices.json?limit=1'), { method: 'GET' });
    assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '2');
    assert.throws(() => createBrokerFetcher({ url: 'http://evil.example:80', token: AGENT_TOKEN, env }), /railway\.internal/);
    assert.throws(() => createBrokerFetcher({ url: env.DAFTRA_BROKER_URL, token: AGENT_TOKEN, env: { ...env, DAFTRA_BASE_URL: undefined } }), /DAFTRA_BASE_URL/);
    await assert.rejects(downloadInvoicePdfViaBroker({ id: '3', outPath: join(ws, 'x.pdf'), url: env.DAFTRA_BROKER_URL, token: 'short', env }), /DAFTRA_BROKER_TOKEN/);
    void validateServiceUrl;
  } finally { await c.stop(); await rm(ws, { recursive: true, force: true }); }
});

test('LEAKED AGENT TOKEN: it can READ (documented, accepted risk) but can never write, enable writes, approve or learn a secret', async () => {
  const fake = new FakeDaftra(); const calls = scripted(fake);
  const c = await startService({ fake, env: svc().env });
  try {
    assert.equal((await get(c, { path: '/api2/invoices.json' })).json.result.status, 200, 'reads work with the token');
    const attempts = [['/v1/execute', { id: 'prop_0123456789abcdef', phrase: 'x' }], ['/v1/approve', {}], ['/v1/resolve', {}], ['/v1/enable_writes', { value: '1' }], ['/v1/post', { path: '/api2/invoices.json' }],
      ['/v1/put', { path: '/api2/invoices/3.json' }], ['/v1/delete', { path: '/api2/invoices/3.json' }], ['/v1/request', { method: 'POST', path: '/api2/invoices.json' }]];
    for (const [route, body] of attempts) assert.equal((await c.agent(route, body)).status, 404, route);
    assert.equal((await get(c, { path: '/api2/invoices.json', method: 'POST', body: { Invoice: {} } })).status, 400);
    assert.equal(calls.filter((x) => x.method !== 'GET').length, 0); assert.equal(c.fake.posts.length, 0);
    const all = []; for (const r of [await get(c, { path: '/api2/clients.json' }), await c.agent('/v1/status', { id: 'prop_0123456789abcdef' }), await c.agent('/v1/get', { path: '/api2/users.json' })]) all.push(JSON.stringify(r.headers) + r.text);
    for (const s of all) for (const secret of ALL_SECRETS.filter((x) => x !== AGENT_TOKEN && x !== AGENT_TOKEN_PREVIOUS)) assert.equal(s.includes(secret), false);
    assert.equal(ALL_SECRETS.length, 6); void TOTP_SEED; void OPERATOR_PASSWORD; void invoiceInput;
  } finally { await c.stop(); }
});

test('READ PROXY: performGet/fetchInvoicePdf unit behaviour (config pinning, no key to document URL)', async () => {
  const env = { DAFTRA_BASE_URL: TENANT, DAFTRA_API_KEY: 'k-broker' }; const calls = [];
  const fetcher = async (u, o) => { calls.push({ url: String(u), o }); return u.pathname === '/api2/invoices/3.json' ? json({ data: { Invoice: { invoice_pdf_url: TENANT + '/invoices/view/3.pdf?hash=a' } } }) : new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } }); };
  const pdf = await fetchInvoicePdf('3', { env, fetcher });
  assert.equal(pdf.status, 200); assert.equal(pdf.size, PDF.length);
  assert.equal(calls[0].o.headers.APIKEY, 'k-broker'); assert.equal(calls[1].o.headers, undefined);
  await assert.rejects(performGet(validateGet({ path: '/api2/invoices.json' }), { env: { DAFTRA_BASE_URL: 'https://evil.example', DAFTRA_API_KEY: 'k' }, fetcher }), /HTTPS Daftra tenant/);
});

test('READ PROXY (mutation survivors closed): performGet re-checks origin/path itself; declared oversize is refused WITHOUT reading the body; PDF download never overwrites', async () => {
  const env = { DAFTRA_BASE_URL: TENANT, DAFTRA_API_KEY: 'k-broker' }; const calls = [];
  const fetcher = async (u) => { calls.push(String(u)); return json({ data: [] }); };
  // hand-made "validated" objects (programmer error / future refactor) can still not leave the tenant or the /api2 prefix
  for (const path of ['//evil.example/api2/invoices.json', '/not-api2/invoices.json', '/api2', '/\\evil.example/api2/x'])
    await assert.rejects(performGet({ path, kind: 'list', name: 'x', search: new URLSearchParams() }, { env, fetcher }), BadRead, path);
  assert.equal(calls.length, 0);
  let read = false;
  const huge = { status: 200, headers: { get: (h) => (h === 'content-length' ? String(MAX_GET_RESPONSE + 1) : null) }, body: { getReader() { read = true; throw new Error('must not be read'); }, cancel: async () => {} } };
  await assert.rejects(performGet(validateGet({ path: '/api2/invoices.json' }), { env, fetcher: async () => huge }), /too large/);
  assert.equal(read, false, 'the body of an oversize response is never read');
  const ws = await mkdtemp(join(tmpdir(), 'basht-pdfout-'));
  try {
    const brokerFetch = async (u, o) => {
      const body = JSON.parse(o.body);
      return new Response(JSON.stringify({ ok: true, result: { status: 200, size: PDF.length, base64: PDF.toString('base64') } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const cfg = { id: '3', outPath: join(ws, 'inv.pdf'), url: 'http://basht-broker.railway.internal:8081', token: AGENT_TOKEN, env: { DAFTRA_BASE_URL: TENANT }, fetcher: brokerFetch };
    await downloadInvoicePdfViaBroker(cfg);
    assert.equal((await readFile(cfg.outPath)).length, PDF.length);
    await assert.rejects(downloadInvoicePdfViaBroker(cfg), /EEXIST|exists/i, 'an existing file is never overwritten');
  } finally { await rm(ws, { recursive: true, force: true }); }
});
