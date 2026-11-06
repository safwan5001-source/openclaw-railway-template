// Shared cell-value policy for CSV / XLSX / DOCX / PDF exports.
export const STRICT_NUMBER = /^-?\d+(\.\d+)?$/;
// Plain decimals that survive a float round-trip: no leading zeros (ids like "007"), <= 15 digits.
const SAFE_DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const FORMULA_START = /^[\s\u0000-\u001f\u007f \ufeff]*[=+@-]/u;

export function cellString(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

// Spreadsheet formula injection: neutralise text a spreadsheet could execute, but never corrupt
// genuine numbers such as a negative amount "-120.50".
export function protectFormula(text) {
  return FORMULA_START.test(text) && !STRICT_NUMBER.test(text) ? "'" + text : text;
}

export function safeCell(value) {
  return protectFormula(cellString(value));
}

// Returns the numeric literal to store in an XLSX t="n" cell, or null if the value must stay text.
export function numericLiteral(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!SAFE_DECIMAL.test(s) || s.replace(/[-.]/g, '').replace(/^0+/, '').length > 15) return null;
  return s;
}

export function hasArabic(text) {
  return /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-\ufeff]/.test(text);
}

export function detectRtl(title, columns, records) {
  if (hasArabic(String(title ?? '')) || columns.some(hasArabic)) return true;
  return records.slice(0, 50).some((r) => columns.some((c) => hasArabic(cellString(r?.[c]))));
}

// Heuristic only used when the caller does not declare numeric columns. IDs/numbers-as-labels stay text.
export function guessNumericColumns(columns) {
  const numeric = /(^|_)(total|amount|price|balance|paid|unpaid|discount|quantity|qty|subtotal|debit|credit|cost|rate|value)$|^(summary_[a-z_]+|tax\d?|tax_amount)$/;
  return columns.filter((c) => numeric.test(c) && !/(^|_)id$/.test(c));
}
