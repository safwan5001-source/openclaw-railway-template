// Automated tests: taxes (GET All Taxes, unpaginated per Daftra docs 15115346e0) + regression guards for paginated entities.
// Offline only: a fake fetch returns payloads shaped like the live responses observed in read-only probes.
// No tenant data, no credentials. Run: node --test skills/basht-daftra/scripts/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENTITIES, buildQuery } from './daftra-entities.mjs';
import { listPage, fetchAllRecords } from './daftra-readonly.mjs';
import { extractUnpaged } from './daftra-normalize.mjs';
import { validateGet } from './daftra-broker-reads.mjs';

const env = { DAFTRA_BASE_URL: 'https://test-tenant.daftra.com', DAFTRA_API_KEY: '***' };
const noSleep = async () => {};

const TAX_ROWS = [
  { Tax: { id: '1', name: 'VAT', value: '15', is_active: '1' } },
  { Tax: { id: '2', name: 'Zero Rated', value: '0', is_active: '1' } },
  { Tax: { id: '3', name: 'Tax Free', value: '0', is_active: '1' } },
];
// Live shape observed: contradictory pagination (0 / 0) with 3 rows. Must NOT block completeness for taxes.
const TAXES_OBSERVED = { result: 'success', code: 200, data: TAX_ROWS, pagination: { prev: null, next: null, page: 1, page_count: 0, total_results: 0 } };
const CLIENTS_2 = {
  result: 'success', code: 200,
  data: [{ Client: { id: '10' } }, { Client: { id: '11' } }],
  pagination: { prev: null, next: null, page: 1, page_count: 1, total_results: 2 },
};

// Fake fetch: records each request; responder returns an object (JSON 200), a number (HTTP error), or a string (raw body).
function fakeFetch(responder) {
  const calls = [];
  const fetcher = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const r = responder(u);
    if (typeof r === 'number') return new Response('{"message":"Method Not Allowed"}', { status: r, headers: { 'content-type': 'application/json' } });
    if (typeof r === 'string') return new Response(r, { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetcher, calls };
}
const paramsOf = (u) => Object.fromEntries(u.searchParams.entries());

// ---- taxes: request shape -------------------------------------------------------------------

test('taxes is the only unpaginated entity', () => {
  const unpaged = Object.entries(ENTITIES).filter(([, s]) => s.unpaginated).map(([n]) => n);
  assert.deepEqual(unpaged, ['taxes']);
});

test('taxes listPage sends NO limit or page parameter', async () => {
  const { fetcher, calls } = fakeFetch(() => TAXES_OBSERVED);
  await listPage('taxes', {}, env, fetcher, { sleep: noSleep });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/api2/taxes.json');
  assert.equal(calls[0].searchParams.has('limit'), false);
  assert.equal(calls[0].searchParams.has('page'), false);
});

test('taxes --all sends NO limit or page and makes exactly one request', async () => {
  const { fetcher, calls } = fakeFetch(() => TAXES_OBSERVED);
  await fetchAllRecords('taxes', { pageSize: 100 }, env, fetcher);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.has('limit'), false);
  assert.equal(calls[0].searchParams.has('page'), false);
});

test('taxes keeps the documented is_active filter and sends nothing else', async () => {
  const { fetcher, calls } = fakeFetch(() => TAXES_OBSERVED);
  await listPage('taxes', { is_active: '1' }, env, fetcher, { sleep: noSleep });
  assert.deepEqual(paramsOf(calls[0]), { is_active: '1' });
});

// ---- taxes: completeness by response contract (docs 15115346e0) -----------------------------

test('taxes --all returns ALL rows as complete even when pagination counters contradict the rows', async () => {
  const { fetcher } = fakeFetch(() => TAXES_OBSERVED);
  const r = await fetchAllRecords('taxes', {}, env, fetcher);
  assert.equal(r.complete, true);
  assert.equal(r.count, 3);
  assert.equal(r.total, 3);
  assert.equal(r.pages, 1);
  assert.deepEqual(r.records.map((x) => x.id), ['1', '2', '3']);
});

test('taxes listPage is complete with contradictory pagination (counters are ignored for this endpoint)', async () => {
  const { fetcher } = fakeFetch(() => TAXES_OBSERVED);
  const page = await listPage('taxes', {}, env, fetcher, { sleep: noSleep });
  assert.equal(page.complete, true);
  assert.equal(page.warning, null);
});

test('taxes empty list is a valid, complete answer (code 200, data [])', async () => {
  const { fetcher } = fakeFetch(() => ({ result: 'success', code: 200, data: [], pagination: { prev: null, next: null, page: 1, page_count: 0, total_results: 0 } }));
  const r = await fetchAllRecords('taxes', {}, env, fetcher);
  assert.equal(r.complete, true);
  assert.equal(r.count, 0);
  assert.deepEqual(r.records, []);
});

test('taxes accepts result "successful" (docs example) as well as "success" (observed)', () => {
  assert.equal(extractUnpaged({ result: 'successful', code: 200, data: [] }, 'taxes').complete, true);
  assert.equal(extractUnpaged({ result: 'success', code: 200, data: [] }, 'taxes').complete, true);
});

test('taxes accepts is_active as number or string and value as string or number', () => {
  const r = extractUnpaged({ result: 'success', code: 200, data: [{ Tax: { id: 5, name: 'X', value: 5, is_active: 0 } }] }, 'taxes');
  assert.equal(r.count, 1);
});

test('taxes rejects a non-200 envelope code', () => {
  assert.throws(() => extractUnpaged({ result: 'success', code: 500, data: TAX_ROWS }, 'taxes'), /envelope code is 500/);
});

test('taxes accepts an envelope without a result field when code is 200 (result is informational)', () => {
  assert.equal(extractUnpaged({ code: 200, data: TAX_ROWS }, 'taxes').complete, true);
});

test('taxes rejects a non-success envelope result', () => {
  assert.throws(() => extractUnpaged({ result: 'error', code: 200, data: TAX_ROWS }, 'taxes'), /result is not success/);
  assert.throws(() => extractUnpaged({ result: 42, code: 200, data: TAX_ROWS }, 'taxes'), /result is not success/);
});

test('taxes rejects a missing or non-array data field', () => {
  assert.throws(() => extractUnpaged({ result: 'success', code: 200 }, 'taxes'), /expected data array/);
  assert.throws(() => extractUnpaged({ result: 'success', code: 200, data: { Tax: {} } }, 'taxes'), /expected data array/);
});

test('taxes rejects a non-object envelope', () => {
  assert.throws(() => extractUnpaged(null, 'taxes'), /envelope is not an object/);
  assert.throws(() => extractUnpaged([], 'taxes'), /envelope is not an object/);
});

test('taxes rejects rows without the Tax model', () => {
  assert.throws(() => extractUnpaged({ result: 'success', code: 200, data: [{ Other: { id: '1', name: 'a', value: '1' } }] }, 'taxes'), /Missing model Tax/);
  assert.throws(() => extractUnpaged({ result: 'success', code: 200, data: ['x'] }, 'taxes'), /Invalid row/);
});

test('taxes rejects invalid ids (zero, non-numeric, missing)', () => {
  for (const id of [0, '0', 'abc', '', undefined]) {
    assert.throws(() => extractUnpaged({ result: 'success', code: 200, data: [{ Tax: { id, name: 'a', value: '1' } }] }, 'taxes'), /Invalid Tax id/, `id=${id}`);
  }
});

test('taxes rejects duplicate ids within one response (no double counting)', () => {
  const dup = [{ Tax: { id: '1', name: 'VAT', value: '15' } }, { Tax: { id: '1', name: 'VAT copy', value: '15' } }];
  assert.throws(() => extractUnpaged({ result: 'success', code: 200, data: dup }, 'taxes'), /Duplicate Tax id 1/);
});

test('taxes rejects invalid name, value, or is_active', () => {
  assert.throws(() => extractUnpaged({ result: 'success', code: 200, data: [{ Tax: { id: '1', name: '  ', value: '15' } }] }, 'taxes'), /Invalid Tax name/);
  assert.throws(() => extractUnpaged({ result: 'success', code: 200, data: [{ Tax: { id: '1', name: 'VAT', value: 'fifteen' } }] }, 'taxes'), /Invalid Tax value/);
  assert.throws(() => extractUnpaged({ result: 'success', code: 200, data: [{ Tax: { id: '1', name: 'VAT', value: '15', is_active: 2 } }] }, 'taxes'), /Invalid Tax is_active/);
});

test('taxes: truncated / non-JSON body is refused by the transport (body must be complete)', async () => {
  const { fetcher } = fakeFetch(() => '{"result":"success","code":200,"data":[{"Tax":{"id":"1"');
  await assert.rejects(fetchAllRecords('taxes', {}, env, fetcher), /non-JSON/);
});

test('taxes: upstream HTTP error propagates with its status (no masking, no empty success)', async () => {
  const { fetcher } = fakeFetch(() => 405);
  await assert.rejects(fetchAllRecords('taxes', {}, env, fetcher), (e) => /HTTP 405/.test(e.message) && e.status === 405);
});

test('taxes: an invalid envelope in --all never returns partial data', async () => {
  const { fetcher } = fakeFetch(() => ({ result: 'error', code: 500, data: TAX_ROWS }));
  await assert.rejects(fetchAllRecords('taxes', {}, env, fetcher), /envelope|result|code/);
});

// ---- taxes: guards -------------------------------------------------------------------------

test('buildQuery still rejects limit/page for taxes (guard is not weakened)', () => {
  assert.throws(() => buildQuery(ENTITIES.taxes.params, { limit: '20' }), /Query parameter not allowed: limit/);
  assert.throws(() => buildQuery(ENTITIES.taxes.params, { page: '1' }), /Query parameter not allowed: page/);
});

test('broker read validation rejects limit for taxes but accepts the plain list', () => {
  assert.throws(() => validateGet({ path: '/api2/taxes.json', query: { limit: '20' } }));
  assert.doesNotThrow(() => validateGet({ path: '/api2/taxes.json', query: {} }));
});

// ---- regression: paginated entities keep their completeness rule ---------------------------

test('clients --all still paginates with limit and page and is complete when proven', async () => {
  const { fetcher, calls } = fakeFetch(() => CLIENTS_2);
  const r = await fetchAllRecords('clients', { pageSize: 100 }, env, fetcher);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('limit'), '100');
  assert.equal(calls[0].searchParams.get('page'), '1');
  assert.equal(r.complete, true);
  assert.equal(r.count, 2);
});

test('clients single page keeps limit (regression)', async () => {
  const { fetcher, calls } = fakeFetch(() => CLIENTS_2);
  const page = await listPage('clients', { limit: 20 }, env, fetcher, { sleep: noSleep });
  assert.equal(calls[0].searchParams.get('limit'), '20');
  assert.equal(page.complete, true);
});

test('paginated entities still reject contradictory pagination (taxes exemption does not leak)', async () => {
  const bad = { ...CLIENTS_2, pagination: { page: 1, page_count: 0, total_results: 0 } };
  const { fetcher } = fakeFetch(() => bad);
  await assert.rejects(fetchAllRecords('clients', {}, env, fetcher), /Invalid|Export blocked|pagination/i);
});

test('paginated entities still reject a missing pagination proof on --all', async () => {
  const noMeta = { result: 'success', code: 200, data: CLIENTS_2.data };
  const { fetcher } = fakeFetch(() => noMeta);
  await assert.rejects(fetchAllRecords('clients', {}, env, fetcher), /pagination metadata|Export blocked/i);
});
