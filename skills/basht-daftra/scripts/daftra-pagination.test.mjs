import test from 'node:test';
import assert from 'node:assert/strict';
import { extractList, extractPage, extractOne } from './daftra-normalize.mjs';
import { fetchAllRecords, listRecords, getReport } from './daftra-readonly.mjs';
import { buildQuery, ENTITIES } from './daftra-entities.mjs';

const env = { DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'dummy' };
const noSleep = async () => {};

// Official shape: pagination { prev, next, page, page_count, total_results }.
function pagedFetcher({ rows, pageSize, mutate } = {}) {
  const calls = [];
  const fetcher = async (url) => {
    const page = Number(url.searchParams.get('page') || 1);
    const limit = Number(url.searchParams.get('limit') || pageSize);
    calls.push({ path: url.pathname, page, limit });
    const all = mutate ? mutate(page, rows) : rows;
    const pageCount = Math.ceil(all.length / limit);
    const slice = all.slice((page - 1) * limit, page * limit);
    return new Response(JSON.stringify({
      code: 200, result: 'successful',
      data: slice.map((id) => ({ Invoice: { id: String(id), total: '10.00' } })),
      pagination: {
        prev: page > 1 ? '/api2/invoices.json?page=' + (page - 1) : null,
        next: page < pageCount ? '/api2/invoices.json?page=' + (page + 1) : null,
        page, page_count: pageCount, total_results: all.length,
      },
    }), { status: 200 });
  };
  return { fetcher, calls };
}
const ids = (n) => Array.from({ length: n }, (_, i) => i + 1);

test('official total_results/page_count: single complete page is proven complete', () => {
  const r = extractList({
    data: [{ Invoice: { id: '1' } }, { Invoice: { id: '2' } }],
    pagination: { prev: null, next: null, page: 1, page_count: 1, total_results: 2 },
  }, 'invoices');
  assert.equal(r.complete, true);
  assert.equal(r.total, 2);
  assert.equal(r.warning, null);
});

test('page 1 of 5 is NOT complete even though it has rows (total_results counts all pages)', () => {
  const r = extractList({
    data: [{ Client: { id: '1' } }],
    pagination: { prev: null, next: '/api2/clients/?page=2', page: 1, page_count: 5, total_results: 98 },
  }, 'clients');
  assert.equal(r.complete, false);
  assert.match(r.warning, /not proven complete/);
});

test('page 2 of 2 that holds all remaining rows is not a complete report on its own', () => {
  const r = extractList({
    data: [{ Client: { id: '3' } }],
    pagination: { prev: '/api2/clients/?page=1', next: null, page: 2, page_count: 2, total_results: 1 },
  }, 'clients');
  assert.equal(r.complete, false);
});

test('page_count 1 but a next link present is not complete', () => {
  const r = extractList({
    data: [{ Client: { id: '3' } }],
    pagination: { next: '/api2/clients/?page=2', page: 1, page_count: 1, total_results: 1 },
  }, 'clients');
  assert.equal(r.complete, false);
});

test('client-controlled `complete: true` flag is ignored', () => {
  const r = extractList({ data: [{ Invoice: { id: '1' } }], complete: true }, 'invoices');
  assert.equal(r.complete, false);
});

test('rejects malformed pagination metadata', () => {
  const row = [{ Invoice: { id: '1' } }];
  for (const pagination of [
    { total_results: -1 }, { total_results: 'abc' }, { total_results: '' }, { total_results: true },
    { total_results: 1.5 }, { total_results: 0 },                   // fewer than rows returned
    { total_results: 1, page_count: 0 }, { total_results: 1, page_count: -2 }, { total_results: 1, page_count: 'x' },
    { total_results: 1, page: 0 }, { total_results: 1, page: 3, page_count: 2 },
    { total_results: 1, next: 5 },
  ]) assert.throws(() => extractList({ data: row, pagination }, 'invoices'), undefined, JSON.stringify(pagination));
  assert.throws(() => extractList({ data: row, pagination: [] }, 'invoices'));
});

test('empty collection may report page_count 0 and is complete', () => {
  const r = extractList({ data: [], pagination: { page: 1, page_count: 0, total_results: 0, next: null } }, 'invoices');
  assert.equal(r.complete, true);
  assert.equal(r.count, 0);
});

test('legacy pagination.total still works, supplier/purchase models resolve', () => {
  assert.equal(extractList({ data: [{ Invoice: { id: '1' } }], pagination: { total: 1 } }, 'invoices').complete, true);
  assert.equal(extractPage({ data: [{ PurchaseOrder: { id: '9' } }], pagination: { page: 1, page_count: 1, total_results: 1 } }, 'purchase_invoices').records[0].id, '9');
  assert.throws(() => extractPage({ data: [{ PurchaseInvoice: { id: '9' } }] }, 'purchase_invoices'), /Missing model PurchaseOrder/);
  assert.equal(extractOne({ data: { Invoice: { id: '5' } } }, 'invoices').id, '5');
  assert.throws(() => extractOne({ data: {} }, 'invoices'), /Missing model/);
});

test('fetchAllRecords walks every page and proves completeness', async () => {
  const { fetcher, calls } = pagedFetcher({ rows: ids(250), pageSize: 100 });
  const result = await fetchAllRecords('invoices', { pageSize: 100, sleep: noSleep }, env, fetcher);
  assert.equal(result.complete, true);
  assert.equal(result.count, 250);
  assert.equal(result.total, 250);
  assert.equal(result.pages, 3);
  assert.deepEqual(calls.map(c => c.page), [1, 2, 3]);
  assert.deepEqual(result.records.map(r => r.id).slice(98, 102), ['99', '100', '101', '102']);
  assert.ok(calls.every(c => c.path === '/api2/invoices.json'));
});

test('fetchAllRecords handles exact multiples and empty collections', async () => {
  const exact = pagedFetcher({ rows: ids(200), pageSize: 100 });
  assert.equal((await fetchAllRecords('invoices', { sleep: noSleep }, env, exact.fetcher)).count, 200);
  const empty = pagedFetcher({ rows: [], pageSize: 100 });
  const r = await fetchAllRecords('invoices', { sleep: noSleep }, env, empty.fetcher);
  assert.equal(r.count, 0);
  assert.equal(r.complete, true);
});

test('fetchAllRecords refuses when metadata is missing (cannot prove completeness)', async () => {
  const fetcher = async () => new Response(JSON.stringify({ data: [{ Invoice: { id: '1' } }] }), { status: 200 });
  await assert.rejects(fetchAllRecords('invoices', { sleep: noSleep }, env, fetcher), /completeness cannot be proven/);
});

test('fetchAllRecords refuses a collection that keeps changing', async () => {
  let growth = 0;
  const { fetcher } = pagedFetcher({ rows: ids(150), pageSize: 100, mutate: (page, rows) => page === 2 ? ids(150 + (++growth)) : rows });
  await assert.rejects(fetchAllRecords('invoices', { sleep: noSleep }, env, fetcher), /Export blocked: collection changed/);
});

test('fetchAllRecords restarts once when data changes mid-read, then succeeds', async () => {
  let reads = 0;
  const { fetcher } = pagedFetcher({
    rows: ids(150), pageSize: 100,
    mutate: (page, rows) => (page === 2 && ++reads === 1) ? ids(151) : rows,
  });
  const r = await fetchAllRecords('invoices', { sleep: noSleep }, env, fetcher);
  assert.equal(r.count, 150);
});

test('fetchAllRecords rejects duplicate ids across pages, missing next links and page overflow', async () => {
  const dup = async (url) => {
    const page = Number(url.searchParams.get('page'));
    return new Response(JSON.stringify({
      data: [{ Invoice: { id: '1' } }],
      pagination: { page, page_count: 2, total_results: 2, next: page === 1 ? '/x' : null },
    }), { status: 200 });
  };
  await assert.rejects(fetchAllRecords('invoices', { sleep: noSleep }, env, dup), /duplicate/);
  const noNext = async (url) => new Response(JSON.stringify({
    data: [{ Invoice: { id: String(url.searchParams.get('page')) } }],
    pagination: { page: Number(url.searchParams.get('page')), page_count: 2, total_results: 2, next: null },
  }), { status: 200 });
  await assert.rejects(fetchAllRecords('invoices', { sleep: noSleep }, env, noNext), /no next link/);
  const { fetcher } = pagedFetcher({ rows: ids(30), pageSize: 10 });
  await assert.rejects(fetchAllRecords('invoices', { pageSize: 10, maxPages: 2, sleep: noSleep }, env, fetcher), /more than 2 pages/);
  await assert.rejects(fetchAllRecords('invoices', { pageSize: 10, maxRecords: 5, sleep: noSleep }, env, fetcher), /exceeds limit/);
});

test('GET retries on 429/503 with bounded backoff and never leaks the key', async () => {
  let n = 0;
  const waits = [];
  const fetcher = async () => ++n < 3
    ? new Response('', { status: n === 1 ? 429 : 503, headers: n === 1 ? { 'retry-after': '2' } : {} })
    : new Response(JSON.stringify({ data: [], pagination: { page: 1, page_count: 0, total_results: 0 } }), { status: 200 });
  const payload = await listRecords('invoices', env, fetcher, {}, { sleep: async (ms) => waits.push(ms) });
  assert.equal(payload.data.length, 0);
  assert.deepEqual(waits, [2000, 1000]);
  const failing = async () => new Response(JSON.stringify({ message: 'Forbidden entity <script>' }), { status: 403 });
  await assert.rejects(listRecords('invoices', env, failing), (e) => {
    assert.equal(e.status, 403);
    assert.doesNotMatch(e.message, /dummy|<script>/);
    return true;
  });
});

test('query parameters are allowlisted and validated per entity', () => {
  assert.equal(buildQuery(ENTITIES.invoices.params, { date_from: '2025-01-01', client_id: 4 }).toString(), 'date_from=2025-01-01&client_id=4');
  for (const bad of [{ date_from: '2025-02-30' }, { evil: 1 }, { client_id: '4;drop' }, { page: '0' }])
    assert.throws(() => buildQuery(ENTITIES.invoices.params, bad));
  assert.throws(() => buildQuery(ENTITIES.taxes.params, { page: 1 }), /not allowed/);
});

test('reports use /api2/reports/<name> without .json, require mandatory params, and allowlist params', async () => {
  const seen = [];
  const fetcher = async (url, o) => { seen.push([url.pathname + url.search, o.method]); return new Response(JSON.stringify({ code: 200, data: {} }), { status: 200 }); };
  await getReport('revenue', { report_type: 'client', date_from: '2025-01-01' }, env, fetcher);
  assert.deepEqual(seen, [['/api2/reports/revenue?report_type=client&date_from=2025-01-01', 'GET']]);
  await assert.rejects(getReport('revenue', {}, env, fetcher), /required: report_type/);
  await assert.rejects(getReport('../users', {}, env, fetcher), /not authorized/);
  await assert.rejects(getReport('revenue', { report_type: 'client', bogus: 1 }, env, fetcher), /not allowed/);
});

test('financial_transactions is the one paged report: every page is walked and the row count proven', async () => {
  const total = 650; const calls = [];
  const fetcher = async (url) => {
    const page = Number(url.searchParams.get('page')); calls.push(page);
    const rows = Array.from({ length: Math.min(300, total - (page - 1) * 300) }, (_, i) => ({ n: (page - 1) * 300 + i }));
    return new Response(JSON.stringify({ report: 'financial_transactions', filters: {}, opening_balance: '0', rows, totals: { income: 'page-only' },
      pagination: { page, per_page: 300, total_rows: total, total_pages: 3 } }), { status: 200 });
  };
  const merged = await getReport('financial_transactions', { date_range_from: '2025-01-01' }, env, fetcher, { sleep: noSleep });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(merged.rows.length, 650);
  assert.equal(merged.pagination.complete, true);
  assert.equal('totals' in merged, false);                 // per-page totals must not masquerade as report totals
  const { isPartialReport } = await import('./daftra-readonly.mjs');
  assert.equal(isPartialReport('financial_transactions', { page: 2 }), true);
  assert.equal(isPartialReport('revenue', {}), false);
  const short = async (url) => new Response(JSON.stringify({ rows: [{ n: 1 }], pagination: { page: Number(url.searchParams.get('page')), per_page: 300, total_rows: 5, total_pages: 1 } }), { status: 200 });
  await assert.rejects(getReport('financial_transactions', {}, env, short, { sleep: noSleep }), /collected 1 of 5/);
  const none = async () => new Response(JSON.stringify({ rows: [] }), { status: 200 });
  await assert.rejects(getReport('financial_transactions', {}, env, none, { sleep: noSleep }), /completeness cannot be proven/);
});
