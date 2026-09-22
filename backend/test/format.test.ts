import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMinutes, formatPercent, formatPrice } from '../src/domain/format.ts';

test('formatPrice adapts decimals to magnitude', () => {
  assert.equal(formatPrice(65123.456), '$65,123');
  assert.equal(formatPrice(1234.5), '$1,234.50');
  assert.equal(formatPrice(0.1234), '$0.1234');
  assert.equal(formatPrice(0.00001234), '$0.00001234');
  assert.equal(formatPrice(Number.NaN), '—');
});

test('formatPercent carries a sign', () => {
  assert.equal(formatPercent(2.5), '+2.5%');
  assert.equal(formatPercent(-0.754), '-0.75%');
  assert.equal(formatPercent(0), '0%');
});

test('formatMinutes picks the largest clean unit', () => {
  assert.equal(formatMinutes(45), '45 min');
  assert.equal(formatMinutes(60), '1 h');
  assert.equal(formatMinutes(90), '1.5 h');
  assert.equal(formatMinutes(1440), '1 d');
});
