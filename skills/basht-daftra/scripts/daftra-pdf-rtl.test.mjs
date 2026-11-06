// Offline Arabic/RTL checks of the generated (non-official) PDF report using the REAL renderer + poppler.
// Skips with a clear message when Chromium or poppler-utils are not installed. CI installs both plus fonts-noto-core and
// sets EXPECT_NOTO=1 so that the Noto Naskh Arabic font MUST be the one embedded (that is the Railway image's font set).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChromium, renderReportPdf } from './daftra-pdf.mjs';

const have = (bin, args = ['-v']) => spawnSync(bin, args, { encoding: 'utf8' }).error === undefined;
const chromium = findChromium();
const poppler = have('pdftotext', ['-v']) && have('pdffonts', ['-v']);
const skipReason = !chromium ? 'Chromium not found (set CHROMIUM_PATH)' : !poppler ? 'poppler-utils (pdftotext/pdffonts) not installed' : false;

const TITLE = 'كشف حساب العميل';                     // chosen without lam-alef ligatures (poppler splits those on extraction)
const CLIENT = 'شركة نبراس للخدمات';
const report = {
  title: TITLE, rtl: true, columns: ['id', 'client', 'note'],
  records: [{ id: '0012', client: CLIENT, note: 'Diesel — فاتورة رقم 77' }],
  metadata: { source: 'Daftra API', entity: 'invoices', complete: true, exported_at: '2026-11-05T00:00:00Z', official: true },
};

// Arabic letters as extracted by poppler: NFKC folds presentation forms; bidi marks, tashkeel and spaces are noise.
const fold = (s) => s.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069ً-ٟ\s]+/g, '');
const reverse = (s) => [...s].reverse().join('');

let pdfPath; let dir;
test('render the bilingual report with the real renderer', { skip: skipReason }, async () => {
  dir = await mkdtemp(join(tmpdir(), 'basht-rtl-'));
  pdfPath = join(dir, 'report.pdf');
  const bytes = await renderReportPdf(report, { env: process.env });
  await writeFile(pdfPath, bytes);
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
});

test('Arabic text is extractable and in logical (RTL reading) order, not mirrored or tofu', { skip: skipReason }, () => {
  const text = fold(spawnSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' }).stdout);
  assert.ok(text.includes(fold(TITLE)), 'title words extractable in reading order');
  assert.ok(text.includes(fold(CLIENT)), 'table cell extractable in reading order');
  assert.ok(!text.includes(reverse(fold(TITLE))), 'title must not be mirrored');
  assert.ok(text.includes('Generatedsummaryreport'), 'English notice present next to the Arabic one');
  assert.ok(text.includes('0012') && text.includes('Diesel'), 'Latin/digits cells intact');
  assert.ok(!/[�□]/.test(text), 'no replacement/tofu characters');
});

test('the not-official notice is present in Arabic too', { skip: skipReason }, () => {
  const text = fold(spawnSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' }).stdout);
  assert.ok(text.includes(fold('ليس مستندا رسميا')) || text.includes(fold('ليسمستنداً')) || /ليسمستند/.test(text), 'Arabic "not an official document" banner');
});

test('an Arabic-capable font is embedded (Noto/DejaVu), and Noto Naskh when EXPECT_NOTO=1', { skip: skipReason }, () => {
  const out = spawnSync('pdffonts', [pdfPath], { encoding: 'utf8' }).stdout;
  const names = out.split('\n').slice(2).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean).map((n) => n.replace(/^[A-Z]{6}\+/, ''));
  assert.ok(names.length > 0, 'fonts listed');
  assert.ok(names.some((n) => /Noto(Naskh|Sans)?Arabic|DejaVuSans|Amiri|Arab/i.test(n)), 'Arabic-capable font embedded, got: ' + names.join(', '));
  if (process.env.EXPECT_NOTO === '1') assert.ok(names.some((n) => /NotoNaskhArabic/.test(n)), 'Noto Naskh Arabic must be embedded in the image font set, got: ' + names.join(', '));
  assert.ok(/\syes\s+(yes|no)\s+(yes|no)\s/.test(out), 'fonts are embedded (emb=yes)');
});

test('cleanup', { skip: skipReason }, async () => { await rm(dir, { recursive: true, force: true }); });
