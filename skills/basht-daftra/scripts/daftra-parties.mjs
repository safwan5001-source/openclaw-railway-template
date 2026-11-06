// Pure preflight for customer (client) and supplier create/update. Never calls the API.
// Verified against the official docs (docs.daftara.dev):
//   POST /api2/clients.json            { Client:{business_name,...} }  -> 202 {id, client_number}; 400 validation_errors   (15115262e0)
//   PUT  /api2/clients/{id}.json       { Client:{changed fields} }  documented PARTIAL update -> 200 confirmation          (15115259e0)
//   POST /api2/suppliers.json          { Supplier:{business_name,...} } -> 202 {id}; email required unless is_offline       (15115267e0)
//   PUT  /api2/suppliers/{id}.json     { Supplier:{...} } business_name required; partial semantics NOT documented         (15115264e0)
// Because supplier update semantics are undocumented, a supplier update sends the CURRENT writable record merged with
// the requested changes (so nothing can be blanked), and the post-write read-back flags any carried field that changed.
// Deliberately NOT supported: passwords/portal access, send_notify (emails the party), starting_balance (creates an
// accounting entry), suspend, attachments, ClientDetail/custom data, branch, numbering, delete/deactivate, bulk.
import { parseDecimal, format } from './daftra-money.mjs';
import { hashRequest } from './daftra-canonical.mjs';
import { isCalendarDate } from './daftra-entities.mjs';

export const PARTY_TYPES = Object.freeze({
  client_create:   { resource: 'clients',   model: 'Client',   method: 'POST', endpoint: '/api2/clients.json',   verb: 'create customer' },
  client_update:   { resource: 'clients',   model: 'Client',   method: 'PUT',  pathFor: (id) => '/api2/clients/' + id + '.json',   verb: 'update customer' },
  supplier_create: { resource: 'suppliers', model: 'Supplier', method: 'POST', endpoint: '/api2/suppliers.json', verb: 'create supplier' },
  supplier_update: { resource: 'suppliers', model: 'Supplier', method: 'PUT',  pathFor: (id) => '/api2/suppliers/' + id + '.json', verb: 'update supplier' },
});

const ADDRESS = ['address1', 'address2', 'city', 'state', 'postal_code', 'country_code', 'active_secondary_address', 'secondary_name',
  'secondary_address1', 'secondary_address2', 'secondary_city', 'secondary_state', 'secondary_postal_code', 'secondary_country_code'];
export const CLIENT_FIELDS = Object.freeze(['business_name', 'type', 'first_name', 'last_name', 'email', 'phone1', 'phone2', ...ADDRESS, 'national_id', 'notes',
  'default_currency_code', 'language_code', 'category', 'category_id', 'group_price_id', 'credit_limit', 'credit_period', 'birth_date', 'gender', 'link',
  'bn1', 'bn1_label', 'bn2', 'bn2_label']);
export const SUPPLIER_FIELDS = Object.freeze(['business_name', 'first_name', 'last_name', 'email', 'phone1', 'phone2', ...ADDRESS, 'notes',
  'default_currency_code', 'language_code', 'is_offline', 'bn1', 'bn1_label', 'bn2', 'bn2_label']);
// Fields whose change deserves a highlighted line in the human preview.
export const KEY_FIELDS = Object.freeze(['business_name', 'email', 'bn1', 'bn2', 'credit_limit', 'credit_period', 'default_currency_code', 'phone1', 'phone2']);

const EXCLUDED = new Map([
  ['password', 'portal credentials are never set by the agent'], ['confirm_password', 'portal credentials are never set by the agent'],
  ['send_notify', 'would e-mail the party'], ['starting_balance', 'creates an accounting entry (financial effect not verified)'],
  ['starting_balance_date', 'tied to starting_balance'], ['suspend', 'deactivation/blocking needs separate authorisation'],
  ['attachment', 'uploads are not supported'], ['ClientDetail', 'custom/extended data is not supported'], ['le_custom_data_client', 'custom/extended data is not supported'],
  ['branch_id', 'branch scoping is not supported'], ['client_number', 'numbers are assigned by Daftra'], ['supplier_number', 'numbers are assigned by Daftra'],
  ['staff_id', 'ownership is set by Daftra'], ['follow_up_status', 'not supported'], ['id', 'read-only'], ['created', 'read-only'], ['modified', 'read-only'],
  ['last_login', 'read-only'], ['last_ip', 'read-only'], ['is_offline', 'only suppliers may set is_offline'],
]);

const ID = /^[1-9]\d{0,14}$/;
// Control characters (incl. ANSI escapes, newlines) and bidi-override characters are rejected everywhere: they can
// hide or reorder text in the approval preview.
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
function text(v, f, max, { multiline = false } = {}) {
  if (typeof v !== 'string') throw Error(f + ' must be text');
  const s = v.normalize('NFC').trim();
  if (!s || s.length > max) throw Error('Invalid ' + f + ' (1-' + max + ' characters)');
  if (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(s) : BAD_CHARS.test(s)) throw Error('Invalid characters in ' + f);
  return s;
}
const intIn = (v, f, set) => { if (!set.includes(Number(v)) || String(v).trim() === '') throw Error(f + ' must be one of ' + set.join('/')); return Number(v); };

export const normName = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
export const normEmail = (s) => String(s ?? '').trim().toLowerCase();
export const digitsOnly = (s) => String(s ?? '').replace(/\D+/g, '');
export const normTax = (s) => String(s ?? '').toUpperCase().replace(/[\s./-]+/g, '');

function partyValue(field, v, ctx) {
  switch (field) {
    case 'business_name': return text(v, field, 100);
    case 'first_name': case 'last_name': case 'address1': case 'address2': case 'secondary_name': case 'secondary_address1': case 'secondary_address2': return text(v, field, 255);
    case 'city': case 'state': case 'secondary_city': case 'secondary_state': return text(v, field, 100);
    case 'postal_code': return text(v, field, 20);
    case 'secondary_postal_code': return text(v, field, 50);
    case 'notes': return text(v, field, 5000, { multiline: true });
    case 'category': return text(v, field, 100);
    case 'national_id': return text(v, field, 50);
    case 'bn1_label': case 'bn2_label': return text(v, field, 50);
    case 'bn1': case 'bn2': { const s = text(v, field, 50); if (!/^[\p{L}\p{N} ./-]+$/u.test(s)) throw Error(field + ' may contain only letters, digits, space, . / -'); return s; }
    case 'email': {
      const s = normEmail(typeof v === 'string' ? v : ''); if (s.length > 255 || !/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/.test(s) || BAD_CHARS.test(s)) throw Error('Invalid email'); return s;
    }
    case 'phone1': case 'phone2': { const s = text(v, field, 50); if (!/^\+?[\d\s().-]{5,49}$/.test(s) || digitsOnly(s).length < 5) throw Error('Invalid ' + field); return s; }
    case 'country_code': case 'secondary_country_code': { const s = text(v, field, 3).toUpperCase(); if (!/^[A-Z]{2}$/.test(s)) throw Error(field + ' must be an ISO alpha-2 code'); return s; }
    case 'default_currency_code': { const s = text(v, field, 5).toUpperCase(); if (!/^[A-Z]{3}$/.test(s)) throw Error(field + ' must be a 3-letter ISO 4217 code'); return s; }
    case 'language_code': return ctx.kind === 'client' ? Number(idCheck(v, field)) : text(String(v), field, 10);
    case 'category_id': case 'group_price_id': return Number(idCheck(v, field));
    case 'type': return intIn(v, field, [2, 3]);
    case 'gender': return intIn(v, field, [0, 1, 2]);
    case 'is_offline': case 'active_secondary_address': return intIn(v === true ? 1 : v === false ? 0 : v, field, [0, 1]);
    case 'credit_limit': { const u = parseDecimal(v, field, { maxDecimals: 2 }); return format(u); }
    case 'credit_period': { if (!/^\d{1,4}$/.test(String(v)) || Number(v) > 3650) throw Error('credit_period must be 0-3650 days'); return Number(v); }
    case 'birth_date': if (!isCalendarDate(v)) throw Error('birth_date must be YYYY-MM-DD'); return v;
    case 'link': { const s = text(v, field, 255); let u; try { u = new URL(s); } catch { throw Error('link must be a URL'); } if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error('link must be an http(s) URL without credentials'); return s; }
    default: throw Error('Unsupported field: ' + field);
  }
}
function idCheck(v, f) { const s = String(v); if (!ID.test(s)) throw Error(f + ' invalid'); return s; }

function checkNames(fields, allowed, label) {
  for (const k of fields) {
    if (EXCLUDED.has(k) && !allowed.includes(k)) throw Error(label + ' field "' + k + '" is not supported by this skill (' + EXCLUDED.get(k) + ')');
    if (!allowed.includes(k)) throw Error('Unknown ' + label + ' field: ' + k);
  }
}

// Normalised comparison of a stored value and a requested value.
function same(field, cur, next) {
  if (cur === undefined || cur === null) return false;
  if (field === 'email') return normEmail(cur) === normEmail(next);
  if (['credit_limit'].includes(field)) { try { return parseDecimal(String(cur), 'c', { maxDecimals: 6 }) === parseDecimal(String(next), 'n', { maxDecimals: 6 }); } catch { return false; } }
  if (['is_offline', 'active_secondary_address'].includes(field)) return Number(cur === true ? 1 : cur === false ? 0 : cur) === Number(next);
  return String(cur).trim() === String(next).trim();
}
const writable = (record, allowed) => Object.fromEntries(allowed.filter((f) => record?.[f] !== undefined && record[f] !== null && record[f] !== '' && typeof record[f] !== 'object')
  .map((f) => [f, ['is_offline', 'active_secondary_address'].includes(f) ? Number(record[f] === true ? 1 : record[f] === false ? 0 : record[f]) : (f === 'language_code' ? record[f] : record[f])]));

export function prepareCrmAction(type, input, options = {}) {
  if (!Object.hasOwn(PARTY_TYPES, type)) throw Error('Unsupported party action');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid input');
  const spec = PARTY_TYPES[type]; const kind = spec.model === 'Client' ? 'client' : 'supplier';
  const allowed = kind === 'client' ? CLIENT_FIELDS : SUPPLIER_FIELDS;
  const ctx = { kind }; const warnings = [];
  let body; let path = spec.endpoint; let target; let changes = []; let carried = [];
  const effects = [type.endsWith('create') ? 'creates_' + kind : 'modifies_' + kind];

  if (type.endsWith('_create')) {
    const fields = Object.keys(input).filter((k) => input[k] !== undefined && k !== 'acknowledge_duplicates');
    checkNames(fields, allowed, kind);
    if (input.business_name === undefined) throw Error('business_name is required');
    const rec = {};
    for (const f of fields) rec[f] = partyValue(f, input[f], ctx);
    if (kind === 'supplier' && rec.email === undefined && rec.is_offline !== 1) throw Error('A supplier needs an email, or is_offline:1 (Daftra rule)');
    if (kind === 'client' && rec.email === undefined) warnings.push('No email: Daftra will create the customer as OFFLINE');
    if (rec.type === 2 && !rec.first_name && !rec.last_name) warnings.push('Individual customer without first/last name');
    body = { [spec.model]: rec };
    changes = Object.entries(rec).map(([field, to]) => ({ field, from: null, to }));
  } else {
    const key = kind === 'client' ? input.client_id : input.supplier_id;
    target = idCheck(key, kind + '_id');
    if (!input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes) || !Object.keys(input.changes).length) throw Error('changes must be a non-empty object');
    const fields = Object.keys(input.changes).filter((k) => input.changes[k] !== undefined);
    if (!fields.length) throw Error('changes is empty');
    checkNames(fields, allowed, kind);
    const asked = {};
    for (const f of fields) {
      if (input.changes[f] === null || input.changes[f] === '') throw Error(f + ': clearing a field is not supported (empty values are rejected to prevent accidental overwrites)');
      asked[f] = partyValue(f, input.changes[f], ctx);
    }
    const current = options.current;
    if (!current) {
      if (kind === 'supplier') throw Error('Supplier update needs the current record (Daftra requires the full record)');
      changes = Object.entries(asked).map(([field, to]) => ({ field, from: '(current value not loaded)', to }));
      warnings.push('Current customer not loaded: unchanged fields were not filtered out');
      body = { Client: asked };
    } else {
      const real = {};
      for (const [f, v] of Object.entries(asked)) {
        if (same(f, current[f], v)) continue;
        real[f] = v; changes.push({ field: f, from: current[f] === undefined ? '(not returned by Daftra)' : current[f], to: v });
      }
      if (!Object.keys(real).length) throw Error('No changes: the record already has these values');
      if (kind === 'client') body = { Client: real };
      else {
        const base = writable(current, allowed);
        carried = Object.keys(base).filter((f) => real[f] === undefined);
        const merged = { ...base, ...real };
        if (!merged.business_name) throw Error('Supplier has no business_name in Daftra; cannot send a valid full record');
        if (merged.email === undefined && Number(merged.is_offline) !== 1) throw Error('The supplier would have no email and not be offline (Daftra rule)');
        body = { Supplier: merged };
        warnings.push('Daftra does not document partial updates for suppliers: the full current record (' + carried.length + ' unchanged fields) is sent with the changes; a read-back verifies nothing else changed');
      }
    }
    path = spec.pathFor(target);
  }
  const rec = body[spec.model];
  if (rec.bn1 && /vat|tax|ضريب/i.test(String(rec.bn1_label ?? '')) && String(rec.country_code ?? '') === 'SA' && !/^3\d{13}3$/.test(normTax(rec.bn1)))
    warnings.push('bn1 does not look like a Saudi VAT number (15 digits starting and ending with 3)');
  const highlights = changes.filter((c) => KEY_FIELDS.includes(c.field)).map((c) => ({ field: c.field, from: c.from, to: c.to }));
  const request = { method: spec.method, path, query: '', body };
  return Object.freeze({
    type, resource: spec.resource, mode: 'final', target_id: target, changes, highlights, carried_fields: carried,
    party_values: { business_name: rec.business_name, email: rec.email, bn1: rec.bn1, phone1: rec.phone1, phone2: rec.phone2 },
    totals: null, effects,
    reversible: type.endsWith('_update') ? 'edit again to restore the previous values (listed in the preview)' : 'no delete/deactivate is available through this skill; remove in Daftra',
    warnings, request, request_hash: hashRequest(request),
    status: 'PREVIEW_ONLY_NOT_SUBMITTED', canSubmit: false, requiresExplicitApproval: true,
  });
}
