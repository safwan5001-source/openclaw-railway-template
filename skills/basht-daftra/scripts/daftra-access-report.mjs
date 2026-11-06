// Read-only access matrix: for every allowlisted entity and report, one minimal GET (limit=1 / a one-day range) and a classified outcome.
// It answers "is this a code bug, an unsupported route, a missing permission, or a temporary fault?" WITHOUT widening anything:
// only GETs through the same allowlist are made, nothing is written, no role or key is changed, payloads are discarded.
//
//   ok                  the endpoint answered 200 with a parseable body
//   forbidden           HTTP 403  -> role / permission / inactive plugin / machine access (owner action; see owner_action)
//   report_not_exposed  HTTP 404 on a report -> Daftra: "not exposed on this deployment" (NOT a permission problem)
//   not_found           HTTP 404 on an entity list -> route missing for this account
//   validation          HTTP 400 -> the probe parameters were refused (name in validation_errors)
//   invalid_page        Daftra refused the pagination request itself
//   transient / upstream_error / rate_limited / unauthorized / unknown
import { ENTITIES, REPORTS, UNSUPPORTED_READS } from './daftra-entities.mjs';
import { listRecords, getReport, DaftraError } from './daftra-readonly.mjs';
import { classifyFailure } from './daftra-errors.mjs';

function probeParams(name, day) {
  const spec = REPORTS[name];
  const params = {};
  if (spec.params.includes('date_from')) { params.date_from = day; params.date_to = day; }
  else if (spec.params.includes('from_date')) { params.from_date = day; params.to_date = day; }
  else if (spec.params.includes('date_range_from')) { params.date_range_from = day; params.date_range_to = day; }
  else if (spec.params.includes('date_to')) params.date_to = day;
  if (name === 'revenue') params.report_type = 'invoice';
  if (name === 'expenses_summary' || name === 'expenses_details') params.group_by = 'Category';
  if (name === 'financial_transactions') params.page = '1';        // one page only, never the paged walk
  if (name === 'ledger' && !params.date_from && !params.date_to) params.date_to = day;
  return params;
}

function outcome(kind, name, error) {
  if (!error) return { kind, name, ok: true, status: 200, category: 'ok' };
  if (error instanceof DaftraError && error.category) {
    return { kind, name, ok: false, status: error.status, category: error.category, retryable: error.retryable,
      hint: error.hint, owner_action: error.owner_action ?? null, ...(error.validationErrors ? { validation_errors: error.validationErrors } : {}) };
  }
  // Local refusal (parameter contract) or transport failure; never a statement about Daftra permissions.
  return { kind, name, ok: false, status: null, category: 'local_error', hint: String(error.message).slice(0, 200), owner_action: null };
}

export async function accessReport(env, fetcher, { sleep, only, day = new Date().toISOString().slice(0, 10) } = {}) {
  const results = [];
  const want = (kind, name) => !only || only === kind || only === kind + ':' + name;
  for (const entity of Object.keys(ENTITIES)) {
    if (!want('entity', entity)) continue;
    try { await listRecords(entity, env, fetcher, ENTITIES[entity].unpaginated ? {} : { limit: 1 }, { sleep }); results.push(outcome('entity', entity)); }
    catch (e) { results.push(outcome('entity', entity, e)); }
  }
  for (const report of Object.keys(REPORTS)) {
    if (!want('report', report)) continue;
    try { await getReport(report, probeParams(report, day), env, fetcher, { sleep }); results.push(outcome('report', report)); }
    catch (e) { results.push(outcome('report', report, e)); }
  }
  const by = {};
  for (const r of results) (by[r.category] ??= []).push(r.kind + ':' + r.name);
  const ownerActions = [...new Set(results.map((r) => r.owner_action).filter(Boolean))];
  return {
    probed_on: day, read_only: true, total: results.length, ok: (by.ok ?? []).length,
    summary: by, owner_actions: ownerActions, results,
    not_supported_by_daftra_api: UNSUPPORTED_READS,
    notes: [
      'Only 403 means a missing permission/role/plugin/machine access. A report 404 means the report is not exposed on this deployment (per Daftra docs); a 400 means the probe parameters were refused; 502/503/504 are temporary.',
      'API-key roles (Settings -> API -> API Key -> Roles) are per entity. Daftra does not publish the list of entity names a role accepts; check the key in the Daftra UI rather than widening it blindly.',
      classifyFailure(403, { isReport: true }).owner_action,
    ],
  };
}
