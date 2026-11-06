import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDaftra } from './daftra-fake.test-helper.mjs';
import { createBroker, validateRequest } from './daftra-broker.mjs';
import { run } from './daftra-cli.mjs';
import { review } from './daftra-approve.mjs';

const OP = 'operator-secret-0123456789-0123456789-abcdef';
const WRITE = 'WRITE-KEY-aaaaaaaaaaaaaaaa'; const READ = 'READ-KEY-bbbbbbbbbbbbbbbbb';

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'basht-cb-'));
  for (const d of ['secrets', 'run', 'state', 'agent-ws']) await mkdir(join(base, d), { mode: 0o700 });
  await writeFile(join(base, 'secrets', 'approval'), OP, { mode: 0o600 });
  await writeFile(join(base, 'secrets', 'writekey'), WRITE, { mode: 0o600 });
  const sock = join(base, 'run', 'b.sock');
  const brokerEnv = { OPENCLAW_WORKSPACE_DIR: join(base, 'state'), DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_WRITES_ENABLED: '1',
    DAFTRA_APPROVAL_SECRET_FILE: join(base, 'secrets', 'approval'), DAFTRA_WRITE_API_KEY_FILE: join(base, 'secrets', 'writekey'), DAFTRA_BROKER_SOCKET: sock };
  const clientEnv = { OPENCLAW_WORKSPACE_DIR: join(base, 'agent-ws'), DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: READ, DAFTRA_BROKER_SOCKET: sock };
  const fake = new FakeDaftra();
  const inner = fake.fetch;
  fake.fetch = async (url, o = {}) => {                                  // a source invoice for the duplicate flow
    if ((o.method ?? 'GET') === 'GET' && url.pathname === '/api2/invoices/3.json') {
      fake.calls.push({ method: 'GET', path: url.pathname, headers: o.headers });
      return new Response(JSON.stringify({ data: { Invoice: { id: 3, no: 'INV-3', date: '2025-01-10', client_id: 4, currency_code: 'SAR', summary_total: '230.00' },
        InvoiceItem: [{ item: 'Diesel', quantity: 100, unit_price: 2, tax1: 1, product_id: 9 }] } }), { status: 200 });
    }
    return inner(url, o);
  };
  const broker = createBroker({ env: brokerEnv, fetcher: fake.fetch });
  await broker.listen();
  return { brokerEnv, clientEnv, fake, done: async () => { await broker.close(); await rm(base, { recursive: true, force: true }); } };
}
const phraseFrom = async (id, env) => (await review(id, env)).match(/APPROVE prop_\S+ \S+ (DRAFT|FINAL) [0-9a-f]{16}/)[0];

test('product price change through the broker: preview highlights the price, one PUT with the WRITE key, secrets never on the agent side', async () => {
  const c = await setup();
  try {
    assert.equal(c.clientEnv.DAFTRA_APPROVAL_SECRET, undefined);
    const p = await run(['propose', 'product_update', '--input', JSON.stringify({ product_id: 9, changes: { unit_price: '21.5' } })], { env: c.clientEnv });
    assert.equal(p.status, 'READY_FOR_APPROVAL');
    assert.ok(p.review.some((l) => /PRICE CHANGE unit_price: 18.90 => 21.5 \(\+13.76%\)/.test(l)));
    assert.equal(c.fake.posts.length, 0);
    const text = await review(p.proposal_id, c.brokerEnv);
    assert.match(text, /\*\*\* PRICE CHANGE unit_price/);
    assert.match(text, /Sends   : PUT \/api2\/products\/9\.json/);
    const phrase = await phraseFrom(p.proposal_id, c.brokerEnv);
    c.fake.post = () => { c.fake.records.products[9].unit_price = '21.50'; return { status: 200, json: { result: 'successful', code: 200 } }; };
    const r = await run(['execute', p.proposal_id, '--phrase', phrase, '--actor', 'user-1'], { env: c.clientEnv });
    assert.equal(r.status, 'submitted'); assert.equal(r.verification.matched, true);
    assert.equal(c.fake.posts.length, 1);
    assert.equal(c.fake.posts[0].method, 'PUT');
    assert.equal(c.fake.posts[0].headers.APIKEY, WRITE);
  } finally { await c.done(); }
});

test('duplicate through the broker: the agent supplies only overrides; broker reads the source, signs and executes once', async () => {
  const c = await setup();
  c.fake.created.invoices = { 5001: { id: 5001, summary_total: '230.00' } };
  try {
    const p = await run(['duplicate', 'invoices', '3', '--input', JSON.stringify({ date: '2025-03-01' })], { env: c.clientEnv });
    assert.equal(p.status, 'READY_FOR_APPROVAL');
    assert.equal(p.type, 'sales_invoice');
    assert.ok(p.review.some((l) => /DUPLICATE OF invoices#3 \(no\. INV-3\)/.test(l)));
    assert.equal(c.fake.posts.length, 0);
    assert.equal(JSON.stringify(p.request.body).includes('INV-3'), false);
    const r = await run(['execute', p.proposal_id, '--phrase', await phraseFrom(p.proposal_id, c.brokerEnv)], { env: c.clientEnv });
    assert.equal(r.status, 'submitted');
    assert.equal(c.fake.posts.length, 1);
    assert.equal(c.fake.posts[0].path, '/api2/invoices.json');
  } finally { await c.done(); }
});

test('broker schema: duplicate/product requests are strictly validated; no extra fields, ids or secrets accepted', () => {
  const ok = { cmd: 'propose_duplicate', source: 'invoices', docId: '3', overrides: { date: '2025-03-01' } };
  assert.doesNotThrow(() => validateRequest(ok));
  for (const bad of [{ ...ok, docId: '3/../4' }, { ...ok, docId: 3 }, { ...ok, source: 'Invoices;' }, { ...ok, overrides: [] }, { ...ok, env: {} }, { ...ok, DAFTRA_APPROVAL_SECRET: 'x' }, { ...ok, overrides: undefined }])
    assert.throws(() => validateRequest(bad), undefined, JSON.stringify(bad));
});

test('CLI duplicate refuses to run locally in broker mode, and a hostile source/override never reaches the wire', async () => {
  const c = await setup();
  try {
    const localEnv = { ...c.clientEnv, DAFTRA_APPROVAL_SECRET: OP };            // secret wrongly present on the agent side
    const p = await run(['duplicate', 'invoices', '3', '--input', JSON.stringify({ date: '2025-03-01' })], { env: localEnv, fetcher: async () => { throw Error('agent must not do network'); } });
    assert.equal(p.status, 'READY_FOR_APPROVAL');                                // served by the broker, not locally
    await assert.rejects(run(['duplicate', 'invoices', '3', '--input', JSON.stringify({ date: '2025-03-01', id: 99, payments: [{ amount: 1 }] })], { env: c.clientEnv }), /Unknown override/);
    await assert.rejects(run(['duplicate', 'expenses', '3', '--input', '{"date":"2025-03-01"}'], { env: c.clientEnv }), /source must be/);
    assert.equal(c.fake.posts.length, 0);
  } finally { await c.done(); }
});

test('customer creation and supplier update through the broker: agent has no secret, operator phrase required, one write with the WRITE key', async () => {
  const c = await setup();
  c.fake.records.suppliers = { 7: { id: 7, business_name: 'Fuel', email: 's@f.com', city: 'Jeddah' } };
  c.fake.created.clients = { 512: { id: 512, business_name: 'Gulf Fuel Co', email: 'a@g.com' } };
  try {
    c.fake.post = () => ({ status: 202, json: { result: 'successful', code: 202, id: 512, client_number: '0000715' } });
    const p = await run(['propose', 'client_create', '--input', JSON.stringify({ business_name: 'Gulf Fuel Co', email: 'a@g.com' })], { env: c.clientEnv });
    assert.equal(p.status, 'READY_FOR_APPROVAL');
    await assert.rejects(run(['execute', p.proposal_id, '--phrase', 'APPROVE ' + p.proposal_id + ' ' + p.request_hash.slice(0, 8) + ' FINAL'], { env: c.clientEnv }), (e) => e.code === 'PHRASE_MISMATCH');
    assert.equal(c.fake.posts.length, 0);
    const r = await run(['execute', p.proposal_id, '--phrase', await phraseFrom(p.proposal_id, c.brokerEnv)], { env: c.clientEnv });
    assert.equal(r.status, 'submitted');
    assert.equal(c.fake.posts.length, 1);
    assert.equal(c.fake.posts[0].path, '/api2/clients.json');
    assert.equal(c.fake.posts[0].headers.APIKEY, WRITE);
    const s = await run(['propose', 'supplier_update', '--input', JSON.stringify({ supplier_id: 7, changes: { city: 'Dammam' } })], { env: c.clientEnv });
    assert.equal(s.status, 'READY_FOR_APPROVAL');
    assert.ok(s.review.some((l) => /full record is sent/.test(l)));
    assert.equal(JSON.stringify(s).includes('password'), false);
  } finally { await c.done(); }
});
