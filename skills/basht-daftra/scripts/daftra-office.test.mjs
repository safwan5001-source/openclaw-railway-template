import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, toDocx, toXlsx, validateSheetName, xmlText, zip } from './daftra-office.mjs';

// Minimal reader used to inspect our own archives without trusting the writer.
function unzip(buf) {
  const files = {};
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    assert.equal(data.length, usize);
    assert.equal(crc32(data), crc, name + ' crc');
    files[name] = data.toString('utf8');
    p += 46 + nlen;
  }
  return files;
}
const records = [
  { id: '0012', client: 'شركة <نبراس> & "شركاه"', total: '-120.50', note: '=1+2', big: '12345678901234567890', multi: 'a\nb' },
  { id: '0013', client: 'x', total: '1234.5', note: '  +cmd', big: '1', multi: '' },
];
const columns = ['id', 'client', 'total', 'note', 'big', 'multi'];

test('zip is a valid archive with correct CRCs; crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const files = unzip(zip([['a.txt', 'hello'.repeat(100)], ['b/c.xml', '<x/>']]));
  assert.equal(files['a.txt'], 'hello'.repeat(100));
  assert.equal(files['b/c.xml'], '<x/>');
});

test('xlsx: typed numbers, text ids, formula protection, RTL, info sheet, well-formed parts', () => {
  const files = unzip(toXlsx(records, columns, { title: 'كشف', metadata: { source: 'Daftra API', complete: true, filters: { a: 1 } }, numericColumns: ['total', 'big'] }));
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /rightToLeft="1"/);
  assert.match(sheet, /<c r="C2" s="2"><v>-120.50<\/v><\/c>/);          // negative amount stays a number
  assert.match(sheet, /<c r="E2" t="inlineStr">/);                       // >15 digits stays text, not rounded
  assert.match(sheet, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">0012<\/t>/); // leading zeros kept
  assert.match(sheet, /<t xml:space="preserve">'=1\+2<\/t>/);
  assert.match(sheet, /<t xml:space="preserve">'  \+cmd<\/t>/);
  assert.match(sheet, /شركة &lt;نبراس&gt; &amp; &quot;شركاه&quot;/);
  assert.match(files['xl/worksheets/sheet2.xml'], /Daftra API/);
  assert.match(files['xl/worksheets/sheet2.xml'], /complete/);
  assert.match(files['xl/styles.xml'], /<b\/>/);
  assert.match(files['xl/workbook.xml'], /name="Info"/);
});

test('docx: table, RTL markers, escaping, landscape for wide tables', () => {
  const files = unzip(toDocx(records, columns, { title: 'كشف حساب', metadata: { source: 'Daftra API' } }));
  const doc = files['word/document.xml'];
  assert.match(doc, /<w:bidi\/>/);
  assert.match(doc, /<w:rtl\/>/);
  assert.match(doc, /<w:tbl>/);
  assert.match(doc, /w:orient="landscape"/);
  assert.match(doc, /<w:br\/>/);
  assert.ok(!doc.includes('<نبراس>'));
  assert.match(files['word/styles.xml'], /TableGrid/);
  const ltr = unzip(toDocx([{ id: '1' }], ['id'], { title: 'Report' }))['word/document.xml'];
  assert.ok(!ltr.includes('<w:bidi/>'));
});

test('validation: columns, record count, sheet names, huge cells, control characters', () => {
  assert.throws(() => toXlsx([], [], {}), /Invalid columns/);
  assert.throws(() => toXlsx([], ['a', 'a']), /Invalid columns/);
  assert.throws(() => toXlsx([], ['../x']), /Invalid columns/);
  assert.throws(() => toXlsx(Array(10), ['a'], { maxRows: 5 }), /Invalid record count/);
  for (const bad of ['a/b', 'x'.repeat(32), '', 'a[1]', "'q", 'Info']) assert.throws(() => validateSheetName(bad), /sheet name/i, bad);
  assert.throws(() => toXlsx([{ a: 'x'.repeat(40000) }], ['a']), /Cell too long/);
  assert.equal(xmlText('a\u0000b\u000bc\ud800d'), 'abcd');
  assert.doesNotThrow(() => unzip(toXlsx([{ a: 'ctl\u0001char' }], ['a'])));
});

function python(script, ...args) {
  try { return execFileSync('python3', ['-I', '-c', script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}

test('real readers open the files: openpyxl for XLSX, python-docx for DOCX', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'basht-office-'));
  try {
    const x = join(dir, 't.xlsx'), d = join(dir, 't.docx');
    await writeFile(x, toXlsx(records, columns, { title: 'كشف', metadata: { source: 'Daftra API' }, numericColumns: ['total'] }));
    await writeFile(d, toDocx(records, columns, { title: 'كشف حساب', metadata: { source: 'Daftra API' } }));
    const xo = python('import openpyxl,json,sys\nwb=openpyxl.load_workbook(sys.argv[1]);ws=wb.worksheets[0]\nprint(json.dumps({"s":wb.sheetnames,"rows":[[c.value for c in r] for r in ws.iter_rows()],"rtl":ws.sheet_view.rightToLeft,"t":ws["C2"].data_type},ensure_ascii=False))', x);
    if (xo === null) return t.skip('python3/openpyxl unavailable');
    const xr = JSON.parse(xo);
    assert.deepEqual(xr.s, ['Daftra', 'Info']);
    assert.equal(xr.rows.length, 3);
    assert.equal(xr.rows[1][0], '0012');
    assert.equal(xr.rows[1][1], 'شركة <نبراس> & "شركاه"');
    assert.equal(xr.rows[1][2], -120.5);
    assert.equal(xr.t, 'n');
    assert.equal(xr.rtl, true);
    const dout = python('import docx,json,sys\nd=docx.Document(sys.argv[1])\nprint(json.dumps({"p":[p.text for p in d.paragraphs],"t":[[c.text for c in r.cells] for r in d.tables[0].rows]},ensure_ascii=False))', d);
    if (dout === null) return t.skip('python-docx unavailable');
    const dr = JSON.parse(dout);
    assert.equal(dr.p[0], 'كشف حساب');
    assert.equal(dr.t.length, 3);
    assert.equal(dr.t[1][2], '-120.50');
    assert.equal(dr.t[1][3], "'=1+2");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
