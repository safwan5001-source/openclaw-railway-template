// Locally generated summary-report PDF (headless Chromium prints escaped HTML).
// This is NEVER an official Daftra document: the page says so, and callers set official=false.
// Official PDFs only come from Daftra itself (downloadInvoicePdf in daftra-readonly.mjs).
import { execFile } from 'node:child_process';
import { accessSync, constants, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cellString, detectRtl } from './daftra-cells.mjs';

export const NOT_OFFICIAL_EN = 'Generated summary report — not an official Daftra document';
export const NOT_OFFICIAL_AR = 'تقرير ملخص مُنشأ آليًا — ليس مستندًا رسميًا من دفترة';
const MAX_PDF_ROWS = 5000;

export function htmlEscape(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function executable(path) {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

export function findChromium(env = process.env, isExecutable = executable) {
  if (env.CHROMIUM_PATH) return isExecutable(env.CHROMIUM_PATH) ? env.CHROMIUM_PATH : null;
  const pathDirs = (env.PATH || '').split(delimiter).filter(Boolean);
  const onPath = (names) => {
    for (const dir of pathDirs) for (const name of names) if (isExecutable(join(dir, name))) return join(dir, name);
    return null;
  };
  // Debian `chromium` (installed by the Dockerfile) first, then Playwright's browsers.
  const found = onPath(['chromium', 'chromium-browser', 'chrome-headless-shell']);
  if (found) return found;
  try {
    const roots = readdirSync('/opt/pw-browsers');
    const pick = (re, subs) => {
      for (const entry of roots.filter((n) => re.test(n)).sort().reverse())
        for (const sub of subs) if (isExecutable(join('/opt/pw-browsers', entry, sub))) return join('/opt/pw-browsers', entry, sub);
      return null;
    };
    const pw = pick(/^chromium_headless_shell-\d+$/, ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell'])
      ?? pick(/^chromium-\d+$/, ['chrome-linux64/chrome', 'chrome-linux/chrome']);
    if (pw) return pw;
  } catch { /* no Playwright browsers here */ }
  return onPath(['google-chrome', 'google-chrome-stable']);
}

export function buildReportHtml({ title = 'Daftra report', columns, records, metadata = {}, rtl, labels = {} }) {
  const isRtl = rtl ?? detectRtl(title, columns, records);
  const notices = [NOT_OFFICIAL_EN, ...(isRtl ? [NOT_OFFICIAL_AR] : [])];
  const meta = { ...metadata, official: false, record_count: metadata.record_count ?? records.length };
  const provenance = ['source', 'entity', 'record_count', 'complete', 'exported_at', 'filters']
    .filter((k) => meta[k] !== undefined)
    .map((k) => `<tr><th>${htmlEscape(labels[k] ?? k)}</th><td><bdi>${htmlEscape(cellString(meta[k]))}</bdi></td></tr>`).join('');
  const head = columns.map((c) => `<th>${htmlEscape(labels[c] ?? c)}</th>`).join('');
  const rows = records.map((r) => '<tr>' + columns.map((c) => `<td><bdi>${htmlEscape(cellString(r?.[c]))}</bdi></td>`).join('') + '</tr>').join('');
  return `<!doctype html><html lang="${isRtl ? 'ar' : 'en'}" dir="${isRtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${htmlEscape(title)}</title><style>
@page { size: A4 ${columns.length > 6 ? 'landscape' : 'portrait'}; margin: 14mm 12mm 18mm; }
body { font-family: 'Noto Naskh Arabic','DejaVu Sans',Arial,sans-serif; font-size: 10pt; color: #111; }
h1 { font-size: 16pt; margin: 0 0 6px; } .notice { border: 1px solid #b00; color: #800; padding: 4px 8px; margin: 6px 0 10px; font-weight: bold; }
table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #888; padding: 3px 5px; text-align: start; vertical-align: top; overflow-wrap: anywhere; }
thead { display: table-header-group; } tr { page-break-inside: avoid; } thead th { background: #e7e6e6; }
table.prov { width: auto; margin-bottom: 10px; } table.prov th { background: #f3f3f3; }
footer { margin-top: 12px; font-size: 8.5pt; color: #444; }
</style></head><body><h1>${htmlEscape(title)}</h1>
${notices.map((n) => `<div class="notice">${htmlEscape(n)}</div>`).join('')}
<table class="prov">${provenance}</table>
<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>
<footer>${notices.map(htmlEscape).join(' | ')}</footer></body></html>`;
}

function run(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 1 << 20 }, (error) => (error ? reject(new Error('PDF renderer failed: ' + (error.killed ? 'timeout' : error.code ?? 'error'))) : resolve()));
  });
}

// report: {title, columns, records, metadata, rtl, labels}; returns a Buffer.
// opts.runner(bin, args) must produce the file named by the --print-to-pdf= argument (injectable for tests).
export async function renderReportPdf(report, { env = process.env, runner, timeoutMs = 60000, maxRows = MAX_PDF_ROWS } = {}) {
  const { columns, records } = report;
  if (!Array.isArray(records) || records.length > maxRows) throw Error('Too many rows for a PDF report (max ' + maxRows + ')');
  if (!Array.isArray(columns) || !columns.length || columns.length > 30 || columns.some((c) => typeof c !== 'string' || !/^[a-zA-Z0-9_]+$/.test(c)))
    throw Error('Invalid columns');
  const bin = runner ? 'chromium' : findChromium(env);
  if (!bin) throw Error('Chromium not found (set CHROMIUM_PATH): cannot render PDF report');
  const dir = await mkdtemp(join(tmpdir(), 'basht-pdf-'), { mode: 0o700 });
  try {
    const htmlPath = join(dir, 'report.html');
    const pdfPath = join(dir, 'report.pdf');
    await writeFile(htmlPath, buildReportHtml(report), { mode: 0o600 });
    const args = ['--headless', '--no-sandbox', '--disable-gpu', '--disable-remote-fonts', '--disable-extensions',
      '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND', '--no-pdf-header-footer',
      '--user-data-dir=' + join(dir, 'profile'), '--print-to-pdf=' + pdfPath, pathToFileURL(htmlPath).href];
    await (runner ?? ((b, a) => run(b, a, timeoutMs)))(bin, args);
    const bytes = await readFile(pdfPath);
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-' || !bytes.subarray(-1024).toString('latin1').includes('%%EOF'))
      throw Error('Renderer produced an invalid PDF');
    return bytes;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
