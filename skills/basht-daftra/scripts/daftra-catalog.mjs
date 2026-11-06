// Pure preflight for product / product-category changes. Never calls the API.
// Verified against the official docs (docs.daftara.dev):
//   POST /api2/products.json          { Product:{name,...} }   -> 202 {id}; 400 DUPLICATED {extra_data:{id}}      (15115317e0)
//   PUT  /api2/products/{id}.json     { Product:{changed fields only} } partial update -> 200 confirmation only    (15115314e0)
//   POST /api2/product_categories.json{ Category:{name,category_type:1,parent_id,...} } -> HTTP 200, body code 202   (39121469e0)
//   PUT  /api2/product_categories/{id}.json { Category:{changed fields} }                                           (39121470e0)
// Deliberately NOT supported (not "documented and safe"): stock fields (track_stock, tracking_type,
// initial_stock_level, store_id, low_stock_thershold), bundles (type 3 / ProductBundle), `brand` and
// `category` by name (both auto-create records), deleting, and any bulk operation.
import { parseDecimal, format, ONE, ZERO } from './daftra-money.mjs';
import { hashRequest } from './daftra-canonical.mjs';

export const CATALOG_TYPES = Object.freeze({
  product_create:  { resource: 'products',           method: 'POST', endpoint: '/api2/products.json',           verb: 'create product' },
  product_update:  { resource: 'products',           method: 'PUT',  pathFor: (id) => '/api2/products/' + id + '.json',           verb: 'update product' },
  category_create: { resource: 'product_categories', method: 'POST', endpoint: '/api2/product_categories.json', verb: 'create product category' },
  category_update: { resource: 'product_categories', method: 'PUT',  pathFor: (id) => '/api2/product_categories/' + id + '.json', verb: 'update product category' },
});

export const PRODUCT_FIELDS = Object.freeze(['name', 'type', 'product_code', 'barcode', 'description', 'notes', 'unit_price', 'buy_price',
  'minimum_price', 'profit_margin', 'discount', 'discount_type', 'tax1', 'tax2', 'supplier_id', 'categories_id', 'tags', 'status',
  'availabe_online', 'duration_minutes']);                       // `availabe_online` is spelled that way in the API
export const CATEGORY_FIELDS = Object.freeze(['name', 'category_type', 'parent_id', 'description', 'display_order']);
const PRICE_FIELDS = ['unit_price', 'buy_price', 'minimum_price', 'discount', 'profit_margin'];
const UNSUPPORTED = new Set(['track_stock', 'tracking_type', 'initial_stock_level', 'store_id', 'low_stock_thershold', 'low_stock_threshold',
  'brand', 'category', 'ProductBundle', 'bundle', 'stock', 'stock_balance', 'id', 'created', 'modified', 'staff_id', 'branch_id']);

const ID = /^[1-9]\d{0,14}$/;
const CODE = /^[\p{L}\p{N}._\/ -]{1,50}$/u;
const BARCODE = /^[A-Za-z0-9._-]{5,50}$/;                    // docs: unique, at least 5 characters

function id(v, f) { const s = String(v); if (!ID.test(s)) throw Error(f + ' invalid'); return s; }
function text(v, f, max, { multiline = false } = {}) {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw Error('Invalid ' + f);
  const bad = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/ : /[\u0000-\u001f]/;
  if (bad.test(v)) throw Error('Invalid ' + f);
  return v.trim();
}
const dec = (v, f) => parseDecimal(v, f, { maxDecimals: 4 });
const trimmed = (units) => format(units, 4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

// Normalise one product field to the value that goes into the request body.
function productValue(field, v, ctx) {
  switch (field) {
    case 'name': return text(v, 'name', 255);
    case 'type': if (![1, 2, '1', '2'].includes(v)) throw Error('type must be 1 (product) or 2 (service); bundles are not supported'); return Number(v);
    case 'product_code': if (typeof v !== 'string' || !CODE.test(v.trim())) throw Error('Invalid product_code'); return v.trim();
    case 'barcode': if (typeof v !== 'string' || !BARCODE.test(v)) throw Error('barcode must be 5-50 characters (letters, digits, . _ -)'); return v;
    case 'description': return text(v, 'description', 100000, { multiline: true });
    case 'notes': return text(v, 'notes', 5000, { multiline: true });
    case 'unit_price': case 'buy_price': case 'minimum_price': case 'profit_margin': {
      const u = dec(v, field); ctx.units[field] = u; return trimmed(u);
    }
    case 'discount': { const u = dec(v, field); ctx.units.discount = u; return trimmed(u); }
    case 'discount_type': if (![1, 2, '1', '2'].includes(v)) throw Error('discount_type must be 1 (percentage) or 2 (absolute)'); return Number(v);
    case 'tax1': case 'tax2': return Number(id(v, field));
    case 'supplier_id': return Number(id(v, field));
    case 'categories_id': {
      if (!Array.isArray(v) || !v.length || v.length > 20) throw Error('categories_id must be 1-20 category ids');
      const ids = v.map((x) => Number(id(x, 'categories_id')));
      if (new Set(ids).size !== ids.length) throw Error('categories_id has duplicates');
      return ids;
    }
    case 'tags': {
      const s = Array.isArray(v) ? v.map((x) => text(String(x), 'tag', 50)).join(', ') : v;
      return text(s, 'tags', 500);
    }
    case 'status': if (![0, 1, 2, '0', '1', '2'].includes(v)) throw Error('status must be 0 (active), 1 (inactive) or 2 (suspended)'); return Number(v);
    case 'availabe_online': if (![0, 1, '0', '1'].includes(v)) throw Error('availabe_online must be 0 or 1'); return Number(v);
    case 'duration_minutes': { const u = parseDecimal(v, field, { maxDecimals: 2, maxIntegerDigits: 6 }); return trimmed(u); }
    default: throw Error('Unsupported product field: ' + field);
  }
}

function checkFieldNames(fields, allowed, label) {
  for (const k of fields) {
    if (UNSUPPORTED.has(k)) throw Error(label + ' field "' + k + '" is not supported by this skill (stock/inventory effects, auto-created records or read-only data)');
    if (!allowed.includes(k)) throw Error('Unknown ' + label + ' field: ' + k);
  }
}

function crossChecks(body, ctx, warnings) {
  if (body.discount !== undefined && body.discount_type === undefined) throw Error('discount requires discount_type');
  if (body.discount_type === 1 && ctx.units.discount > 100n * ONE) throw Error('percentage discount cannot exceed 100');
  if (body.type === 1 && body.duration_minutes !== undefined) warnings.push('duration_minutes only applies to services');
  if (ctx.units.minimum_price !== undefined && ctx.units.unit_price !== undefined && ctx.units.minimum_price > ctx.units.unit_price)
    warnings.push('minimum_price is above unit_price');
}

const num = (v) => { try { return parseDecimal(String(v), 'n', { maxDecimals: 6 }); } catch { return null; } };

function priceChanges(changes) {
  const out = [];
  for (const c of changes) {
    if (!PRICE_FIELDS.includes(c.field)) continue;
    const from = num(c.from); const to = num(c.to);
    let pct = null;
    if (from !== null && to !== null && from > ZERO) pct = Math.round(Number(to - from) / Number(from) * 10000) / 100;   // display only
    out.push({ field: c.field, from: c.from ?? null, to: c.to, change_percent: pct });
  }
  return out;
}

export function prepareCatalogAction(type, input, options = {}) {
  if (!Object.hasOwn(CATALOG_TYPES, type)) throw Error('Unsupported catalog action');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid input');
  const spec = CATALOG_TYPES[type];
  const warnings = []; const ctx = { units: {} };
  let body; let path = spec.endpoint; let target; let changes = []; let effects;

  if (type === 'product_create') {
    const fields = Object.keys(input).filter((k) => input[k] !== undefined && !['acknowledge_duplicates', 'allow_zero_price'].includes(k));
    checkFieldNames(fields, PRODUCT_FIELDS, 'product');
    for (const need of ['name', 'unit_price', 'tax1']) if (input[need] === undefined)
      throw Error(need + ' is required' + (need === 'tax1' ? ' (explicit tax id: otherwise Daftra applies the account default silently)' : ''));
    const product = {};
    for (const f of fields) product[f] = productValue(f, input[f], ctx);
    if (ctx.units.unit_price === ZERO && input.allow_zero_price !== true) throw Error('unit_price is 0; pass allow_zero_price:true if that is intended');
    crossChecks(product, ctx, warnings);
    body = { Product: product };
    changes = Object.entries(product).map(([field, to]) => ({ field, from: null, to }));
    effects = ['creates_product'];
  } else if (type === 'product_update') {
    const targetId = id(input.product_id, 'product_id'); target = targetId;
    if (!input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes)) throw Error('changes must be an object of fields to modify');
    const fields = Object.keys(input.changes).filter((k) => input.changes[k] !== undefined);
    if (!fields.length) throw Error('changes is empty');
    checkFieldNames(fields, PRODUCT_FIELDS, 'product');
    const product = {};
    for (const f of fields) product[f] = productValue(f, input.changes[f], ctx);
    crossChecks(product, ctx, warnings);
    const current = options.current;
    if (current && typeof current === 'object') {
      for (const f of Object.keys(product)) {
        const cur = current[f];
        const same = Array.isArray(product[f]) ? false
          : (num(cur) !== null && num(product[f]) !== null ? num(cur) === num(product[f]) : String(cur ?? '') === String(product[f]));
        if (same) delete product[f];
        else changes.push({ field: f, from: cur === undefined ? '(not returned by Daftra)' : cur, to: product[f] });
      }
      for (const f of fields) if (Array.isArray(input.changes[f]) || f === 'categories_id') {
        if (product[f] !== undefined) changes.push({ field: f, from: current.categories_id ?? '(not returned by Daftra)', to: product[f] });
      }
      changes = changes.filter((c, i) => changes.findIndex((d) => d.field === c.field) === i);
      if (!Object.keys(product).length) throw Error('No changes: the product already has these values');
    } else {
      changes = Object.entries(product).map(([field, to]) => ({ field, from: '(current value not loaded)', to }));
      warnings.push('Current product not loaded: unchanged fields were not filtered out');
    }
    if (product.unit_price !== undefined && ctx.units.unit_price === ZERO && input.allow_zero_price !== true) throw Error('unit_price would become 0; pass allow_zero_price:true if that is intended');
    body = { Product: product };
    path = spec.pathFor(targetId);
    effects = ['modifies_product'];
  } else if (type === 'category_create') {
    const fields = Object.keys(input).filter((k) => k !== 'acknowledge_duplicates');
    checkFieldNames(fields, CATEGORY_FIELDS.filter((f) => f !== 'category_type'), 'category');
    if (input.name === undefined) throw Error('name is required');
    const category = { name: text(input.name, 'name', 100), category_type: 1 };
    if (input.parent_id !== undefined) category.parent_id = input.parent_id === 0 || input.parent_id === '0' ? 0 : Number(id(input.parent_id, 'parent_id'));
    if (input.description !== undefined) category.description = text(input.description, 'description', 1000, { multiline: true });
    if (input.display_order !== undefined) {
      if (!/^\d{1,4}$/.test(String(input.display_order))) throw Error('display_order must be 0-9999');
      category.display_order = Number(input.display_order);
    }
    body = { Category: category };
    changes = Object.entries(category).map(([field, to]) => ({ field, from: null, to }));
    effects = ['creates_product_category'];
  } else {
    const targetId = id(input.category_id, 'category_id'); target = targetId;
    if (!input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes) || !Object.keys(input.changes).length) throw Error('changes must be a non-empty object');
    const fields = Object.keys(input.changes);
    checkFieldNames(fields, CATEGORY_FIELDS.filter((f) => f !== 'category_type'), 'category');
    const category = {};
    for (const f of fields) {
      const v = input.changes[f];
      if (f === 'name') category.name = text(v, 'name', 100);
      else if (f === 'parent_id') category.parent_id = v === 0 || v === '0' ? 0 : Number(id(v, 'parent_id'));
      else if (f === 'description') category.description = text(v, 'description', 1000, { multiline: true });
      else if (f === 'display_order') { if (!/^\d{1,4}$/.test(String(v))) throw Error('display_order must be 0-9999'); category.display_order = Number(v); }
    }
    if (category.parent_id !== undefined && String(category.parent_id) === targetId) throw Error('A category cannot be its own parent');
    const current = options.current;
    if (current) {
      for (const f of Object.keys(category)) {
        if (String(current[f] ?? '') === String(category[f])) delete category[f];
        else changes.push({ field: f, from: current[f] ?? '(not returned by Daftra)', to: category[f] });
      }
      if (!Object.keys(category).length) throw Error('No changes: the category already has these values');
    } else {
      changes = Object.entries(category).map(([field, to]) => ({ field, from: '(current value not loaded)', to }));
    }
    body = { Category: category };
    path = spec.pathFor(targetId);
    effects = ['modifies_product_category'];
  }

  const request = { method: spec.method, path, query: '', body };
  return Object.freeze({
    type, resource: spec.resource, mode: 'final', target_id: target, changes, price_changes: priceChanges(changes),
    categories_id: body.Product?.categories_id, tax_ids: [body.Product?.tax1, body.Product?.tax2].filter((x) => x !== undefined),
    supplier_id: body.Product?.supplier_id !== undefined ? String(body.Product.supplier_id) : undefined,
    parent_id: body.Category?.parent_id,
    totals: null, effects,
    reversible: spec.method === 'PUT' ? 'edit again to restore the previous values (listed in the preview)' : 'no delete is available through this skill; remove in Daftra',
    warnings, request, request_hash: hashRequest(request),
    status: 'PREVIEW_ONLY_NOT_SUBMITTED', canSubmit: false, requiresExplicitApproval: true,
  });
}
