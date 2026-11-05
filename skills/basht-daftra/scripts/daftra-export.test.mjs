import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportDaftraPage, exportDaftraRecords, exportReport, flattenReport, resolveColumns } from './daftra-export.mjs';

const noSleep = async () => {};
async function sandbox(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'basht-daftra-'));
  try {
    await mkdir(join(dir, 'exports'));
    const env = { OPENCLAW_WORKSPACE_DIR: dir, DAFTRA_BASE_URL: 'https://nepras.daftra.com', DAFTRA_API_KEY: 'test' };
    await fn(dir, env);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
function pagedFetcher(n, extraFields = {}) {
  const calls = [];
  const fetcher = async (url) => {
    const page = Number(url.searchParams.get('page') || 1);
    const limit = Number(url.searchParams.get('limit') || 20);
    calls.push(url.pathname + url.search);
    const pageCount = Math.ceil(n / limit);
    const ids = Array.from({ length: n }, (_, i) => i + 1).slice((page - 1) * limit, page * limit);
    return new Response(JSON.stringify({
      data: ids.map((id) => ({ Invoice: { id: String(id).padStart(4, '0'), total: '10.50', private_note: 'not-for-export', ...extraFields } })),
      pagination: { prev: null, next: page < pageCount ? '/api2/invoices.json?page=' + (page + 1) : null, page, page_count: pageCount, total_results: n },
    }), { status: 200 });
  };
  return { fetcher, calls };
}

test('exports only complete tenant collections and approved fields (official pagination shape)', async () => {
  await sandbox(async (dir, env) => {
    const fetcher = async () => new Response(JSON.stringify({
      data: [{ Invoice: { id: '0001', total: '10', private_note: 'not-for-export' } }],
      pagination: { page: 1, page_count: 1, total_results: 1, next: null },
    }), { status: 200 });
    const result = await exportDaftraPage('invoices', ['id', 'total'], 'csv', join(dir, 'exports', 'invoices.csv'), env, fetcher);
    const body = await readFile(result.path, 'utf8');
    assert.ok(body.includes('0001'));
    assert.ok(!body.includes('not-for-export'));
    assert.equal(result.record_count, 1);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
  });
});

test('multi-page export retrieves every page, in every format that needs no browser', async () => {
  await sandbox(async (dir, env) => {
    for (const format of ['csv', 'json', 'xlsx', 'docx']) {
      const { fetcher, calls } = pagedFetcher(230);
      const r = await exportDaftraRecords({ entity: 'invoices', columns: ['id', 'total'], format, output: join(dir, 'exports', 'all.' + format), query: { date_from: '2025-01-01' }, pageSize: 100 }, env, fetcher, { sleep: noSleep });
      assert.equal(r.record_count, 230, format);
      assert.equal(calls.length, 3);
      assert.ok(calls.every((c) => c.includes('date_from=2025-01-01')));
      assert.ok(r.bytes > 100);
    }
    const json = JSON.parse(await readFile(join(dir, 'exports', 'all.json'), 'utf8'));
    assert.equal(json.records.length, 230);
    assert.equal(json.metadata.total_results, 230);
    assert.equal(json.metadata.pages, 3);
    assert.equal(json.metadata.complete, true);
    assert.equal(json.metadata.official, false);
    assert.deepEqual(json.metadata.filters, { date_from: '2025-01-01' });
  });
});

test('refuses to export when completeness cannot be proven, and writes nothing', async () => {
  await sandbox(async (dir, env) => {
    const incomplete = async () => new Response(JSON.stringify({ data: [{ Invoice: { id: '1' } }] }), { status: 200 });
    const out = join(dir, 'exports', 'a.csv');
    await assert.rejects(exportDaftraRecords({ entity: 'invoices', columns: ['id'], format: 'csv', output: out }, env, incomplete, { sleep: noSleep }), /completeness cannot be proven/);
    await assert.rejects(readFile(out));
  });
});

test('rejects unsafe destinations before any API call, incl. symlink escape', async () => {
  await sandbox(async (dir, env) => {
    let calls = 0;
    const fetcher = async () => { calls++; return new Response('{}', { status: 200 }); };
    const run = (output, format = 'json') => exportDaftraRecords({ entity: 'invoices', columns: ['id'], format, output }, env, fetcher);
    await assert.rejects(run(join(dir, 'outside.json')), /private exports/);
    await assert.rejects(run(join(dir, 'exports', '..', 'x.json')), /private exports/);
    await assert.rejects(run(join(dir, 'exports', 'a.csv')), /must end with \.json/);
    const outside = await mkdtemp(join(tmpdir(), 'basht-outside-'));
    try {
      await symlink(outside, join(dir, 'exports', 'link'));
      await assert.rejects(run(join(dir, 'exports', 'link', 'x.json')), /symlink/);
    } finally { await rm(outside, { recursive: true, force: true }); }
    await assert.rejects(exportDaftraRecords({ entity: '../admin', columns: ['id'], format: 'csv', output: join(dir, 'exports', 'a.csv') }, env, fetcher), /Unsupported entity/);
    assert.equal(calls, 0);
  });
});

test('never overwrites an existing export', async () => {
  await sandbox(async (dir, env) => {
    const out = join(dir, 'exports', 'same.json');
    await writeFile(out, 'precious');
    const { fetcher } = pagedFetcher(1);
    await assert.rejects(exportDaftraRecords({ entity: 'invoices', columns: ['id'], format: 'json', output: out }, env, fetcher), /EEXIST/);
    assert.equal(await readFile(out, 'utf8'), 'precious');
  });
});

test('sensitive columns: excluded by default, refused when requested, redacted from whole-record JSON', async () => {
  await sandbox(async (dir, env) => {
    const sensitive = { password: 's3cret', invoice_pdf_url: 'https://nepras.daftra.com/invoices/view/1.pdf?hash=abc', invoice_html_url: 'https://x/?hash=abc', client_id: '7' };
    const { fetcher } = pagedFetcher(2, sensitive);
    // (a) default columns exclude sensitive keys
    const out = join(dir, 'exports', 'default.csv');
    await exportDaftraRecords({ entity: 'invoices', format: 'csv', output: out }, env, fetcher);
    const csv = await readFile(out, 'utf8');
    assert.ok(csv.includes('"client_id"') && csv.includes('"total"'));
    assert.ok(!/password|pdf_url|html_url|s3cret|hash=/.test(csv));
    // (b) explicit request is refused (before any API call)
    for (const col of ['password', 'invoice_pdf_url', 'api_key', 'access_token']) {
      let called = false;
      await assert.rejects(exportDaftraRecords({ entity: 'invoices', columns: ['id', col], format: 'csv', output: join(dir, 'exports', 'bad.csv') }, env, async () => { called = true; return fetcher(); }),
        /Column is sensitive and cannot be exported/);
      assert.equal(called, false);
    }
    // (c) whole-record JSON passes through redaction
    const wide = { Invoice: { id: '1', total: '5', password: 'x', nested: { token: 'y', ok: 1, invoice_pdf_url: 'https://z' } } };
    const wideFetcher = async () => new Response(JSON.stringify({ data: [wide], pagination: { page: 1, page_count: 1, total_results: 1, next: null } }), { status: 200 });
    const r = await exportDaftraRecords({ entity: 'invoices', columns: ['id', 'total', 'nested'], format: 'json', output: join(dir, 'exports', 'wide.json') }, env, wideFetcher);
    const json = await readFile(r.path, 'utf8');
    assert.deepEqual(JSON.parse(json).records[0].nested, { ok: 1 });
    assert.ok(!/token|password|https:\/\/z/.test(json));
  });
});

test('resolveColumns validates allowlists and defaults to scalar keys only', () => {
  assert.deepEqual(resolveColumns([{ id: 1, name: 'x', obj: { a: 1 }, 'bad-key': 1, secret_hash: 'h' }]), ['id', 'name']);
  assert.throws(() => resolveColumns([{ id: 1 }], ['id; drop']), /Invalid columns/);
  assert.throws(() => resolveColumns([], undefined), /columns are required/);
  assert.throws(() => resolveColumns([{ id: 1 }], ['password']), /sensitive/);
});

test('pdf export goes through the generated-report renderer with official=false', async () => {
  await sandbox(async (dir, env) => {
    const { fetcher } = pagedFetcher(3);
    let args;
    const runner = async (bin, a) => {
      args = a;
      await writeFile(a.find((x) => x.startsWith('--print-to-pdf=')).slice(15), '%PDF-1.4\nfake\n%%EOF\n');
    };
    const r = await exportDaftraRecords({ entity: 'invoices', columns: ['id'], format: 'pdf', output: join(dir, 'exports', 'r.pdf') }, env, fetcher, { runner });
    assert.equal(r.format, 'pdf');
    assert.ok(args.includes('--no-sandbox') && args.includes('--disable-remote-fonts'));
    assert.ok((await readFile(r.path)).toString().startsWith('%PDF-'));
  });
});

test('flattenReport keeps group context and refuses to invent rows for unknown shapes', () => {
  const t = flattenReport({ data: { report: 'x', filters: { date_from: '2025-01-01' }, currencies: [
    { currency: 'SAR', groups: [{ label: 'Jan', totals: { net: '10', tax: '1.5' } }, { label: 'Feb', totals: { net: '20', tax: '3' } }] },
    { currency: 'USD', groups: [{ label: 'Jan', totals: { net: '5', tax: '0' } }] },
  ] } });
  assert.equal(t.rows.length, 3);
  assert.deepEqual(t.rows[0], { report: 'x', currency: 'SAR', label: 'Jan', totals_net: '10', totals_tax: '1.5' });
  assert.equal(t.rows[2].currency, 'USD');
  assert.equal(flattenReport({ data: { total: 5 } }), null);
  assert.equal(flattenReport({ data: { list: ['a', 'b'] } }), null);
  assert.ok(!flattenReport({ data: [{ a: 1, secret_token: 'x', url: 1 }] }).columns.includes('secret_token'));
});

test('exportReport uses GET /api2/reports/<name>, exports tabular reports, json fallback for others', async () => {
  await sandbox(async (dir, env) => {
    const seen = [];
    const fetcher = async (url, o) => {
      seen.push(o.method + ' ' + url.pathname + url.search);
      return new Response(JSON.stringify({ code: 200, data: { currencies: [{ currency: 'SAR', rows: [{ id: '1', amount: '10.00' }, { id: '2', amount: '-3.50' }] }] } }), { status: 200 });
    };
    const r = await exportReport('revenue', { report_type: 'invoice', date_from: '2025-01-01' }, 'csv', join(dir, 'exports', 'rev.csv'), env, fetcher);
    assert.deepEqual(seen, ['GET /api2/reports/revenue?report_type=invoice&date_from=2025-01-01']);
    assert.equal(r.record_count, 2);
    const csv = await readFile(r.path, 'utf8');
    assert.ok(csv.includes('"currency"') && csv.includes('"-3.50"') && !csv.includes("'-3.50"));
    const odd = async () => new Response(JSON.stringify({ code: 200, data: { total: 5, password: 'p' } }), { status: 200 });
    await assert.rejects(exportReport('revenue', { report_type: 'client' }, 'xlsx', join(dir, 'exports', 'odd.xlsx'), env, odd), /not tabular; export it as json/);
    const j = await exportReport('revenue', { report_type: 'client' }, 'json', join(dir, 'exports', 'odd.json'), env, odd);
    const body = await readFile(j.path, 'utf8');
    assert.ok(body.includes('"total": 5') && !body.includes('password'));
    await assert.rejects(exportReport('revenue', {}, 'json', join(dir, 'exports', 'x.json'), env, odd), /required: report_type/);
  });
});
