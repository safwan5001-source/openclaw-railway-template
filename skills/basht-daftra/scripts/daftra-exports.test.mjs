import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { toCsv, toJson, exportData } from './daftra-exports.mjs';

test('CSV has UTF8 BOM, fixed headers, and quoted values', () => {
  const csv = toCsv([{ id: '0012', client: 'عميل, "تجربة"', amount: 12.5 }], ['id', 'client', 'amount']);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"0012"'));
  assert.ok(csv.includes('"عميل, ""تجربة"""'));
});
test('CSV spreadsheet formula strings are inert', () => {
  const csv = toCsv([{ v: '=HYPERLINK("https://x")' }, { v: '+SUM(1,2)' }, { v: '-10+20' }, { v: '@SUM(1)' }, { v: '\t=1' }], ['v']);
  for (const input of ['=HYPERLINK', '+SUM', '-10+20', '@SUM', '\t=1']) {
    assert.ok(csv.includes("'" + input));
  }
});
test('JSON preserves record values and metadata', () => {
  const value = JSON.parse(toJson([{ id: '001', amount: 15 }], { source: 'Daftra' }));
  assert.equal(value.record_count, 1);
  assert.equal(value.records[0].id, '001');
  assert.equal(value.metadata.source, 'Daftra');
});
test('export engine refuses unsupported formats, excessive records and invalid paths', async () => {
  assert.throws(() => toCsv(Array(10001).fill({}), ['id']));
  assert.throws(() => toCsv([{}], ['../../secret']));
  await assert.rejects(exportData('xlsx', [], [], {}, '/tmp/demo.xlsx'), /Invalid columns/);
  await assert.rejects(exportData('odt', [], ['id'], {}, '/tmp/demo.odt'), /Unsupported/);
  await assert.rejects(exportData('xlsx', [], ['id'], {}, '/tmp/demo.csv'), /Invalid output/);
  await assert.rejects(exportData('csv', [], ['id'], {}, '/tmp/demo.pdf'));
});

test('genuine negative amounts are not corrupted but formulas stay inert', () => {
  const csv = toCsv([{ a: '-120.50', b: '-1+2', c: '12', d: '-1e5' }], ['a', 'b', 'c', 'd']);
  assert.ok(csv.includes('"-120.50"') && !csv.includes("'-120.50"));
  assert.ok(csv.includes("\"'-1+2\"") && csv.includes("\"'-1e5\""));
});

test('row limit can be raised for csv/json up to 50000 but not beyond', () => {
  assert.doesNotThrow(() => toCsv(Array(10001).fill({}), ['id'], { maxRows: 50000 }));
  assert.throws(() => toCsv([], ['id'], { maxRows: 50001 }), /Invalid row limit/);
});

test('exportData writes every format, never overwrites, forces official=false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'basht-exports-'));
  try {
    const records = [{ id: '0012', total: '-5.25', note: 'مرحبا "x"' }];
    const columns = ['id', 'total', 'note'];
    const runner = async (_bin, args) => writeFile(args.find((a) => a.startsWith('--print-to-pdf=')).slice(15), '%PDF-1.4\n%%EOF\n');
    for (const format of ['csv', 'json', 'xlsx', 'docx', 'pdf']) {
      const out = join(dir, 'x.' + format);
      const r = await exportData(format, records, columns, { official: true, entity: 'invoices' }, out, { runner });
      assert.equal(r.record_count, 1);
      assert.equal((await readFile(out)).length, r.bytes);
      await assert.rejects(exportData(format, records, columns, {}, out, { runner }), /EEXIST/);
    }
    assert.equal(JSON.parse(await readFile(join(dir, 'x.json'), 'utf8')).metadata.official, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CSV round-trips through Python csv with Arabic, quotes and newlines', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'basht-csv-'));
  try {
    const records = [{ id: '0012', client: 'عميل, "تجربة"', note: 'سطر1\nسطر2', total: '-10.5' }];
    const out = join(dir, 'r.csv');
    await exportData('csv', records, ['id', 'client', 'note', 'total'], {}, out);
    let stdout;
    try {
      stdout = execFileSync('python3', ['-I', '-c', 'import csv,json,sys\nr=list(csv.reader(open(sys.argv[1],encoding="utf-8-sig",newline="")))\nprint(json.dumps(r,ensure_ascii=False))', out], { encoding: 'utf8' });
    } catch { return t.skip('python3 unavailable'); }
    assert.deepEqual(JSON.parse(stdout), [['id', 'client', 'note', 'total'], ['0012', 'عميل, "تجربة"', 'سطر1\nسطر2', '-10.5']]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
