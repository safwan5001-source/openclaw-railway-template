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
import { review } from './daftra-approve.mjs';

const OP = 'operator-secret-0123456789-0123456789-abcdef';
const nepras = { id: 4, business_name: 'شركة نبراس', email: 'old@nepras.com', phone1: '+966501111111', bn1: '300000000000003', bn1_label: 'VAT number', city: 'Riyadh', country_code: 'SA', credit_limit: '1000.00' };
const supplier = { id: 7, business_name: 'مورد الوقود', email: 'sup@fuel.com', phone1: '+966502222222', city: 'Jeddah', is_offline: '0', supplier_number: 12, password: 'hash', created: 't', default_currency_code: 'SAR' };
async function setup(seed = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'basht-par-'));
  const env = { OPENCLAW_WORKSPACE_DIR: dir, DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'k', DAFTRA_WRITES_ENABLED: '1', DAFTRA_APPROVAL_SECRET: OP };
  const fake = new FakeDaftra({ records: { clients: { 4: nepras }, suppliers: { 7: supplier }, products: {}, invoices: {}, product_categories: {} }, ...seed });
  return { env, fake, done: () => rm(dir, { recursive: true, force: true }) };
}
const R = (c) => ({ env: c.env, fetcher: c.fake.fetch });
const exec = (c, p) => executeProposal({ id: p.id, phrase: approvalPhrase(c.env, p) }, R(c));
const newClient = { business_name: 'Gulf Fuel Co', email: 'Accounts@GulfFuel.com', phone1: '+966 50 777 8899', country_code: 'sa', bn1: '311111111111113', bn1_label: 'VAT number', type: 3 };

test('party preflight: documented fields only; credentials/notify/opening balance/suspend/custom data are refused', () => {
  const bad = (type, input, rx) => assert.throws(() => prepareFinancialAction(type, input), rx, JSON.stringify(input));
  for (const f of ['password', 'confirm_password', 'send_notify', 'starting_balance', 'starting_balance_date', 'suspend', 'attachment', 'ClientDetail', 'le_custom_data_client', 'branch_id', 'client_number', 'id', 'staff_id'])
    bad('client_create', { business_name: 'x', [f]: 1 }, /not supported/);
  bad('supplier_create', { business_name: 'x', is_offline: 1, supplier_number: 5 }, /not supported/);
  bad('client_create', { business_name: 'x', is_offline: 1 }, /only suppliers may set is_offline/);
  bad('client_create', {}, /business_name is required/);
  bad('client_create', { business_name: 'x'.repeat(101) }, /business_name/);
  bad('client_create', { business_name: 'x', nonsense: 1 }, /Unknown client field/);
  bad('client_create', { business_name: 'x\u202edrowssap' }, /Invalid characters/);                    // bidi override
  bad('client_create', { business_name: 'x\u001b[31mred' }, /Invalid characters/);                     // ANSI escape
  bad('client_create', { business_name: 'line1\nline2' }, /Invalid characters/);
  bad('client_create', { business_name: 'x', notes: 'ok\u0000nul' }, /Invalid characters/);
  for (const email of ['a@b', 'a b@c.com', '<x@y.com>', 'a@b.c', '@x.com', 'x@y.com,z@y.com'])
    bad('client_create', { business_name: 'x', email }, /Invalid email/);
  for (const phone of ['abc', '12', '+++', '1'.repeat(60)]) bad('client_create', { business_name: 'x', phone1: phone }, /phone1/);
  bad('client_create', { business_name: 'x', country_code: 'SAU' }, /alpha-2/);
  bad('client_create', { business_name: 'x', default_currency_code: 'SR' }, /ISO 4217/);
  bad('client_create', { business_name: 'x', bn1: "<script>" }, /bn1/);
  bad('client_create', { business_name: 'x', credit_limit: '-5' }, /plain non-negative decimal/);
  bad('client_create', { business_name: 'x', credit_limit: '1e9' }, /plain non-negative decimal/);
  bad('client_create', { business_name: 'x', link: 'javascript:alert(1)' }, /http\(s\)/);
  bad('client_create', { business_name: 'x', link: 'https://u:p@evil.com' }, /without credentials/);
  bad('client_create', { business_name: 'x', type: 5 }, /type/);
  bad('client_create', { business_name: 'x', birth_date: '2020-02-30' }, /birth_date/);
  bad('supplier_create', { business_name: 's' }, /email, or is_offline/);
  const ok = prepareFinancialAction('supplier_create', { business_name: 's', is_offline: true });
  assert.deepEqual(ok.request.body, { Supplier: { business_name: 's', is_offline: 1 } });
  assert.equal(ok.request.path, '/api2/suppliers.json');
  const c = prepareFinancialAction('client_create', newClient);
  assert.equal(c.request.body.Client.email, 'accounts@gulffuel.com');                                   // normalised
  assert.equal(c.request.body.Client.country_code, 'SA');
  assert.ok(prepareFinancialAction('client_create', { business_name: 'مؤسسة "الأمل" & Sons <ltd>' }).request.body.Client.business_name.includes('<ltd>'));   // data, never markup
});

test('client update sends only real changes, normalises before comparing, rejects clearing and no-ops', () => {
  const upd = (changes, current = nepras) => prepareFinancialAction('client_update', { client_id: 4, changes }, { current });
  const r = upd({ email: 'NEW@nepras.com', phone1: '+966501111111', city: 'Riyadh', credit_limit: '2500' });
  assert.deepEqual(r.request.body, { Client: { email: 'new@nepras.com', credit_limit: '2500.00' } });
  assert.deepEqual(r.highlights.map((h) => h.field), ['email', 'credit_limit']);
  assert.equal(r.request.method, 'PUT'); assert.equal(r.request.path, '/api2/clients/4.json');
  assert.throws(() => upd({ email: 'OLD@NEPRAS.COM', city: 'Riyadh' }), /No changes/);
  assert.throws(() => upd({ email: '' }), /clearing a field is not supported/);
  assert.throws(() => upd({ notes: null }), /clearing a field is not supported/);
  assert.throws(() => upd({}), /non-empty/);
  assert.throws(() => upd({ password: 'abcdef' }), /not supported/);
  assert.throws(() => prepareFinancialAction('client_update', { client_id: '4/../5', changes: { city: 'x' } }), /client_id/);
});

test('supplier update sends the FULL current writable record (no blanking), never read-only/credential fields', () => {
  const r = prepareFinancialAction('supplier_update', { supplier_id: 7, changes: { phone1: '+966555555555' } }, { current: supplier });
  assert.deepEqual(r.request.body.Supplier, { business_name: 'مورد الوقود', email: 'sup@fuel.com', phone1: '+966555555555', city: 'Jeddah', default_currency_code: 'SAR', is_offline: 0 });
  for (const leaked of ['password', 'supplier_number', 'created', '"id"']) assert.equal(JSON.stringify(r.request.body).includes(leaked), false, leaked);
  assert.deepEqual(r.changes.map((c) => c.field), ['phone1']);
  assert.ok(r.carried_fields.includes('business_name') && !r.carried_fields.includes('phone1'));
  assert.ok(r.warnings.some((w) => /full current record/.test(w)));
  assert.throws(() => prepareFinancialAction('supplier_update', { supplier_id: 7, changes: { phone1: '+966555555555' } }), /needs the current record/);
  assert.throws(() => prepareFinancialAction('supplier_update', { supplier_id: 7, changes: { city: 'x' } }, { current: { id: 7, email: 'a@b.com' } }), /no business_name/);
  assert.throws(() => prepareFinancialAction('supplier_update', { supplier_id: 7, changes: { city: 'x' } }, { current: { id: 7, business_name: 'n' } }), /no email and not be offline/);
});

test('approved customer creation: one POST, normalised body, read back and verified, nothing before approval', async () => {
  const c = await setup({ post: () => ({ status: 202, json: { result: 'successful', code: 202, id: 512, client_number: '0000715' } }) });
  try {
    c.fake.created.clients = { 512: { id: 512, business_name: 'Gulf Fuel Co', email: 'accounts@gulffuel.com', country_code: 'SA', bn1: '311111111111113' } };
    const p = await createProposal('client_create', newClient, R(c));
    assert.equal(p.status, 'READY_FOR_APPROVAL'); assert.deepEqual(p.effects, ['creates_client']);
    assert.equal(c.fake.posts.length, 0);
    const r = await exec(c, p);
    assert.equal(r.status, 'submitted'); assert.equal(r.record_id, '512'); assert.equal(r.verification.matched, true);
    assert.equal(c.fake.posts.length, 1);
    assert.equal(c.fake.posts[0].method, 'POST'); assert.equal(c.fake.posts[0].path, '/api2/clients.json');
    assert.deepEqual(JSON.parse(c.fake.posts[0].body), p.request.body);
    assert.equal((await createProposal('client_create', newClient, R(c))).status, 'BLOCKED');           // identical request: ledger
  } finally { await c.done(); }
});

test('duplicate guard: same tax number / email / phone / normalised name block creation (every page scanned), acknowledgement is explicit', async () => {
  const rows = (extra) => ({ lists: { clients: [...Array.from({ length: 205 }, (_, i) => ({ id: 1000 + i, business_name: 'Other ' + i, email: 'o' + i + '@x.com' })), extra] } });
  for (const [extra, reason] of [
    [{ id: 9001, business_name: 'Different', bn1: '3111 1111-11111.13', email: 'z@z.com' }, 'same tax number'],
    [{ id: 9002, business_name: 'Different', email: 'ACCOUNTS@gulffuel.COM' }, 'same email'],
    [{ id: 9003, business_name: 'Different', phone2: '00966 50-777-8899', phone1: '+966507778899' }, 'same phone'],
    [{ id: 9004, business_name: '  GULF   fuel co. ' }, 'same name'],
  ]) {
    const c = await setup(rows(extra));
    try {
      const input = { ...newClient, phone1: '+966507778899' };
      const p = await createProposal('client_create', input, R(c));
      assert.equal(p.status, 'BLOCKED', reason);
      assert.match(p.blocking.join(' '), new RegExp('clients#' + extra.id + ' \\(.*' + reason));
      const ack = await createProposal('client_create', { ...input, acknowledge_duplicates: ['clients#' + extra.id] }, R(c));
      assert.equal(ack.status, 'READY_FOR_APPROVAL');
    } finally { await c.done(); }
  }
});

test('supplier creation: own endpoint, duplicates by tax number, email-or-offline rule', async () => {
  const c = await setup({ lists: { suppliers: [{ id: 70, business_name: 'Old', bn1: '399999999999993' }] }, post: () => ({ status: 202, json: { result: 'successful', code: 202, id: 71 } }) });
  try {
    const dup = await createProposal('supplier_create', { business_name: 'New Supplier', email: 'n@s.com', bn1: '3999 9999 99999 93' }, R(c));
    assert.equal(dup.status, 'BLOCKED'); assert.match(dup.blocking.join(' '), /suppliers#70 \(same tax number\)/);
    c.fake.created.suppliers = { 71: { id: 71, business_name: 'New Supplier', email: 'n@s.com' } };
    const ok = await createProposal('supplier_create', { business_name: 'New Supplier', email: 'n@s.com' }, R(c));
    assert.equal(ok.status, 'READY_FOR_APPROVAL');
    const r = await exec(c, ok);
    assert.equal(r.record_id, '71'); assert.equal(c.fake.posts[0].path, '/api2/suppliers.json');
  } finally { await c.done(); }
});

test('customer update: before/after preview, PUT of only changed fields, key-field highlight, read-back', async () => {
  const c = await setup({ post: () => ({ status: 200, json: { result: 'successful', code: 200 } }) });
  try {
    const p = await createProposal('client_update', { client_id: 4, changes: { email: 'new@nepras.com', credit_limit: '2500' } }, R(c));
    assert.equal(p.status, 'READY_FOR_APPROVAL');
    assert.deepEqual(p.meta.changes.map((x) => [x.field, x.from, x.to]), [['email', 'old@nepras.com', 'new@nepras.com'], ['credit_limit', '1000.00', '2500.00']]);
    const text = await review(p.id, c.env);
    assert.match(text, /\*\*\* KEY FIELD CHANGE email: old@nepras.com => new@nepras.com \*\*\*/);
    assert.match(text, /Sends   : PUT \/api2\/clients\/4\.json/);
    c.fake.post = () => { Object.assign(c.fake.records.clients[4], { email: 'new@nepras.com', credit_limit: '2500.00' }); return { status: 200, json: { result: 'successful', code: 200 } }; };
    const r = await exec(c, p);
    assert.equal(r.status, 'submitted'); assert.equal(r.record_id, '4'); assert.equal(r.verification.matched, true);
    assert.equal(c.fake.posts[0].method, 'PUT'); assert.deepEqual(JSON.parse(c.fake.posts[0].body), { Client: { email: 'new@nepras.com', credit_limit: '2500.00' } });
  } finally { await c.done(); }
});

test('overwrite protection: record edited meanwhile, no-op, email taken by another customer, unknown id', async () => {
  const c = await setup({ lists: { clients: [{ id: 4, business_name: 'شركة نبراس', email: 'old@nepras.com' }, { id: 5, business_name: 'Other', email: 'taken@x.com' }] }, post: () => ({ status: 200, json: { code: 200 } }) });
  try {
    const stale = await createProposal('client_update', { client_id: 4, changes: { city: 'Dammam' } }, R(c));
    c.fake.records.clients[4].city = 'Jeddah';                                                     // someone else edited it
    await assert.rejects(exec(c, stale), (e) => e.code === 'RECHECK_FAILED' && /Changed in Daftra since the preview: city/.test(e.message));
    assert.equal(c.fake.posts.length, 0);
    await assert.rejects(createProposal('client_update', { client_id: 4, changes: { city: 'Jeddah' } }, R(c)), /No changes/);
    const taken = await createProposal('client_update', { client_id: 4, changes: { email: 'Taken@x.com' } }, R(c));
    assert.equal(taken.status, 'BLOCKED'); assert.match(taken.blocking.join(' '), /clients#5 \(same email\)/);
    assert.equal((await createProposal('client_update', { client_id: 404, changes: { city: 'x' } }, R(c))).status, 'BLOCKED');
    const self = await createProposal('client_update', { client_id: 4, changes: { business_name: 'شركة نبراس للخدمات' } }, R(c));
    assert.equal(self.status, 'READY_FOR_APPROVAL');                                                // the record itself is never a duplicate
  } finally { await c.done(); }
});

test('supplier update: stale carried field blocks; a read-back that finds a carried field changed is reported', async () => {
  const c = await setup({ post: () => ({ status: 200, json: { code: 200 } }) });
  try {
    const p = await createProposal('supplier_update', { supplier_id: 7, changes: { phone1: '+966555555555' } }, R(c));
    assert.equal(p.status, 'READY_FOR_APPROVAL'); assert.ok(p.meta.carried_fields.includes('city'));
    c.fake.records.suppliers[7].city = 'Dammam';                                                  // a CARRIED field changed meanwhile
    await assert.rejects(exec(c, p), (e) => e.code === 'RECHECK_FAILED' && /city/.test(e.message));
    c.fake.records.suppliers[7].city = 'Jeddah';
    const fresh = await createProposal('supplier_update', { supplier_id: 7, changes: { phone1: '+966555555555' } }, R(c));
    c.fake.post = () => { Object.assign(c.fake.records.suppliers[7], { phone1: '+966555555555', city: '' }); return { status: 200, json: { code: 200 } }; };   // Daftra blanked a field
    const r = await exec(c, fresh);
    assert.equal(r.status, 'submitted');
    assert.equal(r.verification.matched, false);
    assert.ok(r.verification.mismatches.some((m) => m.field === 'city'));
    assert.deepEqual(JSON.parse(c.fake.posts[0].body).Supplier.city, 'Jeddah');                     // the carried value was sent
  } finally { await c.done(); }
});

test('Daftra validation errors (400) and network failures are handled without duplicates', async () => {
  let c = await setup({ post: () => ({ status: 400, json: { result: 'failed', code: 400, message: 'Bad Request', validation_errors: { email: 'taken' } } }) });
  try {
    const p = await createProposal('client_create', newClient, R(c));
    const r = await exec(c, p);
    assert.equal(r.status, 'rejected'); assert.match(r.message, /Nothing was created/);
    assert.equal((await createProposal('client_create', newClient, R(c))).status, 'READY_FOR_APPROVAL');   // a corrected retry is allowed
  } finally { await c.done(); }
  c = await setup({ postError: Object.assign(new Error('reset'), { name: 'TimeoutError' }) });
  try {
    const p = await createProposal('client_create', newClient, R(c));
    assert.equal((await exec(c, p)).status, 'ambiguous');
    assert.equal(c.fake.posts.length, 1);
    assert.equal((await createProposal('client_create', newClient, R(c))).status, 'BLOCKED');                // no blind re-send
    await assert.rejects(exec(c, p), (e) => e.code === 'ALREADY_USED');
  } finally { await c.done(); }
});

test('authorization: no phrase, wrong phrase or another proposal\'s phrase sends nothing; writes off by default', async () => {
  const c = await setup();
  try {
    const a = await createProposal('client_create', newClient, R(c));
    const b = await createProposal('client_create', { ...newClient, business_name: 'Other Co', email: 'o@o.com', bn1: undefined, phone1: '+966511111111' }, R(c));
    for (const phrase of ['', 'yes', 'APPROVE ' + a.id, approvalPhrase(c.env, b)])
      await assert.rejects(executeProposal({ id: a.id, phrase }, R(c)), (e) => e.code === 'PHRASE_MISMATCH');
    await assert.rejects(executeProposal({ id: a.id, phrase: approvalPhrase(c.env, a) }, { env: { ...c.env, DAFTRA_WRITES_ENABLED: undefined }, fetcher: c.fake.fetch }), (e) => e.code === 'WRITES_DISABLED');
    assert.equal(c.fake.posts.length, 0);
  } finally { await c.done(); }
});

test('write allowlist: PUT only to /api2/clients/<id>.json and /api2/suppliers/<id>.json; credentials/notify/balance fields are unsendable', () => {
  const okC = { method: 'PUT', path: '/api2/clients/4.json', query: '', body: { Client: { city: 'x' } } };
  assert.doesNotThrow(() => assertWriteAllowed('client_update', okC));
  assert.doesNotThrow(() => assertWriteAllowed('supplier_update', { method: 'PUT', path: '/api2/suppliers/7.json', query: '', body: { Supplier: { business_name: 'x' } } }));
  assert.doesNotThrow(() => assertWriteAllowed('client_create', { method: 'POST', path: '/api2/clients.json', query: '', body: { Client: { business_name: 'x' } } }));
  for (const bad of [
    { ...okC, method: 'DELETE' }, { ...okC, method: 'PATCH' }, { ...okC, method: 'POST' }, { ...okC, path: '/api2/clients.json' }, { ...okC, path: '/api2/clients/4/../5.json' },
    { ...okC, path: '/api2/suppliers/4.json' }, { ...okC, path: '/api2/clients/04x.json' }, { ...okC, query: 'verify_phone2=1' },
    ...['password', 'confirm_password', 'send_notify', 'starting_balance', 'suspend', 'attachment', 'ClientDetail', 'id', 'branch_id'].map((k) => ({ ...okC, body: { Client: { city: 'x', [k]: 'v' } } })),
    { ...okC, body: { Client: { city: 'x' }, ClientDetail: {} } }, { ...okC, body: { Supplier: { city: 'x' } } },
  ]) assert.throws(() => assertWriteAllowed('client_update', bad), WriteRefused, JSON.stringify(bad));
  assert.throws(() => assertWriteAllowed('supplier_update', { method: 'PUT', path: '/api2/suppliers/7.json', query: '', body: { Supplier: { business_name: 'x', supplier_number: 3 } } }), WriteRefused);
  assert.throws(() => assertWriteAllowed('client_delete', okC), WriteRefused);
  assert.throws(() => assertWriteAllowed('supplier_delete', okC), WriteRefused);
});

test('a supplier update (full record) is never flagged as a duplicate of ITSELF, but still of another record', async () => {
  const self = { id: 7, business_name: 'مورد الوقود', email: 'sup@fuel.com', phone1: '+966502222222' };
  let c = await setup({ lists: { suppliers: [self] } });
  try { assert.equal((await createProposal('supplier_update', { supplier_id: 7, changes: { city: 'Dammam' } }, R(c))).status, 'READY_FOR_APPROVAL'); } finally { await c.done(); }
  c = await setup({ lists: { suppliers: [self, { id: 8, business_name: 'Other', email: 'sup@fuel.com' }] } });
  try {
    const p = await createProposal('supplier_update', { supplier_id: 7, changes: { city: 'Dammam' } }, R(c));
    assert.equal(p.status, 'BLOCKED'); assert.match(p.blocking.join(' '), /suppliers#8 \(same email\)/);
  } finally { await c.done(); }
});
