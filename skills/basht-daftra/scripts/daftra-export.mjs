// A controlled read-only export command. Never posts to Daftra.
// Usage: node src/daftra-export.mjs <entity> <columns-comma-separated> <csv|json> <private-output-file>
// WARNING: a single page is not necessarily a complete report. Refuse unless proven complete.
import { resolve } from 'node:path';
import { listRecords, READABLE_ENTITIES } from './daftra-readonly.mjs';
import { extractList, pickColumns } from './daftra-normalize.mjs';
import { exportData } from './daftra-exports.mjs';

export async function exportDaftraPage(entity, columns, format, output, env = process.env, fetcher = fetch) {
  if (!Object.hasOwn(READABLE_ENTITIES, entity)) throw Error('Unsupported entity');
  if (!['csv', 'json'].includes(format)) throw Error('Unsupported format');
  if (!Array.isArray(columns) || !columns.length || columns.length > 100 || columns.some(x => !/^[A-Za-z0-9_]+$/.test(x)))
    throw Error('Invalid columns');
  const result = extractList(await listRecords(entity, env, fetcher), entity);
  if (!result.complete) throw Error('Export blocked: cannot verify all pages were retrieved');
  const records = pickColumns(result.records, columns);
  const path = resolve(output);
  // Output is restricted to a private subfolder under the OpenClaw workspace.
  const base = resolve(env.OPENCLAW_WORKSPACE_DIR || '/data/workspace', 'exports');
  if (!path.startsWith(base + '/') || !path.endsWith('.' + format)) throw Error('Output must be in private exports directory');
  return exportData(format, records, columns, {
    source: 'Daftra API', entity, record_count: records.length,
    exported_at: new Date().toISOString(), fields: columns,
    complete: true,
  }, path);
}
if (process.argv[1] && import.meta.url === new URL('file://' + resolve(process.argv[1])).href) {
  const [entity, columns, format, output] = process.argv.slice(2);
  try {
    if (!columns) throw Error('Required: entity columns format output');
    console.log(JSON.stringify(await exportDaftraPage(entity, columns.split(','), format, output)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
