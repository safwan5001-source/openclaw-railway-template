#!/usr/bin/env node
// Pure, read-only analysis. Does not open network connections or write files.
import { readFileSync } from 'node:fs';

function fail(message) {
  process.stderr.write(JSON.stringify({ ok: false, error: message }) + '\n');
  process.exitCode = 1;
}
function finitePositive(x) { return typeof x === 'number' && Number.isFinite(x) && x > 0; }
function normal(s) {
  return String(s || '').normalize('NFKC').toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[\u0622\u0623\u0625]/g, '\u0627')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === value;
}
function leads(input) {
  if (!Array.isArray(input.leads) || input.leads.length > 500) throw Error('leads must be an array of at most 500');
  const seen = new Map();
  const allowed = new Set(['prospect','unverified_request','verified_open_request','qualified','closed']);
  return input.leads.map((v, index) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('invalid lead at index ' + index);
    const issues = [], name = typeof v.name === 'string' ? v.name.trim() : '';
    if (!name || name.length > 200) issues.push('missing_or_invalid_name');
    if (!allowed.has(v.status)) issues.push('invalid_status');
    let host = '';
    try {
      const u = new URL(v.source_url);
      if (u.protocol !== 'https:') throw Error('not_https');
      host = u.hostname.toLowerCase();
    } catch { issues.push('missing_valid_https_source_url'); }
    if (!dateOnly(v.checked_at)) issues.push('missing_valid_check_date');
    if (v.status === 'verified_open_request' || v.status === 'qualified') {
      issues.push('manual_confirmation_required_not_automatically_verified');
      if (!dateOnly(v.request_confirmed_at)) issues.push('missing_confirmed_request_date');
      if (!v.confirmation_evidence) issues.push('missing_confirmation_evidence');
    }
    if (v.status === 'qualified') {
      for (const f of ['loading_location','unloading_location','material','vehicle_type']) {
        if (!v[f]) issues.push('missing_' + f);
      }
    }
    // Never output an unsubstantiated verified/qualified status as if it were valid.
    // The original status is retained separately for audit, not as the effective classification.
    const claimedVerified = v.status === 'verified_open_request' || v.status === 'qualified';
    const missingConfirmation = claimedVerified &&
      (!dateOnly(v.request_confirmed_at) ||
       typeof v.confirmation_evidence !== 'string' || !v.confirmation_evidence.trim());
    const missingQualification = v.status === 'qualified' &&
      ['loading_location','unloading_location','material','vehicle_type'].some(
        f => typeof v[f] !== 'string' || !v[f].trim());
    const status = missingConfirmation ? 'unverified_request' :
      missingQualification ? 'verified_open_request' : (v.status ?? null);
    if (status !== v.status) issues.push('classification_downgraded_missing_evidence');
    const key = normal(name);
    let duplicate_of = null;
    if (key && seen.has(key)) duplicate_of = seen.get(key);
    else if (key) seen.set(key, index);
    const candidate = {index, name, status, claimed_status: v.status ?? null, source_host: host || null, issues, duplicate_of};
    return candidate;
  });
}
function quote(input) {
  if (![input.trips,input.daily_cost_sar].every(finitePositive)) throw Error('trips and daily_cost_sar must be positive finite numbers');
  if (!Number.isInteger(input.trips) || input.trips > 1000) throw Error('trips must be an integer 1..1000');
  if (input.daily_cost_sar > 1e9) throw Error('cost out of supported range');
  const m = input.target_margin_pct;
  if (typeof m !== 'number' || !Number.isFinite(m) || m < 0 || m >= 100) throw Error('target_margin_pct must be in [0,100)');
  const cost = input.daily_cost_sar / input.trips;
  const sell = cost / (1 - m/100);
  if (!Number.isFinite(sell)) throw Error('result exceeds supported numeric range');
  return { currency:'SAR', cost_per_trip_sar: +cost.toFixed(2), illustrative_net_sale_per_trip_sar: +sell.toFixed(2), target_margin_pct:m, vat_included:false, binding_quote:false, assumptions_not_verified:true };
}
try {
  const command = process.argv[2];
  if (!['leads','quote'].includes(command)) throw Error('usage: transport-sales.mjs leads|quote < input.json');
  const raw = readFileSync(0,'utf8');
  if (raw.length > 1e6) throw Error('input too large');
  const input = JSON.parse(raw);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('JSON object required');
  const result = command === 'leads' ? {ok:true,leads:leads(input)} : {ok:true,quote:quote(input)};
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (e) { fail(String(e.message || e)); }
