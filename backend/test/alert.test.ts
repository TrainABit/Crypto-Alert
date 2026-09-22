import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAlertSchema,
  describeCondition,
  initialArmedState,
  serializeAlert,
  updateAlertSchema,
} from '../src/domain/alert.ts';
import { makeAlert } from './helpers.ts';

test('createAlertSchema applies defaults and normalises the symbol', () => {
  const parsed = createAlertSchema.parse({ symbol: ' btc ', condition: { kind: 'price_above', price: 50000 } });
  assert.equal(parsed.symbol, 'BTC');
  assert.equal(parsed.repeat, false);
  assert.equal(parsed.cooldownMinutes, 60);
  assert.equal(parsed.note, null);
});

test('createAlertSchema rejects bad input', () => {
  assert.equal(createAlertSchema.safeParse({ symbol: 'BTC/USD', condition: { kind: 'price_above', price: 1 } }).success, false);
  assert.equal(createAlertSchema.safeParse({ symbol: 'BTC', condition: { kind: 'price_above', price: -1 } }).success, false);
  assert.equal(createAlertSchema.safeParse({ symbol: 'BTC', condition: { kind: 'nope' } }).success, false);
  assert.equal(
    createAlertSchema.safeParse({
      symbol: 'BTC',
      condition: { kind: 'percent_change', percent: 5, windowMinutes: 0, direction: 'up' },
    }).success,
    false,
  );
});

test('updateAlertSchema needs at least one known field', () => {
  assert.equal(updateAlertSchema.safeParse({}).success, false);
  assert.equal(updateAlertSchema.safeParse({ bogus: 1 }).success, false);
  assert.equal(updateAlertSchema.safeParse({ status: 'triggered' }).success, false);
  assert.equal(updateAlertSchema.safeParse({ status: 'paused' }).success, true);
});

test('describeCondition reads naturally', () => {
  assert.equal(describeCondition('BTC', { kind: 'price_above', price: 65000 }), 'BTC above $65,000');
  assert.equal(describeCondition('ETH', { kind: 'price_below', price: 1999.5 }), 'ETH below $1,999.50');
  assert.equal(
    describeCondition('SOL', { kind: 'percent_change', percent: 5, windowMinutes: 60, direction: 'up' }),
    'SOL up 5% in 1 h',
  );
  assert.equal(
    describeCondition('SOL', { kind: 'percent_change', percent: 10, windowMinutes: 1440, direction: 'either' }),
    'SOL moves 10% in 1 d',
  );
});

test('initialArmedState disarms alerts whose condition already holds', () => {
  assert.equal(initialArmedState({ kind: 'price_above', price: 100 }, 90), true);
  assert.equal(initialArmedState({ kind: 'price_above', price: 100 }, 110), false);
  assert.equal(initialArmedState({ kind: 'price_below', price: 100 }, 110), true);
  assert.equal(initialArmedState({ kind: 'price_below', price: 100 }, 90), false);
  assert.equal(initialArmedState({ kind: 'price_above', price: 100 }, undefined), true);
  assert.equal(initialArmedState({ kind: 'percent_change', percent: 5, windowMinutes: 60, direction: 'up' }, 1), true);
});

test('serializeAlert emits ISO dates and a title', () => {
  const alert = makeAlert({ lastTriggeredAt: new Date('2026-02-01T10:00:00Z') });
  const json = serializeAlert(alert);
  assert.equal(json.title, 'BTC above $100.00');
  assert.equal(json.lastTriggeredAt, '2026-02-01T10:00:00.000Z');
  assert.equal(json.createdAt, '2026-01-01T00:00:00.000Z');
});
