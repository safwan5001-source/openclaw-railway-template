// Safe reusable exports for Daftra records (CSV, JSON, XLSX, DOCX, generated-summary PDF).
// No API calls or financial writes. Generated files are never "official Daftra documents".
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { safeOutputPath } from './daftra-paths.mjs';
import { resolve } from 'node:path';
import { guessNumericColumns, safeCell } from './daftra-cells.mjs';
import { toDocx, toXlsx } from './daftra-office.mjs';
import { renderReportPdf } from './daftra-pdf.mjs';

export const FORMATS = Object.freeze(['csv', 'json', 'xlsx', 'docx', 'pdf']);
const MAX_ROWS = 10000;
const HARD_MAX_ROWS = 50000;

function rowLimit(opts) {
  const n = opts?.maxRows ?? MAX_ROWS;
  if (!Number.isInteger(n) || n < 1 || n > HARD_MAX_ROWS) throw Error('Invalid row limit');
  return n;
}
function checkColumns(columns) {
  if (!Array.isArray(columns) || !columns.length || columns.length > 100 || columns.some(c => typeof c !== 'string' || !/^[a-zA-Z0-9_]+$/.test(c)))
    throw Error('Invalid columns');
}

export function toCsv(records, columns, opts = {}) {
  if (!Array.isArray(records) || records.length > rowLimit(opts)) throw Error('Invalid record count');
  checkColumns(columns);
  function field(v) { return '"' + safeCell(v).replaceAll('"', '""') + '"'; }
  return '﻿' + columns.map(field).join(',') + '\r\n' +
    records.map(record => columns.map(col => field(record?.[col])).join(',')).join('\r\n') +
    (records.length ? '\r\n' : '');
}

export function toJson(records, metadata, opts = {}) {
  if (!Array.isArray(records) || records.length > rowLimit(opts)) throw Error('Invalid record count');
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) throw Error('Invalid metadata');
  return JSON.stringify({ schema_version: 1, record_count: records.length, metadata, records }, null, 2) + '\n';
}

// records are already column-selected by the caller. Returns { path, format, record_count, bytes, sha256 }.
// opts: { maxRows, numericColumns, title, env, runner }
export async function exportData(format, records, columns, metadata, output, opts = {}) {
  if (!FORMATS.includes(format)) throw Error('Unsupported export format');
  if (!output || typeof output !== 'string' || !output.endsWith('.' + format)) throw Error('Invalid output filename');
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) throw Error('Invalid metadata');
  checkColumns(columns);
  // Locally generated files are never official Daftra documents, whatever the caller passes.
  const meta = { ...metadata, official: false };
  const maxRows = Math.min(rowLimit({ maxRows: opts.maxRows ?? HARD_MAX_ROWS }), HARD_MAX_ROWS);
  const numericColumns = opts.numericColumns ?? guessNumericColumns(columns);
  const title = opts.title ?? meta.title ?? 'Daftra ' + (meta.entity ?? meta.report ?? 'export');
  let body;
  if (format === 'csv') body = Buffer.from(toCsv(records, columns, { maxRows }), 'utf8');
  else if (format === 'json') body = Buffer.from(toJson(records, meta, { maxRows }), 'utf8');
  else if (format === 'xlsx') body = toXlsx(records, columns, { title, metadata: meta, numericColumns, maxRows });
  else if (format === 'docx') body = toDocx(records, columns, { title, metadata: meta, maxRows: Math.min(maxRows, MAX_ROWS) });
  else body = await renderReportPdf({ title, columns, records, metadata: meta }, { env: opts.env, runner: opts.runner });
  // Re-validate immediately before writing: the fetch above may have taken minutes (symlink swap / TOCTOU).
  const path = opts.env ? safeOutputPath(output, format, opts.env) : resolve(output);
  await writeFile(path, body, { flag: 'wx', mode: 0o600 });
  return { path, format, record_count: records.length, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
}
