// Trusted identity + change detection for the SOURCE document of an explicit `duplicate` command.
//
// The source is the only record that may be ignored by the remote duplicate scan, and only for a proposal created by
// proposeDuplicate(). Its identity comes from the document Daftra returned (not from the caller's id), is stored in the
// SIGNED proposal meta (`duplicate_of` + `source_fingerprint`), and is re-verified against Daftra right before
// approval/submission: if the source changed, disappeared or cannot be read, the proposal is blocked.
import { createHash } from 'node:crypto';
import { getRecord } from './daftra-readonly.mjs';
import { canonicalJson } from './daftra-canonical.mjs';

export const DUP_SOURCES = Object.freeze({
  invoices:          { type: 'sales_invoice',    header: 'Invoice',       items: 'InvoiceItem',       party: 'client_id' },
  estimates:         { type: 'estimate',         header: 'Estimate',      items: 'InvoiceItem',       party: 'client_id' },
  purchase_invoices: { type: 'purchase_invoice', header: 'PurchaseOrder', items: 'PurchaseOrderItem', party: 'supplier_id' },
});

// Header-level amounts that change a document total and cannot be reproduced by a copy.
export const TOTAL_AFFECTING = ['discount', 'discount_amount', 'summary_discount', 'shipping_amount', 'deposit', 'summary_deposit', 'summary_refund', 'adjustment', 'adjustment_value', 'adjustments'];

// Locate the header and line items inside a single-document payload. The docs show items as a sibling of the
// header for invoices/purchase invoices; for estimates the location is not spelled out, so look in the
// plausible places and fail closed if nothing is found.
export function locate(payload, spec) {
  const data = payload?.data;
  const header = data?.[spec.header] ?? (spec.header === 'Estimate' ? data?.Invoice : undefined);
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw Error('Source response has no ' + spec.header + ' section');
  const candidates = [data?.[spec.items], header?.[spec.items], data?.Invoice?.[spec.items]];
  const items = candidates.find((c) => Array.isArray(c) && c.length);
  if (!items) throw Error('Source has no readable line items; refusing to guess');
  return { header, items };
}

// The trusted id is the one INSIDE the returned document. A response whose id differs from the requested one
// (or has none) is not accepted as the source.
export function trustedSourceId(header, requestedId) {
  const returned = header?.id;
  if (returned === undefined || returned === null || returned === '') throw Error('Source document has no id of its own; its identity cannot be verified');
  if (String(returned) !== String(requestedId)) throw Error('Source identity mismatch: requested ' + String(requestedId) + ' but Daftra returned ' + String(returned));
  return String(returned);
}

const HEADER_FP = ['id', 'no', 'date', 'type', 'client_id', 'supplier_id', 'currency_code', 'notes', 'draft', 'summary_total', ...TOTAL_AFFECTING];
const ITEM_FP = ['item', 'org_name', 'description', 'quantity', 'unit_price', 'tax1', 'tax2', 'discount', 'discount_type', 'product_id'];
const val = (v) => (v === undefined || v === null ? null : String(v));

// Everything that determines (or is shown about) the copy. Payment/settlement state is deliberately NOT included:
// it is never copied, so a payment on the source after the preview does not change the new document.
export function sourceFingerprint(source, header, items) {
  const view = {
    source, header: Object.fromEntries(HEADER_FP.map((k) => [k, val(header[k])])),
    items: items.map((it) => Object.fromEntries(ITEM_FP.map((k) => [k, val(it[k])]))),
  };
  return createHash('sha256').update(canonicalJson(view)).digest('hex');
}

// Re-reads the source and proves it is still exactly what was previewed. Returns { ok, detail }.
export async function verifyDuplicateSource(duplicateOf, expectedType, fingerprint, env, fetcher) {
  const entity = duplicateOf?.entity; const id = duplicateOf?.id;
  if (typeof entity !== 'string' || !Object.hasOwn(DUP_SOURCES, entity) || DUP_SOURCES[entity].type !== expectedType)
    return { ok: false, detail: 'Duplicate source is not valid for this document type' };
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint))
    return { ok: false, detail: 'Duplicate source fingerprint is missing; the source cannot be verified' };
  try {
    const spec = DUP_SOURCES[entity];
    const { header, items } = locate(await getRecord(entity, id, env, fetcher), spec);
    trustedSourceId(header, id);
    if (sourceFingerprint(entity, header, items) !== fingerprint)
      return { ok: false, detail: 'Source ' + entity + '#' + id + ' changed in Daftra since the preview (create a new duplicate proposal)' };
    return { ok: true, detail: 'Source ' + entity + '#' + id + ' unchanged since the preview', entity, id: String(id) };
  } catch (e) {
    return { ok: false, detail: 'Source ' + entity + '#' + id + ' cannot be verified (' + e.message + ')' };
  }
}
