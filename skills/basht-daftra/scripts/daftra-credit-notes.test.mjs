// Credit-note GET allowlist regression tests: no write capability is added.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENTITIES } from './daftra-entities.mjs';
import { validateGet, BadRead } from './daftra-broker-reads.mjs';
import { run } from './daftra-cli.mjs';

const env = { DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'test-key-not-real' };
const noSleep = async () => {};

test('credit note registry uses documented resource, model, and approved filters', () => {
  assert.equal(ENTITIES.credit_notes.path, 'credit_notes');
  assert.equal(ENTITIES.credit_notes.model, 'CreditNote');
  assert.equal(validateGet({ path: '/api2/credit_notes.json', query: { client_id: '48', no: '00004', limit: '20' } }).search.toString(),
    'client_id=48&no=00004&limit=20');
  assert.equal(validateGet({ path: '/api2/credit_notes/42.json' }).kind, 'one');
  assert.equal(validateGet({ path: '/api2/product_categories.json' }).kind, 'list');
  assert.equal(validateGet({ path: '/api2/treasuries.json' }).kind, 'list');
  for (const body of [
    { path: '/api2/credit_notes/00004.json' }, // visible document number != internal id
    { path: '/api2/credit_notes.json', query: { unknown: 'value' } },
    { path: '/api2/credit_notes.json', query: { date_from: '2026-02-30' } },
    { path: '/api2/credit_notes/42.json', query: { client_id: 48 } },
    { path: '/api2/credit_notes/42.json', method: 'DELETE' },
    { path: '/api2/credit_notes/42.json?method=DELETE' },
  ]) assert.throws(() => validateGet(body), BadRead);
});

test('credit note list and detail are GET-only and expose true internal identifiers', async () => {
  const requests = [];
  const credit = { id: 42, no: '00004', client_id: 48, summary_total: '20815.00' };
  const fetcher = async (url, options) => {
    requests.push({ path: url.pathname, query: url.searchParams.toString(), method: options.method, redirect: options.redirect });
    if (url.pathname === '/api2/credit_notes.json')
      return new Response(JSON.stringify({ data: [{ CreditNote: credit }], pagination: { page: 1, page_count: 1, total_results: 1, next: null } }), { status: 200 });
    if (url.pathname === '/api2/credit_notes/42.json')
      return new Response(JSON.stringify({ data: { CreditNote: credit } }), { status: 200 });
    throw Error('unexpected endpoint ' + url.pathname);
  };
  const c = await run(['capabilities'], { env });
  assert.ok(c.read.includes('credit_notes'));
  assert.ok(!c.writes.includes('credit_note'));
  const page = await run(['list', 'credit_notes', '--all', '--query', 'client_id=48'], { env, fetcher, sleep: noSleep });
  assert.equal(page.complete, true);
  assert.equal(page.count, 1);
  assert.equal(String(page.records[0].id), '42');
  assert.equal(page.records[0].no, '00004');
  const detail = await run(['get', 'credit_notes', '42'], { env, fetcher, sleep: noSleep });
  assert.equal(detail.record.no, '00004');
  assert.equal(detail.record.summary_total, '20815.00');
  assert.deepEqual(requests.map(r => r.path), ['/api2/credit_notes.json', '/api2/credit_notes/42.json']);
  assert.ok(requests.every(r => r.method === 'GET' && r.redirect === 'manual'));
  assert.equal(requests[0].query, 'client_id=48&limit=100&page=1');
});

test('reading an unknown credit-note serial as an id is refused; read permissions do not imply writes', async () => {
  await assert.rejects(run(['get', 'credit_notes', '00004'], { env }), /Invalid invoice ID/);
  const c = await run(['capabilities'], { env });
  assert.equal(c.writes_enabled, false);
  assert.ok(!c.writes.some(x => x.includes('credit_note')));
});
