import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOT_OFFICIAL_EN, buildReportHtml, findChromium, htmlEscape, renderReportPdf } from './daftra-pdf.mjs';

const report = {
  title: 'كشف حساب العملاء', columns: ['id', 'client', 'note'],
  records: [{ id: '0012', client: 'شركة نبراس', note: '<script>alert(1)</script> & "q"' }],
  metadata: { source: 'Daftra API', entity: 'invoices', complete: true, exported_at: '2026-11-05T00:00:00Z', filters: { date_from: '2026-01-01' }, official: true },
};

test('html is escaped, RTL, CSP-locked, and says it is NOT an official Daftra document', () => {
  const html = buildReportHtml(report);
  assert.match(html, /dir="rtl"/);
  assert.match(html, /default-src 'none'/);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;'));
  assert.ok(html.includes(NOT_OFFICIAL_EN));
  assert.ok(html.includes('ليس مستندًا رسميًا من دفترة'));
  for (const k of ['source', 'entity', 'record_count', 'complete', 'exported_at', 'filters']) assert.ok(html.includes('<th>' + k + '</th>'), k);
  assert.match(html, /'DejaVu Sans'/);
  assert.equal(htmlEscape('<&"\'>'), '&lt;&amp;&quot;&#39;&gt;');
  assert.match(buildReportHtml({ ...report, title: 'Report', records: [{ id: '1', client: 'x', note: 'y' }] }), /dir="ltr"/);
});

test('renderReportPdf passes locked-down flags to the runner and cleans up its temp dir', async () => {
  const before = (await readdir(tmpdir())).filter((n) => n.startsWith('basht-pdf-')).length;
  let seen;
  const runner = async (bin, args) => {
    seen = { bin, args };
    const html = await readFile(new URL(args.at(-1)), 'utf8');
    assert.ok(html.includes('كشف حساب العملاء'));
    await writeFile(args.find((a) => a.startsWith('--print-to-pdf=')).slice(15), '%PDF-1.7\n1 0 obj\n%%EOF\n');
  };
  const pdf = await renderReportPdf(report, { runner });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  for (const flag of ['--headless', '--no-sandbox', '--disable-gpu', '--disable-remote-fonts', '--no-pdf-header-footer', '--host-resolver-rules=MAP * ~NOTFOUND'])
    assert.ok(seen.args.includes(flag), flag);
  assert.equal((await readdir(tmpdir())).filter((n) => n.startsWith('basht-pdf-')).length, before);
  await assert.rejects(renderReportPdf(report, { runner: async () => {} }), /ENOENT/);           // renderer wrote nothing
  await assert.rejects(renderReportPdf(report, { runner: async (_b, a) => writeFile(a.find((x) => x.startsWith('--print-to-pdf=')).slice(15), '<html>') }), /invalid PDF/);
  assert.equal((await readdir(tmpdir())).filter((n) => n.startsWith('basht-pdf-')).length, before);
});

test('renderReportPdf validates input and reports a missing browser', async () => {
  await assert.rejects(renderReportPdf({ ...report, columns: ['../x'] }, { runner: async () => {} }), /Invalid columns/);
  await assert.rejects(renderReportPdf({ ...report, records: Array(6000).fill({}) }, { runner: async () => {} }), /Too many rows/);
  await assert.rejects(renderReportPdf(report, { env: { PATH: '/nonexistent', CHROMIUM_PATH: '/nonexistent/chrome' } }), /Chromium not found/);
});

test('findChromium honours CHROMIUM_PATH and PATH order', () => {
  const ok = new Set(['/x/chrome', '/bin/chromium']);
  const exec = (p) => ok.has(p);
  assert.equal(findChromium({ CHROMIUM_PATH: '/x/chrome' }, exec), '/x/chrome');
  assert.equal(findChromium({ CHROMIUM_PATH: '/y/chrome' }, exec), null);
  assert.equal(findChromium({ PATH: '/usr/bin:/bin' }, exec), '/bin/chromium');
});

test('integration: real Chromium renders an Arabic PDF', async (t) => {
  if (!findChromium()) return t.skip('no Chromium available');
  const pdf = await renderReportPdf(report);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.subarray(-1024).toString('latin1').includes('%%EOF'));
  const dir = await mkdtemp(join(tmpdir(), 'basht-pdfcheck-'));
  try {
    const file = join(dir, 'r.pdf');
    await writeFile(file, pdf);
    let text;
    try { text = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }); } catch { return; }
    assert.ok(text.includes('Generated summary report'));
    assert.ok(text.replace(/[‪-‮‎‏]/g, '').includes('كشف'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
