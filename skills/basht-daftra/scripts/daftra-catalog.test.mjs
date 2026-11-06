import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDaftra } from './daftra-fake.test-helper.mjs';
import { createProposal } from './daftra-proposal.mjs';
import { approvalPhrase } from './daftra-auth.mjs';
import { executeProposal, assertWriteAllowed, WriteRefused } from './daftra-write.mjs';
import { prepareFinancialAction } from './daftra-finance-preflight.mjs';

const OP = 'operator-secret-0123456789-0123456789-abcdef';
async function setup(seed) {
  const dir = await mkdtemp(join(tmpdir(), 'basht-cat-'));
  const env = { OPENCLAW_WORKSPACE_DIR: dir, DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'k', DAFTRA_WRITES_ENABLED: '1', DAFTRA_APPROVAL_SECRET: OP };
  return { env, fake: new FakeDaftra(seed), done: () => rm(dir, { recursive: true, force: true }) };
}
const run = (env, fake) => ({ env, fetcher: fake.fetch });
const ok = (env) => (p) => ({ id: p.id, phrase: approvalPhrase(env, p) });
const newProduct = { name: 'Gasoline 95', unit_price: '2.18', tax1: 1, barcode: '6291041500999', product_code: 'G95', categories_id: [12], status: 0 };

test('product preflight: strict schema, explicit tax, no stock/bundle/auto-create fields, no zero price by accident', () => {
  const good = prepareFinancialAction('product_create', newProduct);
  assert.equal(good.request.path, '/api2/products.json');
  assert.deepEqual(good.request.body.Product.categories_id, [12]);
  const bad = (input, rx) => assert.throws(() => prepareFinancialAction('product_create', { ...newProduct, ...input }), rx);
  for (const f of ['track_stock', 'tracking_type', 'initial_stock_level', 'store_id', 'low_stock_thershold', 'brand', 'category', 'ProductBundle'])
    bad({ [f]: 1 }, /not supported/);
  bad({ type: 3 }, /bundles are not supported/);
  bad({ unit_price: '1e3' }, /plain non-negative decimal/);
  bad({ unit_price: '-1' }, /plain non-negative decimal/);
  bad({ unit_price: '0' }, /allow_zero_price/);
  bad({ barcode: '1234' }, /barcode/);
  bad({ name: '   ' }, /name/);
  bad({ name: 'x'.repeat(256) }, /name/);
  bad({ tax1: '1; DROP' }, /tax1/);
  bad({ categories_id: [] }, /categories_id/);
  bad({ categories_id: [1, 1] }, /duplicates/);
  bad({ status: 7 }, /status/);
  bad({ discount: '5' }, /discount requires discount_type/);
  bad({ discount: '150', discount_type: 1 }, /exceed 100/);
  bad({ unknown_field: 1 }, /Unknown product field/);
  bad({ __proto__x: 1, id: 5 }, /not supported|Unknown/);
  assert.throws(() => prepareFinancialAction('product_create', { name: 'x', unit_price: '1' }), /tax1 is required/);
  assert.doesNotThrow(() => prepareFinancialAction('product_create', { ...newProduct, unit_price: '0', allow_zero_price: true }));
});

test('product update sends ONLY changed fields, highlights price changes, and rejects no-ops', () => {
  const current = { name: 'Diesel 10L', unit_price: '18.90', tax1: 1, description: 'old' };
  const r = prepareFinancialAction('product_update', { product_id: 9, changes: { unit_price: '25', name: 'Diesel 10L', description: 'new' } }, { current });
  assert.deepEqual(r.request.body, { Product: { unit_price: '25', description: 'new' } });
  assert.equal(r.request.method, 'PUT');
  assert.equal(r.request.path, '/api2/products/9.json');
  assert.deepEqual(r.price_changes.map((c) => [c.field, c.from, c.to, c.change_percent]), [['unit_price', '18.90', '25', 32.28]]);
  assert.throws(() => prepareFinancialAction('product_update', { product_id: 9, changes: { name: 'Diesel 10L', unit_price: '18.9' } }, { current }), /No changes/);
  assert.throws(() => prepareFinancialAction('product_update', { product_id: 9, changes: {} }), /empty/);
  assert.throws(() => prepareFinancialAction('product_update', { product_id: '9/../1', changes: { name: 'x' } }), /product_id/);
  assert.throws(() => prepareFinancialAction('product_update', { product_id: 9, changes: { unit_price: '0' } }, { current }), /allow_zero_price/);
  assert.throws(() => prepareFinancialAction('product_update', { product_id: 9, changes: { track_stock: 1 } }, { current }), /not supported/);
});

test('category preflight: documented fields only, category_type fixed to 1, no self-parenting', () => {
  const c = prepareFinancialAction('category_create', { name: 'Lubricants', parent_id: 12, display_order: 3 });
  assert.deepEqual(c.request.body, { Category: { name: 'Lubricants', category_type: 1, parent_id: 12, display_order: 3 } });
  assert.throws(() => prepareFinancialAction('category_create', { name: 'x', category_type: 2 }), /Unknown category field|category_type/);
  assert.throws(() => prepareFinancialAction('category_update', { category_id: 12, changes: { parent_id: 12 } }), /own parent/);
  assert.throws(() => prepareFinancialAction('category_update', { category_id: 12, changes: { image: 'x' } }), /Unknown category field/);
});

test('approved product creation: exactly one POST, read back and verified, nothing before approval', async () => {
  const { env, fake, done } = await setup({ post: () => ({ status: 202, json: { result: 'successful', code: 202, id: 777 } }) });
  try {
    fake.created.products = { 777: { id: 777, name: 'Gasoline 95', unit_price: '2.18', barcode: '6291041500999', product_code: 'G95' } };
    const p = await createProposal('product_create', newProduct, { ...run(env, fake), actor: 'u' });
    assert.equal(p.status, 'READY_FOR_APPROVAL');
    assert.equal(p.mode, 'final');
    assert.deepEqual(p.effects, ['creates_product']);
    assert.equal(fake.posts.length, 0);
    const r = await executeProposal(ok(env)(p), run(env, fake));
    assert.equal(r.status, 'submitted');
    assert.equal(r.record_id, '777');
    assert.equal(r.verification.matched, true);
    assert.equal(fake.posts.length, 1);
    assert.equal(fake.posts[0].method, 'POST');
    assert.equal(fake.posts[0].path, '/api2/products.json');
    assert.deepEqual(JSON.parse(fake.posts[0].body), p.request.body);
  } finally { await done(); }
});

test('product creation is blocked by: duplicate barcode/code/name, unknown category/supplier, bad tax', async () => {
  let c = await setup({ lists: { products: [{ id: 50, name: 'other', barcode: '6291041500999' }] } });
  try {
    const p = await createProposal('product_create', newProduct, run(c.env, c.fake));
    assert.equal(p.status, 'BLOCKED'); assert.match(p.blocking.join(' '), /products#50/);
    const ack = await createProposal('product_create', { ...newProduct, acknowledge_duplicates: ['products#50'] }, run(c.env, c.fake));
    assert.equal(ack.status, 'READY_FOR_APPROVAL');
  } finally { await c.done(); }
  c = await setup({ lists: { products: [{ id: 51, name: 'gasoline 95' }] } });
  try { assert.match((await createProposal('product_create', { ...newProduct, barcode: undefined, product_code: undefined }, run(c.env, c.fake))).blocking.join(' '), /products#51/); } finally { await c.done(); }
  c = await setup();
  try {
    assert.match((await createProposal('product_create', { ...newProduct, categories_id: [999] }, run(c.env, c.fake))).blocking.join(' '), /category 999/);
    assert.match((await createProposal('product_create', { ...newProduct, supplier_id: 999 }, run(c.env, c.fake))).blocking.join(' '), /supplier 999/);
    assert.match((await createProposal('product_create', { ...newProduct, tax1: 99 }, run(c.env, c.fake))).blocking.join(' '), /Tax 99 does not exist/);
  } finally { await c.done(); }
  c = await setup({ taxes: [{ id: 1, value: 15, included: 0, is_active: 0 }] });
  try { assert.match((await createProposal('product_create', newProduct, run(c.env, c.fake))).blocking.join(' '), /inactive/); } finally { await c.done(); }
});

test('approved price change: PUT to the exact product, partial body, read-back verified', async () => {
  const { env, fake, done } = await setup({ post: () => ({ status: 200, json: { result: 'successful', code: 200 } }) });
  try {
    const p = await createProposal('product_update', { product_id: 9, changes: { unit_price: '21.5' } }, run(env, fake));
    assert.equal(p.status, 'READY_FOR_APPROVAL');
    assert.equal(p.meta.price_changes[0].change_percent, 13.76);
    assert.deepEqual(p.meta.snapshot, { unit_price: '18.90' });
    fake.records.products[9].unit_price = '21.50';                  // what Daftra will hold after the PUT
    // the live record differs from the preview snapshot => must be blocked at approval time (concurrent edit)
    const stale = await createProposal('product_update', { product_id: 9, changes: { unit_price: '30' } }, run(env, fake));
    fake.records.products[9].unit_price = '99.00';
    await assert.rejects(executeProposal(ok(env)(stale), run(env, fake)), (e) => e.code === 'RECHECK_FAILED' && /Changed in Daftra since the preview/.test(e.message));
    assert.equal(fake.posts.length, 0);
    fake.records.products[9].unit_price = '18.90';
    const fresh = await createProposal('product_update', { product_id: 9, changes: { unit_price: '21.5' } }, run(env, fake));
    const staged = fake.records.products[9];
    fake.post = (url) => { staged.unit_price = '21.50'; return { status: 200, json: { result: 'successful', code: 200 } }; };
    const r = await executeProposal(ok(env)(fresh), run(env, fake));
    assert.equal(r.status, 'submitted');
    assert.equal(r.record_id, '9');
    assert.equal(r.verification.matched, true);
    assert.equal(fake.posts.length, 1);
    assert.equal(fake.posts[0].method, 'PUT');
    assert.equal(fake.posts[0].path, '/api2/products/9.json');
    assert.deepEqual(JSON.parse(fake.posts[0].body), { Product: { unit_price: '21.5' } });
    // same change again: the product already has the value, so it can no longer be proposed
    await assert.rejects(createProposal('product_update', { product_id: 9, changes: { unit_price: '21.5' } }, run(env, fake)), /No changes/);
  } finally { await done(); }
});

test('product update of a missing product is blocked; changing a barcode to another product\'s barcode is blocked', async () => {
  const { env, fake, done } = await setup({ lists: { products: [{ id: 50, name: 'o', barcode: '6291041500777' }] } });
  try {
    assert.equal((await createProposal('product_update', { product_id: 404, changes: { name: 'x' } }, run(env, fake))).status, 'BLOCKED');
    const p = await createProposal('product_update', { product_id: 9, changes: { barcode: '6291041500777' } }, run(env, fake));
    assert.equal(p.status, 'BLOCKED'); assert.match(p.blocking.join(' '), /products#50/);
  } finally { await done(); }
});

test('Daftra DUPLICATED (400) on product create is a clean rejection', async () => {
  const { env, fake, done } = await setup({ post: () => ({ status: 400, json: { result: 'failed', code: 400, error_type: 'DUPLICATED', extra_data: { id: 99 }, message: 'Duplicate' } }) });
  try {
    const p = await createProposal('product_create', newProduct, run(env, fake));
    const r = await executeProposal(ok(env)(p), run(env, fake));
    assert.equal(r.status, 'rejected');
    assert.match(r.message, /Nothing was created/);
  } finally { await done(); }
});

test('categories: create (id from Category), duplicate-name block, update with snapshot', async () => {
  const { env, fake, done } = await setup({ post: () => ({ status: 200, json: { result: 'success', code: 202, Category: { id: 31, name: 'Lubricants' } } }), lists: { product_categories: [{ id: 12, name: 'Fuel', parent_id: 0 }] } });
  try {
    fake.created.product_categories = { 31: { id: 31, name: 'Lubricants' } };
    assert.equal((await createProposal('category_create', { name: ' fuel ', parent_id: 0 }, run(env, fake))).status, 'BLOCKED');
    const p = await createProposal('category_create', { name: 'Lubricants', parent_id: 0 }, run(env, fake));
    assert.equal(p.status, 'READY_FOR_APPROVAL');
    const r = await executeProposal(ok(env)(p), run(env, fake));
    assert.equal(r.record_id, '31'); assert.equal(r.verification.matched, true);
    const u = await createProposal('category_update', { category_id: 12, changes: { name: 'Fuels' } }, run(env, fake));
    assert.equal(u.status, 'READY_FOR_APPROVAL');
    assert.deepEqual(u.request.body, { Category: { name: 'Fuels' } });
    assert.equal(u.request.path, '/api2/product_categories/12.json');
  } finally { await done(); }
});

test('write allowlist: PUT only to /api2/products/<id>.json and /api2/product_categories/<id>.json; no DELETE, no collection PUT, no traversal', () => {
  const upd = { method: 'PUT', path: '/api2/products/9.json', query: '', body: { Product: { name: 'x' } } };
  assert.doesNotThrow(() => assertWriteAllowed('product_update', upd));
  assert.doesNotThrow(() => assertWriteAllowed('category_update', { method: 'PUT', path: '/api2/product_categories/12.json', query: '', body: { Category: { name: 'x' } } }));
  for (const bad of [
    { ...upd, method: 'DELETE' }, { ...upd, method: 'PATCH' }, { ...upd, method: 'POST' },
    { ...upd, path: '/api2/products.json' }, { ...upd, path: '/api2/products/9/../1.json' }, { ...upd, path: '/api2/products/0.json' },
    { ...upd, path: '/api2/products/9.json?x=1' }, { ...upd, path: '/api2/invoices/9.json' }, { ...upd, path: '/api2/products/9.jsonx' },
    { ...upd, query: 'send=draft' }, { ...upd, body: { Product: { name: 'x', track_stock: 1 } } }, { ...upd, body: { Product: { name: 'x', initial_stock_level: 5 } } },
    { ...upd, body: { Product: { brand: 'new' } } },
  ]) assert.throws(() => assertWriteAllowed('product_update', bad), WriteRefused, JSON.stringify(bad));
  assert.throws(() => assertWriteAllowed('product_delete', upd), WriteRefused);
  assert.throws(() => assertWriteAllowed('category_update', { ...upd, path: '/api2/products/9.json' }), WriteRefused);
});
