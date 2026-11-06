// Read Access Repair V2: documented accounting endpoints, report parameter contract, failure classification,
// "Invalid page" resilience, single-record fallback, and the read-only access matrix. All offline, GET only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENTITIES, REPORTS, UNSUPPORTED_READS, normalizeReportParams, buildReportQuery } from './daftra-entities.mjs';
import { validateGet, performGet, BadRead } from './daftra-broker-reads.mjs';
import { listRecords, fetchAllRecords, getReport, getOneDetailed, DaftraError } from './daftra-readonly.mjs';
import { classifyFailure, summariseValidationErrors } from './daftra-errors.mjs';
import { createBrokerFetcher } from './daftra-broker-service-client.mjs';
import { accessReport } from './daftra-access-report.mjs';
import { parsePagination } from './daftra-normalize.mjs';
import { run } from './daftra-cli.mjs';

const env = { DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'test-key-not-real' };
const noSleep = async () => {};
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const page = (model, rows, { p = 1, count = 1, total = rows.length } = {}) => ({ code: 200, result: 'successful', data: rows.map((r) => ({ [model]: r })), pagination: { prev: null, next: p < count ? 'n' : null, page: p, page_count: count, total_results: total } });

// ---------------------------------------------------------------------------------------------------------------- 1. accounting reads
test('journals, journal_accounts, journal_cats and incomes are documented GET resources with their own model keys and limit ceilings', async () => {
  assert.deepEqual(['journals', 'journal_accounts', 'journal_cats', 'incomes'].map((e) => ENTITIES[e].model), ['Journal', 'JournalAccount', 'JournalCat', 'Income']);
  assert.equal(validateGet({ path: '/api2/journals.json', query: { date_from: '2026-01-01', date_to: '2026-01-31', draft: 0, limit: 500 } }).search.get('limit'), '100');       // journals max 100
  assert.equal(validateGet({ path: '/api2/journal_accounts.json', query: { limit: 900, journal_cat_id: 4 } }).search.get('limit'), '500');                                    // broker clamp
  assert.equal(validateGet({ path: '/api2/journals/42.json' }).kind, 'one');
  assert.equal(validateGet({ path: '/api2/journal_cats/7.json' }).kind, 'one');
  assert.equal(validateGet({ path: '/api2/incomes.json', query: { date_from: '2026-01-01' } }).kind, 'list');
  // routes nobody documented stay refused
  for (const path of ['/api2/journal_entries.json', '/api2/deposits.json', '/api2/advances.json', '/api2/expense_categories.json', '/api2/bank_accounts.json', '/api2/client_statements.json', '/api2/journals/1/lines.json'])
    assert.throws(() => validateGet({ path }), BadRead, path);
  for (const q of [{ unknown: 1 }, { date_from: '2026-02-30' }, { journal_account_id: 'x' }]) assert.throws(() => validateGet({ path: '/api2/journals.json', query: q }), BadRead);
  for (const e of ['journals', 'journal_accounts', 'journal_cats', 'incomes']) assert.ok(!ENTITIES[e].params.some((p) => /^(method|body|apikey)$/i.test(p)));
});

test('journals list/--all/get work end to end, page size is capped at the documented 100, GET only', async () => {
  const calls = [];
  const rows = Array.from({ length: 130 }, (_, i) => ({ id: i + 1, number: String(i + 1), date: '2026-01-05' }));
  const fetcher = async (url, o) => {
    calls.push({ method: o.method, path: url.pathname, limit: url.searchParams.get('limit'), page: url.searchParams.get('page') });
    if (url.pathname === '/api2/journals/5.json') return json({ code: 200, data: { Journal: rows[4] } });
    const limit = Number(url.searchParams.get('limit')); const p = Number(url.searchParams.get('page'));
    return json(page('Journal', rows.slice((p - 1) * limit, p * limit), { p, count: Math.ceil(rows.length / limit), total: rows.length }));
  };
  const all = await run(['list', 'journals', '--all', '--page-size', '500'], { env, fetcher, sleep: noSleep });
  assert.equal(all.complete, true); assert.equal(all.count, 130); assert.equal(all.pages, 2);
  assert.deepEqual(calls.map((c) => c.limit), ['100', '100']);
  const one = await run(['get', 'journals', '5'], { env, fetcher, sleep: noSleep });
  assert.equal(one.record.number, '5'); assert.equal(one.source, 'single');
  assert.ok(calls.every((c) => c.method === 'GET'));
  const cap = await run(['capabilities'], { env });
  for (const e of ['journals', 'journal_accounts', 'journal_cats', 'incomes']) assert.ok(cap.read.includes(e), e);
  assert.ok(cap.not_available_in_daftra_api.expense_categories);
  assert.ok(!cap.writes.some((w) => /journal/.test(w)));
});

test('items that have no documented endpoint are reported as unavailable with the documented substitute, never fetched', async () => {
  for (const k of ['expense_categories', 'bank_accounts', 'client_statement_official', 'journal_entries', 'advances', 'deposits']) assert.ok(UNSUPPORTED_READS[k], k);
  assert.match(UNSUPPORTED_READS.bank_accounts, /treasuries/);
  assert.match(UNSUPPORTED_READS.expense_categories, /expenses_summary/);
  assert.match(UNSUPPORTED_READS.advances, /type=19/);
  let touched = false;
  await assert.rejects(run(['list', 'expense_categories'], { env, fetcher: async () => { touched = true; return json({}); } }), /not authorized/);
  assert.equal(touched, false);
});

// ---------------------------------------------------------------------------------------------------------------- 2. report parameter contract
test('expenses_summary / expenses_details: group_by is required, matched case-insensitively and sent in the documented case', async () => {
  const seen = [];
  const fetcher = async (url) => { seen.push(url.search); return json({ report: 'x', rows: [] }); };
  await getReport('expenses_summary', { group_by: 'category', from_date: '2026-01-01', to_date: '2026-01-31' }, env, fetcher);
  await getReport('expenses_summary', { group_by: 'MONTHLY', date_from: '2026-01-01', date_to: '2026-01-31' }, env, fetcher);     // wrong date spelling is mapped
  await getReport('expenses_details', { group_by: 'vendor', currency: 'All', branch_id: 'all' }, env, fetcher);
  assert.equal(seen[0], '?group_by=Category&from_date=2026-01-01&to_date=2026-01-31');
  assert.equal(seen[1], '?group_by=Monthly&from_date=2026-01-01&to_date=2026-01-31');
  assert.equal(seen[2], '?group_by=Vendor&currency=All&branch_id=all');
  await assert.rejects(getReport('expenses_summary', { from_date: '2026-01-01' }, env, fetcher), /required: group_by/);
  await assert.rejects(getReport('expenses_summary', { group_by: 'Month' }, env, fetcher), /group_by must be one of Yearly, Monthly/);
  await assert.rejects(getReport('expenses_summary', { group_by: 'Category', from_date: '2026-02-01', to_date: '2026-01-01' }, env, fetcher), /to_date must not be earlier/);
  assert.equal(seen.length, 3);
});

test('revenue: report_type is required and group_by must fit it (documented table); payments/products enumerations are canonicalised', async () => {
  const seen = [];
  const fetcher = async (url) => { seen.push(url.search); return json({ rows: [] }); };
  await getReport('revenue', { report_type: 'Period', group_by: 'Monthly', date_from: '2026-01-01', date_to: '2026-01-31', currency: '-1' }, env, fetcher);
  await getReport('revenue', { report_type: 'client' }, env, fetcher);
  await getReport('payments', { group_by: 'Payment_Method', is_summary: 1, collected_by: 3 }, env, fetcher);
  assert.equal(seen[0], '?report_type=period&group_by=monthly&date_from=2026-01-01&date_to=2026-01-31&currency=-1');
  assert.equal(seen[1], '?report_type=client');
  assert.equal(seen[2], '?group_by=payment_method&is_summary=1&collected_by=3');
  await assert.rejects(getReport('revenue', { group_by: 'monthly' }, env, fetcher), /required: report_type/);
  await assert.rejects(getReport('revenue', { report_type: 'daily' }, env, fetcher), /report_type must be one of client, invoice, period, staff, sales_person/);
  await assert.rejects(getReport('revenue', { report_type: 'client', group_by: 'monthly' }, env, fetcher), /not valid with report_type=client \(omit group_by/);
  await assert.rejects(getReport('revenue', { report_type: 'period', group_by: 'client' }, env, fetcher), /accepted: daily, weekly, monthly, yearly, lastyear, lastmonth/);
  await assert.rejects(getReport('products', { brand: 'x' }, env, fetcher), /use brand_id/);
  assert.equal(seen.length, 3);
});

test('documented special values are accepted: branch all/-1, cost centre -1, accounts_branch -1; undocumented ones are not', () => {
  assert.equal(buildReportQuery('income_statement', { cost_center_id: '-1', journals_branch_id: 'all', accounts_branch: '-1' }).toString(), 'cost_center_id=-1&journals_branch_id=all&accounts_branch=-1');
  assert.equal(buildReportQuery('cash_flow', { branch_id: '-1' }).get('branch_id'), '-1');
  assert.equal(buildReportQuery('trial_balance', { journal_account_id: '12', level: '2', accounts_display: 'HIDE_ZERO_BALANCES' }).toString(), 'journal_account_id=12&level=2&accounts_display=hide_zero_balances');
  for (const [name, q] of [['cash_flow', { branch_id: '1;2' }], ['income_statement', { cost_center_id: 'all' }], ['income_statement', { accounts_branch: 'all' }], ['cash_flow', { branch_id: '-2' }]])
    assert.throws(() => buildReportQuery(name, q), /unsupported value/);
  // generic entity filters are NOT loosened
  assert.throws(() => validateGet({ path: '/api2/invoices.json', query: { client_id: '-1' } }), BadRead);
  assert.throws(() => validateGet({ path: '/api2/expenses.json', query: { journal_account_id: 'all' } }), BadRead);
});

test('ledger needs a date; selector shortcuts cannot be combined with explicit dates; the same rules apply on the broker', () => {
  assert.throws(() => normalizeReportParams('ledger', {}), /at least one of date_from \/ date_to/);
  assert.equal(normalizeReportParams('ledger', { to_date: '2026-03-31' }).date_to, '2026-03-31');
  assert.throws(() => normalizeReportParams('income_statement', { date_selector: 'lastmonth', date_from: '2026-01-01' }), /cannot be combined/);
  assert.throws(() => normalizeReportParams('financial_transactions', { date_range_selector: 'lastyear', date_range_to: '2026-01-01' }), /cannot be combined/);
  assert.throws(() => normalizeReportParams('balance_sheet', { date_from: '2026-02-01', date_to: '2026-01-01' }), /must not be earlier/);
  assert.throws(() => normalizeReportParams('journals', { date_from: '2026-01-01', from_date: '2026-01-01' }), /either/);
  assert.equal(validateGet({ path: '/api2/reports/ledger', query: { date_from: '2026-01-01', journal_account_id: 5 } }).search.toString(), 'date_from=2026-01-01&journal_account_id=5');
  assert.equal(validateGet({ path: '/api2/reports/journals', query: { date_from: '2026-01-01', date_to: '2026-01-31', group_by: 'branch' } }).search.toString(), 'group_by=Branch&from_date=2026-01-01&to_date=2026-01-31');
  assert.throws(() => validateGet({ path: '/api2/reports/ledger', query: {} }), BadRead);
  assert.throws(() => validateGet({ path: '/api2/reports/revenue', query: { report_type: 'client', group_by: 'daily' } }), BadRead);
  assert.throws(() => validateGet({ path: '/api2/reports/revenue', query: { report_type: 'nope' } }), BadRead);
  // every registered report still builds a query from an empty/minimal parameter set unless its documented requirement says otherwise
  for (const [name, spec] of Object.entries(REPORTS)) {
    if (spec.required.length || name === 'ledger') continue;
    assert.doesNotThrow(() => buildReportQuery(name, {}), name);
  }
});

// ---------------------------------------------------------------------------------------------------------------- 3. failure classification
test('classifyFailure follows the documented meaning of each status (404 on a report is NOT a permission problem)', () => {
  assert.equal(classifyFailure(404, { isReport: true }).category, 'report_not_exposed');
  assert.match(classifyFailure(404, { isReport: true }).owner_action, /Nothing to change in the key/);
  assert.equal(classifyFailure(404).category, 'not_found');
  assert.equal(classifyFailure(403, { isReport: true }).category, 'forbidden');
  assert.match(classifyFailure(403, { isReport: true }).owner_action, /machine\/API-key access/);
  assert.match(classifyFailure(403).owner_action, /Roles/);
  assert.equal(classifyFailure(400, { isReport: true }).category, 'validation');
  assert.equal(classifyFailure(401).category, 'unauthorized');
  assert.equal(classifyFailure(404, { message: 'Invalid page' }).category, 'invalid_page');
  assert.equal(classifyFailure(400, { message: 'Invalid page' }).category, 'invalid_page');
  assert.equal(classifyFailure(500).category, 'upstream_error');
  for (const s of [429, 502, 503, 504]) assert.equal(classifyFailure(s).retryable, true, String(s));
  assert.equal(classifyFailure(403).owner_action === null, false);
  assert.equal(classifyFailure(404).owner_action, null);
  assert.equal(summariseValidationErrors({ group_by: ['is required'], rows: 'too many' }), 'group_by=is required; rows=too many');
  assert.equal(summariseValidationErrors({ 'a<b>': '<script>' }).includes('<'), false);
});

test('readers surface the category, hint, owner action and Daftra validation_errors', async () => {
  const reply = (status, body) => async () => json(body, status);
  const fail = (f, name = 'ledger', params = { date_from: '2026-01-01' }) => getReport(name, params, env, f, { sleep: noSleep });
  await assert.rejects(fail(reply(404, { message: 'Not Found' })), (e) => e instanceof DaftraError && e.status === 404 && e.category === 'report_not_exposed' && e.owner_action && /not exposed/.test(e.hint));
  await assert.rejects(fail(reply(403, { message: 'Forbidden' })), (e) => e.category === 'forbidden' && /permission/.test(e.owner_action));
  await assert.rejects(fail(reply(400, { message: 'Validation failed', validation_errors: { rows: 'more than 7000 rows' } })),
    (e) => e.category === 'validation' && /validation_errors: rows=more than 7000 rows/.test(e.message) && e.validationErrors === 'rows=more than 7000 rows');
  // 401 arrives with content-type text/html around a JSON body
  await assert.rejects(fail(async () => new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401, headers: { 'content-type': 'text/html' } })), (e) => e.category === 'unauthorized');
  // entity list: 404 is a missing route/record, 403 a role/permission problem
  await assert.rejects(listRecords('journals', env, reply(403, { message: 'Forbidden' }), {}), (e) => e.category === 'forbidden' && /Roles/.test(e.owner_action));
  await assert.rejects(listRecords('journals', env, reply(404, {}), {}), (e) => e.category === 'not_found' && e.owner_action === undefined || e.owner_action === null);
  // transient: retried, then classified
  let n = 0;
  await assert.rejects(fail(async () => { n++; return json({}, 503, { 'retry-after': '0' }); }), (e) => e.category === 'transient' && e.retryable === true);
  assert.equal(n, 4);
});

// ---------------------------------------------------------------------------------------------------------------- 4. Invalid page
test('Invalid page on the first page: the bare request is retried once and completeness is still proven from the metadata', async () => {
  const calls = [];
  const cats = [{ id: 12, name: 'Fuel', parent_id: 0 }, { id: 13, name: 'Oil', parent_id: 0 }];
  const fetcher = async (url) => {
    calls.push(url.search);
    if (url.searchParams.has('limit') || url.searchParams.has('page')) return json({ message: 'Invalid page' }, 404);
    return json(page('ProductCategory', cats));
  };
  const all = await fetchAllRecords('product_categories', {}, env, fetcher);
  assert.equal(all.complete, true); assert.equal(all.count, 2);
  assert.deepEqual(calls, ['?limit=100&page=1', '']);
  // without a working bare request the failure stays an honest, classified invalid_page (not "forbidden")
  await assert.rejects(fetchAllRecords('product_categories', {}, env, async () => json({ message: 'Invalid page' }, 404)), (e) => e instanceof DaftraError && e.category === 'invalid_page');
  // a genuine multi-page collection after the fallback keeps the server's page size (no limit sent) and still proves completeness
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: 'c' + i, parent_id: 0 }));
  const seen = [];
  const paged = async (url) => {
    seen.push(url.search);
    if (url.searchParams.has('limit')) return json({ message: 'Invalid page' }, 404);
    const p = Number(url.searchParams.get('page') || 1);
    return json(page('ProductCategory', rows.slice((p - 1) * 20, p * 20), { p, count: 2, total: 25 }));
  };
  const big = await fetchAllRecords('product_categories', {}, env, paged);
  assert.equal(big.count, 25); assert.equal(big.pages, 2);
  assert.deepEqual(seen, ['?limit=100&page=1', '', '?page=2']);
});

test('an empty collection that reports page 0 is a complete empty list, not a malformed page', async () => {
  assert.doesNotThrow(() => parsePagination({ pagination: { page: 0, page_count: 0, total_results: 0, next: null } }, 0));
  assert.throws(() => parsePagination({ pagination: { page: 0, page_count: 1, total_results: 2 } }, 2), /Invalid page/);
  const empty = async () => json({ code: 200, data: [], pagination: { prev: null, next: null, page: 0, page_count: 0, total_results: 0 } });
  const all = await fetchAllRecords('product_categories', {}, env, empty);
  assert.equal(all.complete, true); assert.equal(all.count, 0);
});

// ---------------------------------------------------------------------------------------------------------------- 5. single-record fallback
test('treasury single GET failing with 502/500 falls back to the complete list and says so; other entities are not masked', async () => {
  const treasuries = [{ id: 3, name: 'Main', type: 3, balance: '10.00' }, { id: 4, name: 'Bank', type: 1, balance: '5.00' }];
  const calls = [];
  const fetcher = (status) => async (url) => {
    calls.push(url.pathname);
    if (url.pathname === '/api2/treasuries/4.json') return json({ message: 'x' }, status);
    if (url.pathname === '/api2/treasuries.json') return json(page('Treasury', treasuries));
    return json({}, 404);
  };
  for (const status of [502, 500]) {
    calls.length = 0;
    const got = await getOneDetailed('treasuries', 4, env, fetcher(status), { sleep: noSleep });
    assert.equal(got.source, 'list_fallback'); assert.equal(got.record.name, 'Bank'); assert.match(got.note, /complete treasuries list \(2 rows\)/);
    assert.ok(calls.includes('/api2/treasuries.json'));
  }
  const cli = await run(['get', 'treasuries', '4'], { env, fetcher: fetcher(502), sleep: noSleep });
  assert.equal(cli.source, 'list_fallback'); assert.equal(cli.record.type, 1);
  // an id that is not in the complete list is a 404, never invented
  await assert.rejects(getOneDetailed('treasuries', 99, env, async (u) => (u.pathname === '/api2/treasuries.json' ? json(page('Treasury', treasuries)) : json({}, 502)), { sleep: noSleep }),
    (e) => e.status === 404 && e.category === 'not_found');
  // the list failing too reports the ORIGINAL failure
  await assert.rejects(getOneDetailed('treasuries', 4, env, async () => json({}, 503), { sleep: noSleep }), (e) => e.category === 'transient');
  // no fallback for entities where a list scan is not equivalent, and none for a plain 404 / 403
  await assert.rejects(getOneDetailed('invoices', 3, env, async () => json({}, 502), { sleep: noSleep }), (e) => e.status === 502);
  let listed = false;
  await assert.rejects(getOneDetailed('treasuries', 4, env, async (u) => { if (u.pathname.endsWith('treasuries.json')) listed = true; return json({ message: 'Forbidden' }, 403); }, { sleep: noSleep }), (e) => e.category === 'forbidden');
  assert.equal(listed, false);
});

// ---------------------------------------------------------------------------------------------------------------- 6. broker path
test('broker read proxy forwards Daftra validation_errors and the real upstream status (a Daftra 500 is not shown as a gateway blip)', async () => {
  const mk = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const v = validateGet({ path: '/api2/reports/expenses_summary', query: { group_by: 'Category' } });
  const r400 = await performGet(v, { env, fetcher: mk(400, { message: 'Validation failed', validation_errors: { rows: ['more than 3000 groups'] } }) });
  assert.equal(r400.status, 400); assert.equal(r400.validation_errors, 'rows=more than 3000 groups');
  const r500 = await performGet(v, { env, fetcher: mk(500, { message: 'secret stack trace' }) });
  assert.equal(r500.status, 502); assert.equal(r500.upstream_status, 500); assert.equal(r500.message, 'Upstream error');
  const r503 = await performGet(v, { env, fetcher: mk(503, {}) });
  assert.equal(r503.upstream_status, 503);
  const r404 = await performGet(v, { env, fetcher: mk(404, { message: 'Not Found' }) });
  assert.equal(r404.status, 404); assert.equal(r404.validation_errors, undefined);

  // agent side: the shim turns the broker reply back into a Response the reader classifies
  const url = 'http://broker.railway.internal:8080';
  const token = 'x'.repeat(40);
  const shim = (result) => createBrokerFetcher({ url, token, env, fetcher: async () => new Response(JSON.stringify({ ok: true, result }), { status: 200 }) });
  await assert.rejects(getReport('expenses_summary', { group_by: 'Category' }, env, shim({ status: 400, message: 'Validation failed', validation_errors: 'rows=too many' }), { sleep: noSleep }),
    (e) => e.category === 'validation' && /rows=too many/.test(e.message));
  await assert.rejects(getReport('expenses_summary', { group_by: 'Category' }, env, shim({ status: 502, message: 'Upstream error', upstream_status: 500 }), { sleep: noSleep }),
    (e) => e.status === 500 && e.category === 'upstream_error');
  await assert.rejects(getReport('expenses_summary', { group_by: 'Category' }, env, shim({ status: 404, message: 'Not Found' }), { sleep: noSleep }),
    (e) => e.category === 'report_not_exposed');
});

// ---------------------------------------------------------------------------------------------------------------- 7. access matrix
test('access-report classifies every allowlisted endpoint with one GET each and changes nothing', async () => {
  const calls = [];
  const fetcher = async (url, o) => {
    calls.push({ method: o.method, path: url.pathname, search: url.search });
    const p = url.pathname;
    if (p === '/api2/journals.json') return json({ message: 'Forbidden' }, 403);
    if (p === '/api2/reports/trial_balance') return json({ message: 'Forbidden' }, 403);
    if (p === '/api2/reports/revenue') return json({ message: 'Not Found' }, 404);
    if (p === '/api2/reports/expenses_summary') return json({ message: 'Validation failed', validation_errors: { group_by: 'unavailable' } }, 400);
    if (p === '/api2/reports/payments') return json({}, 503);
    if (p === '/api2/treasuries.json') return json(page('Treasury', [{ id: 1, name: 'Main' }]));
    if (p === '/api2/taxes.json') return json({ code: 200, data: [] });
    if (p.startsWith('/api2/reports/')) return json({ rows: [], pagination: { page: 1, total_pages: 1, total_rows: 0 } });
    return json(page('X', []));
  };
  const rep = await accessReport(env, fetcher, { sleep: noSleep, day: '2026-01-15' });
  assert.equal(rep.read_only, true);
  assert.equal(rep.total, Object.keys(ENTITIES).length + Object.keys(REPORTS).length);
  assert.equal(calls.length, rep.total + 3);                               // one request per endpoint; only the 503 (payments) is retried, 3 more GETs
  const cat = (k, n) => rep.results.find((r) => r.kind === k && r.name === n);
  assert.equal(cat('entity', 'journals').category, 'forbidden');
  assert.equal(cat('report', 'trial_balance').category, 'forbidden');
  assert.equal(cat('report', 'revenue').category, 'report_not_exposed');
  assert.equal(cat('report', 'expenses_summary').category, 'validation');
  assert.match(cat('report', 'expenses_summary').validation_errors, /group_by=unavailable/);
  assert.equal(cat('entity', 'treasuries').category, 'ok');
  assert.ok(rep.owner_actions.length >= 1);
  assert.ok(calls.every((c) => c.method === 'GET'));
  assert.ok(calls.some((c) => c.path === '/api2/reports/ledger' && c.search === '?date_from=2026-01-15&date_to=2026-01-15'));
  assert.ok(calls.some((c) => c.path === '/api2/reports/expenses_summary' && /from_date=2026-01-15&to_date=2026-01-15&group_by=Category/.test(c.search)));
  assert.ok(calls.some((c) => c.path === '/api2/reports/revenue' && /report_type=invoice/.test(c.search)));
  assert.ok(calls.some((c) => c.path === '/api2/reports/financial_transactions' && /page=1/.test(c.search)));
  assert.ok(calls.some((c) => c.path === '/api2/journals.json' && c.search === '?limit=1'));
  assert.ok(rep.not_supported_by_daftra_api.expense_categories);
});

test('access-report through the CLI can be narrowed to one endpoint and never writes', async () => {
  const calls = [];
  const fetcher = async (url, o) => { calls.push(o.method + ' ' + url.pathname); return json({ message: 'Not Found' }, 404); };
  const r = await run(['access-report', 'report:revenue'], { env, fetcher, sleep: noSleep });
  assert.equal(r.total, 1); assert.deepEqual(calls, ['GET /api2/reports/revenue']);
  assert.equal(r.results[0].category, 'report_not_exposed');
  const e = await run(['access-report', 'entity'], { env, fetcher: async () => json({ message: 'Forbidden' }, 403), sleep: noSleep });
  assert.equal(e.total, Object.keys(ENTITIES).length); assert.deepEqual(Object.keys(e.summary), ['forbidden']);
});
