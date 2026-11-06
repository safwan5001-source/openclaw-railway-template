// Product/category/party duplicate checks must read the COMPLETE list without Daftra search filters
// (the `keywords` filter on /products fails with "Invalid page") and compare locally; any failure or
// unproven completeness must BLOCK the proposal (fail closed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDaftra } from './daftra-fake.test-helper.mjs';
import { createProposal } from './daftra-proposal.mjs';

const OP = 'operator-secret-0123456789-0123456789-abcdef';
async function setup(seed) {
  const dir = await mkdtemp(join(tmpdir(), 'basht-dup-'));
  const env = { OPENCLAW_WORKSPACE_DIR: dir, DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'k', DAFTRA_WRITES_ENABLED: '1', DAFTRA_APPROVAL_SECRET: OP };
  return { env, fake: new FakeDaftra(seed), done: () => rm(dir, { recursive: true, force: true }) };
}
const newProduct = { name: 'Gasoline 95', unit_price: '2.18', tax1: 1, barcode: '6291041500999', product_code: 'G95', categories_id: [12], status: 0 };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const page = (rows, { model = 'Product', p = 1, pageCount = 1, total = rows.length, next = null } = {}) =>
  ({ code: 200, data: rows.map((r) => ({ [model]: r })), pagination: { prev: p > 1 ? 'p' : null, next, page: p, page_count: pageCount, total_results: total } });

// Mirrors the real API: `keywords` on /products is rejected. Records every list request.
// `override(url)` may return a Response for the full-list walk (limit > 1); the limit=1 permission probe is passed through.
function tracked(fake, override) {
  const calls = [];
  const fetcher = async (url, options) => {
    const u = new URL(url);
    if (options?.method === 'GET' || !options?.method) calls.push(u.pathname + u.search);
    if (u.pathname === '/api2/products.json' && u.searchParams.has('keywords')) return json({ message: 'Invalid page' }, 400);
    if (override && u.searchParams.get('limit') !== '1') { const r = override(u); if (r) return r; }
    return fake.fetch(url, options);
  };
  return { fetcher, calls };
}
const listCalls = (calls, path) => calls.filter((c) => c.startsWith(path + '.json'));

test('product_create does not send keywords/barcode/product_code filters; a genuinely new product passes with 13 products listed', async () => {
  const products = Array.from({ length: 13 }, (_, i) => ({ id: 100 + i, name: 'Item ' + i, barcode: '62910415' + String(10000 + i), product_code: 'C' + i }));
  const { env, fake, done } = await setup({ lists: { products } });
  try {
    const { fetcher, calls } = tracked(fake);
    const p = await createProposal('product_create', newProduct, { env, fetcher });
    assert.equal(p.status, 'READY_FOR_APPROVAL', p.blocking?.join(' '));
    for (const c of listCalls(calls, '/api2/products')) assert.doesNotMatch(c, /keywords|barcode|product_code/, c);
    assert.ok(listCalls(calls, '/api2/products').some((c) => /limit=100/.test(c)), 'walks the complete list');
    assert.ok(p.checks.find((c) => c.name === 'no_remote_duplicate')?.ok);
  } finally { await done(); }
});

test('duplicates are found locally by name, barcode and product code with the existing normalisation', async () => {
  const cases = [
    [{ id: 1, name: '  GASOLINE 95 ' }, /products#1/],
    [{ id: 2, name: 'x', barcode: ' 6291041500999 ' }, /products#2/],
    [{ id: 3, name: 'y', product_code: 'g95' }, /products#3/],
  ];
  for (const [row, expect] of cases) {
    const { env, fake, done } = await setup({ lists: { products: [{ id: 99, name: 'unrelated', barcode: '111', product_code: 'Z' }, row] } });
    try {
      const { fetcher } = tracked(fake);
      const p = await createProposal('product_create', newProduct, { env, fetcher });
      assert.equal(p.status, 'BLOCKED'); assert.match(p.blocking.join(' '), expect);
      assert.equal((await createProposal('product_create', { ...newProduct, acknowledge_duplicates: ['products#' + row.id] }, { env, fetcher })).status, 'READY_FOR_APPROVAL');
    } finally { await done(); }
  }
});

test('a record that merely LACKS barcode/code never matches by them (no false positives from empty fields)', async () => {
  const { env, fake, done } = await setup({ lists: { products: [{ id: 5, name: 'Diesel' }, { id: 6, name: 'Oil', barcode: '', product_code: null }] } });
  try {
    const p = await createProposal('product_create', newProduct, { env, fetcher: tracked(fake).fetcher });
    assert.equal(p.status, 'READY_FOR_APPROVAL', p.blocking?.join(' '));
  } finally { await done(); }
});

test('duplicates are found on later pages of a large catalog (250 products = 3 pages)', async () => {
  const products = Array.from({ length: 250 }, (_, i) => ({ id: 1000 + i, name: 'Item ' + i, barcode: 'B' + i, product_code: 'C' + i }));
  products[240] = { id: 1240, name: 'Gasoline 95' };
  const { env, fake, done } = await setup({ lists: { products } });
  try {
    const { fetcher, calls } = tracked(fake);
    const p = await createProposal('product_create', newProduct, { env, fetcher });
    assert.equal(p.status, 'BLOCKED'); assert.match(p.blocking.join(' '), /products#1240/);
    assert.ok(listCalls(calls, '/api2/products').filter((c) => /limit=100/.test(c)).length >= 3);
  } finally { await done(); }
});

test('product_update: other products are matched locally, the target itself is never its own duplicate', async () => {
  const { env, fake, done } = await setup({
    lists: { products: [{ id: 9, name: 'Diesel 10L', barcode: '6291041500213', product_code: 'D10' }, { id: 50, name: 'other', barcode: '6291041500777' }] },
    records: { products: { 9: { id: 9, name: 'Diesel 10L', unit_price: '18.90', tax1: 1, product_code: 'D10', barcode: '6291041500213', status: 0 } } },
  });
  try {
    const { fetcher, calls } = tracked(fake);
    const self = await createProposal('product_update', { product_id: 9, changes: { barcode: '6291041500213', unit_price: '19' } }, { env, fetcher });
    assert.equal(self.status, 'READY_FOR_APPROVAL', self.blocking?.join(' '));
    const dup = await createProposal('product_update', { product_id: 9, changes: { barcode: '6291041500777' } }, { env, fetcher });
    assert.equal(dup.status, 'BLOCKED'); assert.match(dup.blocking.join(' '), /products#50/);
    for (const c of listCalls(calls, '/api2/products')) assert.doesNotMatch(c, /keywords|barcode|product_code/, c);
  } finally { await done(); }
});

test('FAIL CLOSED: API failure during the duplicate scan blocks (HTTP 500 and 400 Invalid page)', async () => {
  for (const status of [500, 400]) {
    const { env, fake, done } = await setup({ lists: { products: [] } });
    try {
      const { fetcher } = tracked(fake, () => json({ message: 'Invalid page' }, status));
      const p = await createProposal('product_create', newProduct, { env, fetcher });
      assert.equal(p.status, 'BLOCKED', String(status));
      const check = p.checks.find((c) => c.name === 'no_remote_duplicate');
      assert.equal(check.ok, false); assert.match(check.detail, /Duplicate scan failed/);
    } finally { await done(); }
  }
});

test('FAIL CLOSED: a network error during the duplicate scan blocks', async () => {
  const { env, fake, done } = await setup({ lists: { products: [] } });
  try {
    const { fetcher } = tracked(fake, () => { throw new TypeError('fetch failed'); });
    const p = await createProposal('product_create', newProduct, { env, fetcher });
    assert.equal(p.status, 'BLOCKED'); assert.match(p.blocking.join(' '), /Duplicate scan failed/);
  } finally { await done(); }
});

test('FAIL CLOSED: incomplete / unprovable product lists block, even when no duplicate is visible', async () => {
  const row = (id) => ({ id, name: 'Item ' + id, barcode: 'B' + id });
  const scenarios = {
    'pagination metadata missing': () => json({ code: 200, data: [{ Product: row(1) }] }),
    'fewer rows than total_results': () => json(page([row(1), row(2)], { total: 5 })),
    'last page still links to next': () => json(page([row(1)], { next: 'n' })),
    'non-final page without next link': () => json(page([row(1)], { pageCount: 2, total: 2 })),
    'collection larger than the scan limit': () => json(page([row(1)], { total: 20001, pageCount: 201, next: 'n' })),
    'page number out of order': () => json(page([row(1)], { p: 2, pageCount: 2, total: 2 })),
    'rows is not a list': () => json({ code: 200, data: 'oops', pagination: { page: 1, page_count: 1, total_results: 0, next: null, prev: null } }),
  };
  for (const [name, handler] of Object.entries(scenarios)) {
    const { env, fake, done } = await setup({ lists: { products: [] } });
    try {
      const p = await createProposal('product_create', newProduct, { env, fetcher: tracked(fake, handler).fetcher });
      assert.equal(p.status, 'BLOCKED', name);
      const check = p.checks.find((c) => c.name === 'no_remote_duplicate');
      assert.equal(check?.ok, false, name); assert.match(check.detail, /Duplicate scan failed/, name);
    } finally { await done(); }
  }
});

test('a collection that changes between pages is rejected, not guessed', async () => {
  const { env, fake, done } = await setup({ lists: { products: [] } });
  try {
    let n = 0;
    const { fetcher } = tracked(fake, (u) => {
      const pg = Number(u.searchParams.get('page'));
      n++;
      return json(page([{ id: pg, name: 'P' + pg }], { p: pg, pageCount: 2, total: n > 2 ? 3 : 2, next: pg === 1 ? 'n' : null }));
    });
    assert.equal((await createProposal('product_create', newProduct, { env, fetcher })).status, 'BLOCKED');
  } finally { await done(); }
});

test('category_create reads all categories unfiltered and compares name + parent locally', async () => {
  const cats = [{ id: 12, name: 'Fuel', parent_id: 0 }, { id: 20, name: 'Premium', parent_id: 12 }, { id: 21, name: 'Premium', parent_id: 13 }];
  const { env, fake, done } = await setup({ lists: { product_categories: cats }, records: { product_categories: { 12: cats[0], 13: { id: 13, name: 'Oil', parent_id: 0 } } } });
  try {
    const { fetcher, calls } = tracked(fake);
    const dup = await createProposal('category_create', { name: ' premium ', parent_id: 12 }, { env, fetcher });
    assert.equal(dup.status, 'BLOCKED'); assert.match(dup.blocking.join(' '), /product_categories#20/); assert.doesNotMatch(dup.blocking.join(' '), /#21/);
    assert.equal((await createProposal('category_create', { name: 'Premium', parent_id: 0 }, { env, fetcher })).status, 'READY_FOR_APPROVAL');
    for (const c of listCalls(calls, '/api2/product_categories')) assert.doesNotMatch(c, /parent_id/, c);
  } finally { await done(); }
});

test('category_create fails closed on an incomplete category list', async () => {
  const { env, fake, done } = await setup({ lists: { product_categories: [] } });
  try {
    const { fetcher } = tracked(fake, (u) => (u.pathname === '/api2/product_categories.json' ? json(page([{ id: 1, name: 'x', parent_id: 0 }], { model: 'ProductCategory', total: 3 })) : null));
    const p = await createProposal('category_create', { name: 'New' }, { env, fetcher });
    assert.equal(p.status, 'BLOCKED'); assert.match(p.blocking.join(' '), /Duplicate scan failed/);
  } finally { await done(); }
});

test('customer/supplier duplicate scan never falls back to the keywords filter: an oversized or incomplete book blocks', async () => {
  const party = { business_name: 'شركة نبراس', email: 'a@b.co', phone1: '+966501234567' };
  for (const resource of ['clients', 'suppliers']) {
    const type = resource === 'clients' ? 'client_create' : 'supplier_create';
    const model = resource === 'clients' ? 'Client' : 'Supplier';
    for (const handler of [
      () => json(page([{ id: 1, business_name: 'x' }], { model, total: 20001, pageCount: 201, next: 'n' })),
      () => json(page([{ id: 1, business_name: 'x' }], { model, total: 4 })),
    ]) {
      const { env, fake, done } = await setup({ lists: { [resource]: [] } });
      try {
        const { fetcher, calls } = tracked(fake, (u) => (u.pathname === '/api2/' + resource + '.json' ? handler() : null));
        const p = await createProposal(type, party, { env, fetcher });
        assert.equal(p.status, 'BLOCKED', resource); assert.match(p.blocking.join(' '), /Duplicate scan failed/);
        assert.equal(calls.filter((c) => /keywords/.test(c)).length, 0, 'no keywords request');
      } finally { await done(); }
    }
  }
});
