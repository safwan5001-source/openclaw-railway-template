import test from 'node:test';
import assert from 'node:assert/strict';
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
  await assert.rejects(exportData('xlsx', [], [], {}, '/tmp/demo.xlsx'));
  await assert.rejects(exportData('csv', [], ['id'], {}, '/tmp/demo.pdf'));
});
