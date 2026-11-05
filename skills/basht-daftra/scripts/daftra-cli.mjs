#!/usr/bin/env node
// BASHT × Daftra command line. Every command prints ONE JSON document on stdout.
// Errors print {"ok":false,"error":...} on stderr and exit 1. Secrets are never printed.
//
//   READ    capabilities | list <entity> | get <entity> <id> | report <name> | statement <client-id>
//   FILES   pdf <invoice-id> <file.pdf> | export <entity> | export-report <name> | export-statement <client-id>
//   WRITE   propose <type> | show <proposal-id> | execute <proposal-id> | resolve <proposal-id>
//           (propose/show are read-only; execute needs DAFTRA_WRITES_ENABLED=1 AND the exact approval phrase)
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ENTITIES, REPORTS } from './daftra-entities.mjs';
import { listPage, fetchAllRecords, getOne, getReport, isPartialReport, downloadInvoicePdf } from './daftra-readonly.mjs';
import { redactRecord, pickColumns } from './daftra-normalize.mjs';
import { exportDaftraRecords, exportReport } from './daftra-export.mjs';
import { exportData, FORMATS } from './daftra-exports.mjs';
import { safeOutputPath, ensureExportsDir } from './daftra-paths.mjs';
import { clientStatement } from './daftra-statements.mjs';
import { ACTION_TYPES } from './daftra-finance-preflight.mjs';
import { createProposal } from './daftra-proposal.mjs';
import { executeProposal, resolveProposal, WriteRefused } from './daftra-write.mjs';
import { loadProposal } from './daftra-ledger.mjs';

// ---- argument parsing: positionals + --flag value (repeatable --query k=v / --param k=v) -------
export function parseArgs(argv) {
  const positional = []; const flags = {}; const query = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const key = a.slice(2);
    if (key === 'all') { flags.all = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw Error('Missing value for --' + key);
    if (key === 'query' || key === 'param') {
      const eq = value.indexOf('=');
      if (eq < 1) throw Error('--' + key + ' expects name=value');
      query[value.slice(0, eq)] = value.slice(eq + 1);
    } else flags[key] = value;
  }
  return { positional, flags, query };
}

async function readInput(flags) {
  if (flags.input !== undefined) return JSON.parse(flags.input);
  if (flags['input-file']) return JSON.parse(await readFile(resolve(flags['input-file']), 'utf8'));
  throw Error('Provide --input \'{"..."}\' or --input-file path.json');
}

const columnsOf = (flags) => flags.columns && flags.columns !== '-' ? flags.columns.split(',').map((c) => c.trim()) : undefined;

function publicProposal(p) {
  return {
    ok: true, proposal_id: p.id, status: p.status, type: p.type, mode: p.mode, expires_at: p.expires_at,
    party: p.party, totals: p.totals, effects: p.effects, reversible: p.reversible,
    request: { method: p.request.method, path: p.request.path, query: p.request.query, body: p.request.body },
    checks: p.checks, blocking: p.blocking, warnings: p.warnings, duplicates: p.duplicates,
    request_hash: p.request_hash,
    next: p.status === 'READY_FOR_APPROVAL'
      ? 'NOTHING HAS BEEN SENT. Show this preview to the user and ask them to review and obtain the approval phrase from the operator tool: `node daftra-approve.mjs show ' + p.id + '` (run in a trusted shell). You cannot derive the phrase. Run execute only with the phrase the user sends you.'
      : 'BLOCKED: nothing can be executed. Fix the blocking items and propose again.',
  };
}

export async function run(argv, { env = process.env, fetcher = fetch, sleep } = {}) {
  const { positional, flags, query } = parseArgs(argv);
  const [command, a1, a2] = positional;
  const actor = flags.actor || 'unknown';
  switch (command) {
    case 'capabilities':
      return {
        ok: true,
        read: Object.keys(ENTITIES), reports: Object.keys(REPORTS), formats: FORMATS,
        writes: Object.keys(ACTION_TYPES),
        writes_enabled: env.DAFTRA_WRITES_ENABLED === '1',
        official_pdf: 'invoices only (invoice_pdf_url); every other PDF is a generated, non-official summary',
        not_implemented: ['edit', 'delete', 'cancel', 'e-invoice (ZATCA) submission', 'create/modify clients, suppliers, products', 'supplier statements'],
      };
    case 'list': {
      if (!a1) throw Error('Usage: list <entity> [--query k=v]... [--all] [--columns a,b]');
      const columns = columnsOf(flags);
      if (flags.all) {
        const r = await fetchAllRecords(a1, { query, pageSize: Number(flags['page-size'] || 100), sleep }, env, fetcher);
        const rows = r.records.map(redactRecord);
        return { ok: true, entity: a1, complete: true, count: r.count, total: r.total, pages: r.pages, records: columns ? pickColumns(rows, columns) : rows };
      }
      const page = await listPage(a1, { limit: 20, ...query }, env, fetcher, { sleep });
      const rows = page.records.map(redactRecord);
      return { ok: true, entity: a1, complete: page.complete, count: page.count, total: page.total, warning: page.warning, records: columns ? pickColumns(rows, columns) : rows };
    }
    case 'get': {
      if (!a1 || !a2) throw Error('Usage: get <entity> <id>');
      return { ok: true, entity: a1, record: redactRecord(await getOne(a1, a2, env, fetcher)) };
    }
    case 'report': {
      if (!a1) throw Error('Usage: report <name> [--param k=v]...');
      const payload = redactRecord(await getReport(a1, query, env, fetcher, { sleep }));
      return { ok: true, report: a1, complete: !isPartialReport(a1, query), official: false, payload };
    }
    case 'statement': {
      if (!a1 || !flags.from || !flags.to) throw Error('Usage: statement <client-id> --from YYYY-MM-DD --to YYYY-MM-DD');
      return { ok: true, ...(await clientStatement({ clientId: a1, from: flags.from, to: flags.to }, env, fetcher, { sleep })) };
    }
    case 'pdf': {
      if (!a1 || !a2) throw Error('Usage: pdf <invoice-id> <file.pdf>');
      await ensureExportsDir(env);
      return { ok: true, ...(await downloadInvoicePdf(a1, safeOutputPath(a2, 'pdf', env), env, fetcher)) };
    }
    case 'export': {
      if (!a1 || !flags.format || !flags.out) throw Error('Usage: export <entity> --format csv|json|xlsx|docx|pdf --out <file> [--columns a,b] [--query k=v]...');
      return { ok: true, ...(await exportDaftraRecords({ entity: a1, columns: columnsOf(flags), format: flags.format, output: flags.out, query, pageSize: Number(flags['page-size'] || 100) }, env, fetcher, { sleep })) };
    }
    case 'export-report': {
      if (!a1 || !flags.format || !flags.out) throw Error('Usage: export-report <name> --format ... --out <file> [--param k=v]...');
      return { ok: true, ...(await exportReport(a1, query, flags.format, flags.out, env, fetcher, { sleep })) };
    }
    case 'export-statement': {
      if (!a1 || !flags.from || !flags.to || !flags.format || !flags.out) throw Error('Usage: export-statement <client-id> --from --to --format ... --out <file>');
      await ensureExportsDir(env);
      const path = safeOutputPath(flags.out, flags.format, env);
      const s = await clientStatement({ clientId: a1, from: flags.from, to: flags.to }, env, fetcher, { sleep });
      const cols = ['date', 'kind', 'reference', 'debit', 'credit', 'balance'];
      return { ok: true, reconciles: s.reconciles, warnings: s.warnings, ...(await exportData(flags.format, s.rows, cols, {
        source: 'Daftra API', entity: 'client_statement', client_id: s.client_id, from: s.from, to: s.to, totals: s.totals, reconciles: s.reconciles,
        record_count: s.rows.length, exported_at: new Date().toISOString(), complete: true, official: false, warnings: s.warnings,
      }, path, { env, numericColumns: ['debit', 'credit', 'balance'], title: 'Client statement ' + s.client_id })) };
    }
    case 'propose': {
      if (!a1) throw Error('Usage: propose <' + Object.keys(ACTION_TYPES).join('|') + '> --input \'{...}\' [--actor name]');
      return publicProposal(await createProposal(a1, await readInput(flags), { env, fetcher, actor }));
    }
    case 'show': {
      if (!a1) throw Error('Usage: show <proposal-id>');
      return publicProposal(await loadProposal(a1, env));
    }
    case 'execute': {
      if (!a1 || flags.phrase === undefined) throw Error('Usage: execute <proposal-id> --phrase "APPROVE ..." [--actor name]');
      return await executeProposal({ id: a1, phrase: flags.phrase, actor }, { env, fetcher });
    }
    case 'resolve': {
      if (!a1 || !['true', 'false'].includes(flags.created) || !flags.code) throw Error('Usage: resolve <proposal-id> --created true|false --code <code from daftra-approve.mjs resolve> [--record-id N]');
      return await resolveProposal({ id: a1, created: flags.created === 'true', recordId: flags['record-id'], code: flags.code, actor }, { env });
    }
    default:
      throw Error('Unknown command. Run: capabilities');
  }
}

if (process.argv[1] && import.meta.url === new URL('file://' + resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await run(process.argv.slice(2)), (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch (error) {
    const body = { ok: false, error: error.message };
    if (error instanceof WriteRefused) body.refused = error.code;
    console.error(JSON.stringify(body));
    process.exitCode = 1;
  }
}
