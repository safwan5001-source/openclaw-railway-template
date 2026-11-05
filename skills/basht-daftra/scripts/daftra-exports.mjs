// Safe reusable exports for Daftra records. No API calls or financial writes.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const MAX_ROWS = 10000;
function cleanCell(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Excel formula injection: preserve original as inert text (quoted field still executes).
  return /^[\s\u0000-\u001f]*[=+@-]/u.test(s) ? "'" + s : s;
}
export function toCsv(records, columns) {
  if (!Array.isArray(records) || records.length > MAX_ROWS) throw Error('Invalid record count');
  if (!Array.isArray(columns) || !columns.length || columns.length > 100 || columns.some(c => !/^[a-zA-Z0-9_]+$/.test(c)))
    throw Error('Invalid columns');
  function field(v) { return '"' + cleanCell(v).replaceAll('"', '""') + '"'; }
  return '\uFEFF' + columns.map(field).join(',') + '\r\n' +
    records.map(record => columns.map(col => field(record?.[col])).join(',')).join('\r\n') +
    (records.length ? '\r\n' : '');
}
export function toJson(records, metadata) {
  if (!Array.isArray(records) || records.length > MAX_ROWS) throw Error('Invalid record count');
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) throw Error('Invalid metadata');
  return JSON.stringify({ schema_version: 1, record_count: records.length, metadata, records }, null, 2) + '\n';
}
export async function exportData(format, records, columns, metadata, output) {
  if (!['csv', 'json'].includes(format)) throw Error('Unsupported export format');
  if (!output || typeof output !== 'string' || !output.endsWith('.' + format)) throw Error('Invalid output filename');
  const body = format === 'csv' ? toCsv(records, columns) : toJson(records, metadata);
  await writeFile(resolve(output), body, { flag: 'wx', mode: 0o600 });
  return { path: resolve(output), format, record_count: records.length };
}
