import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecimal, roundTo, mul, div, format, ONE } from './daftra-money.mjs';

test('parseDecimal accepts plain decimals only', () => {
  assert.equal(format(parseDecimal('12.5', 'x')), '12.50');
  assert.equal(format(parseDecimal(0.1, 'x')), '0.10');
  for (const bad of ['', '-1', '1e3', '1,5', ' 1', '01', '.5', '5.', 'NaN', 'Infinity', null, undefined, {}, '1.12345', '1'.repeat(14)])
    assert.throws(() => parseDecimal(bad, 'x'), undefined, String(bad));
  assert.throws(() => parseDecimal(NaN, 'x'));
});
test('rounding is half-up away from zero and symmetric; negatives format correctly', () => {
  assert.equal(format(parseDecimal('0.005', 'x', { maxDecimals: 4 })), '0.01');
  assert.equal(format(-parseDecimal('0.005', 'x', { maxDecimals: 4 })), '-0.01');
  assert.equal(format(-parseDecimal('10', 'x')), '-10.00');
  assert.equal(format(-parseDecimal('0.004', 'x', { maxDecimals: 4 })), '0.00');
  assert.equal(format(-parseDecimal('1234567.891', 'x', { maxDecimals: 4 }), 3), '-1234567.891');
  assert.equal(roundTo(-5000n, 2), -10000n);
  assert.equal(roundTo(-4999n, 2), 0n);
});
test('mul/div keep exactness for money-sized values', () => {
  const a = parseDecimal('1000', 'a'); const b = parseDecimal('1.89', 'b');
  assert.equal(format(mul(a, b)), '1890.00');
  assert.equal(format(div(parseDecimal('115', 'x'), ONE + div(parseDecimal('15', 'x'), 100n * ONE))), '100.00');
});
