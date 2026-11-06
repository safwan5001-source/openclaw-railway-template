// Exact decimal arithmetic for money. No floating point is ever used for amounts.
// Internal unit: BigInt micro-units (1e-6). Inputs are decimal strings/numbers; outputs are strings.
const SCALE = 6;
const ONE = 10n ** BigInt(SCALE);

// Parse a non-negative decimal with at most `maxDecimals` fractional digits into micro-units.
export function parseDecimal(value, field, { maxDecimals = 4, maxIntegerDigits = 12 } = {}) {
  const s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value;
  if (typeof s !== 'string' || !/^(0|[1-9]\d*)(\.\d+)?$/.test(s) || /e/i.test(s)) throw Error(field + ' must be a plain non-negative decimal');
  const [whole, frac = ''] = s.split('.');
  if (whole.length > maxIntegerDigits) throw Error(field + ' is too large');
  if (frac.length > maxDecimals) throw Error(field + ' allows at most ' + maxDecimals + ' decimal places');
  return BigInt(whole) * ONE + BigInt(frac.padEnd(SCALE, '0'));
}

// Round micro-units half-up to `decimals` places (still returned in micro-units).
export function roundTo(units, decimals = 2) {
  const step = 10n ** BigInt(SCALE - decimals);
  if (units < 0n) return -(((-units + step / 2n) / step) * step); // half away from zero, symmetric
  return ((units + step / 2n) / step) * step;
}

export const mul = (a, b) => (a * b + ONE / 2n) / ONE;
export const div = (a, b) => (a * ONE + b / 2n) / b;

export function format(units, decimals = 2) {
  const r = roundTo(units, decimals);
  if (r < 0n) return '-' + format(-r, decimals);
  const whole = r / ONE;
  const frac = (r % ONE).toString().padStart(SCALE, '0').slice(0, decimals);
  return decimals ? whole + '.' + frac : String(whole);
}

export const ZERO = 0n;
export { ONE };
