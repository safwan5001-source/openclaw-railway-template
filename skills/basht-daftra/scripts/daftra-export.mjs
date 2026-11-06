// Controlled read-only exports. Never posts to Daftra. Complete-only: a collection is exported
// only after fetchAllRecords() has proven that every page was retrieved.
// Usage: node daftra-export.mjs <entity> <col1,col2|-> <csv|json|xlsx|docx|pdf> <file-in-private-exports-dir>
import { resolve } from 'node:path';
import { ENTITIES } from './daftra-entities.mjs';
import { fetchAllRecords, getReport, isPartialReport, PAGED_REPORTS } from './daftra-readonly.mjs';
import { isSensitiveKey, pickColumns, redactRecord } from './daftra-normalize.mjs';
import { FORMATS, exportData } from './daftra-exports.mjs';
import { safeOutputPath, ensureExportsDir } from './daftra-paths.mjs';

const SCALAR = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

function sanitiseKey(key) {
  return String(key).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'col';
}

// Caller allowlist wins; sensitive columns (passwords, hash-authenticated URLs, tokens) are refused.
export function resolveColumns(records, columns) {
  if (columns !== undefined && columns !== null && (!Array.isArray(columns) || columns.length)) {
    if (!Array.isArray(columns) || columns.length > 100 || columns.some(c => typeof c !== 'string' || !/^[A-Za-z0-9_]+$/.test(c)))
      throw Error('Invalid columns');
    if (columns.some(isSensitiveKey)) throw Error('Column is sensitive and cannot be exported');
    return columns;
  }
  const first = records.find((r) => r && typeof r === 'object');
  const defaults = first ? Object.keys(first).filter((k) => SCALAR(first[k]) && !isSensitiveKey(k) && /^[A-Za-z0-9_]+$/.test(k)) : [];
  if (!defaults.length) throw Error('columns are required when no scalar columns can be inferred');
  return defaults.slice(0, 100);
}

export async function exportDaftraRecords({ entity, columns, format, output, query = {}, pageSize = 100 } = {},
  env = process.env, fetcher = fetch, extra = {}) {
  if (typeof entity !== 'string' || !Object.hasOwn(ENTITIES, entity)) throw Error('Unsupported entity');
  if (!FORMATS.includes(format)) throw Error('Unsupported format');
  // Validate the destination before spending any API calls.
  await ensureExportsDir(env);
  const path = safeOutputPath(output, format, env);
  if (Array.isArray(columns) && columns.some(c => typeof c === 'string' && isSensitiveKey(c))) throw Error('Column is sensitive and cannot be exported');
  const result = await fetchAllRecords(entity, { query, pageSize, sleep: extra.sleep }, env, fetcher);
  if (!result.complete) throw Error('Export blocked: cannot verify all pages were retrieved');
  const cols = resolveColumns(result.records, columns);
  const records = pickColumns(result.records.map(redactRecord), cols);
  return exportData(format, records, cols, {
    source: 'Daftra API', entity, record_count: records.length, total_results: result.total, pages: result.pages,
    exported_at: new Date().toISOString(), filters: query, fields: cols, complete: true, official: false,
  }, path, { env, runner: extra.runner });
}

// Backward-compatible name and positional signature.
export async function exportDaftraPage(entity, columns, format, output, env = process.env, fetcher = fetch, extra = {}) {
  return exportDaftraRecords({ entity, columns, format, output }, env, fetcher, extra);
}

// ----- reports -----
function flattenRow(value, prefix, out, used) {
  for (const [k, v] of Object.entries(value)) {
    const name = prefix ? prefix + '_' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenRow(v, name, out, used);
    else {
      let key = sanitiseKey(name);
      for (let i = 2; used.has(key) && used.get(key) !== name; i++) key = sanitiseKey(name) + '_' + i;
      used.set(key, name);
      out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
    }
  }
  return out;
}
const isRow = (v) => v && typeof v === 'object' && !Array.isArray(v);
const hasRowArray = (v) => Array.isArray(v) && v.length && v.every(isRow);

// Find the tabular rows of a report. Scalars of ancestor objects become context columns so that
// grouped reports (by currency / client / period) keep their group labels. Returns null if the
// payload holds no array of row objects, so callers never silently export an empty table.
export function flattenReport(payload) {
  const rows = [];
  function walk(node, ctx) {
    if (hasRowArray(node)) {
      for (const item of node) {
        if (Object.values(item).some(hasRowArray) || Object.values(item).some((v) => isRow(v) && Object.values(v).some(hasRowArray))) walk(item, ctx);
        else rows.push({ ...ctx, ...flattenRow(item, '', {}, new Map()) });
      }
    } else if (isRow(node)) {
      const own = {};
      for (const [k, v] of Object.entries(node)) if (SCALAR(v)) own[k] = v;
      for (const v of Object.values(node)) if (isRow(v) || Array.isArray(v)) walk(v, { ...ctx, ...own });
    }
  }
  walk(payload?.data ?? payload, {});
  if (!rows.length) return null;
  const columns = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  return { columns: columns.filter((c) => !isSensitiveKey(c)).slice(0, 100), rows };
}

export async function exportReport(name, params, format, output, env = process.env, fetcher = fetch, extra = {}) {
  if (!FORMATS.includes(format)) throw Error('Unsupported format');
  await ensureExportsDir(env);
  const path = safeOutputPath(output, format, env);
  if (isPartialReport(name, params ?? {})) throw Error('Export blocked: a single report page is not a complete report; omit "page" so all pages are fetched');
  const payload = redactRecord(await getReport(name, params ?? {}, env, fetcher, { sleep: extra.sleep }));
  const meta = {
    source: 'Daftra API', report: name, exported_at: new Date().toISOString(), filters: params ?? {}, complete: true,
    completeness_basis: PAGED_REPORTS.includes(name)
      ? 'All pages walked; row count verified against pagination.total_rows'
      : 'Daftra answers HTTP 400 above its size ceilings instead of truncating this report (per official docs)',
    official: false,
  };
  const table = flattenReport(payload);
  if (format === 'json' || !table) {
    if (format !== 'json') throw Error('Report shape is not tabular; export it as json instead');
    const body = { ...meta, payload };
    return exportData('json', [body], ['report'], { ...meta, shape: table ? 'tabular' : 'raw_report_payload' }, path, { env });
  }
  const rows = table.rows.map((r) => Object.fromEntries(table.columns.map((c) => [c, r[c] ?? null])));
  return exportData(format, rows, table.columns, { ...meta, record_count: rows.length }, path, { env, runner: extra.runner });
}

if (process.argv[1] && import.meta.url === new URL('file://' + resolve(process.argv[1])).href) {
  const [entity, columns, format, output] = process.argv.slice(2);
  try {
    if (!columns) throw Error('Required: entity columns(or -) format output');
    console.log(JSON.stringify(await exportDaftraRecords({ entity, columns: columns === '-' ? undefined : columns.split(','), format, output })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
