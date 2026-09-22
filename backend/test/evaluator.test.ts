import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAlert, type EvaluationInput } from '../src/engine/evaluator.ts';
import { makeAlert, T0, minutes } from './helpers.ts';

const base = (over: Partial<EvaluationInput> = {}): EvaluationInput => ({
  alert: makeAlert(),
  price: 100,
  now: T0,
  changePercent: () => undefined,
  hysteresisPercent: 0.5,
  ...over,
});

test('only active alerts are considered', () => {
  assert.deepEqual(evaluateAlert(base({ alert: makeAlert({ status: 'paused' }), price: 150 })), { action: 'none' });
  assert.deepEqual(evaluateAlert(base({ alert: makeAlert({ status: 'triggered' }), price: 150 })), { action: 'none' });
});

test('price_above fires at or over the target when armed', () => {
  assert.equal(evaluateAlert(base({ price: 99.99 })).action, 'none');
  assert.equal(evaluateAlert(base({ price: 100 })).action, 'fire');
  assert.equal(evaluateAlert(base({ price: 150 })).action, 'fire');
});

test('price_above re-arms only after the price falls below the hysteresis band', () => {
  const alert = makeAlert({ armed: false, repeat: true });
  assert.equal(evaluateAlert(base({ alert, price: 120 })).action, 'none');
  assert.equal(evaluateAlert(base({ alert, price: 99.8 })).action, 'none', 'inside the 0.5% band');
  assert.equal(evaluateAlert(base({ alert, price: 99.4 })).action, 'rearm');
});

test('cooldown blocks a firing but keeps the alert armed', () => {
  const alert = makeAlert({ armed: true, repeat: true, cooldownMinutes: 60, lastTriggeredAt: new Date(T0 - minutes(30)) });
  assert.equal(evaluateAlert(base({ alert, price: 120 })).action, 'none');
  assert.equal(evaluateAlert(base({ alert, price: 120, now: T0 + minutes(31) })).action, 'fire');
});

test('price_below mirrors price_above', () => {
  const alert = makeAlert({ condition: { kind: 'price_below', price: 100 } });
  assert.equal(evaluateAlert(base({ alert, price: 100.01 })).action, 'none');
  assert.equal(evaluateAlert(base({ alert, price: 100 })).action, 'fire');
  const disarmed = makeAlert({ condition: { kind: 'price_below', price: 100 }, armed: false });
  assert.equal(evaluateAlert(base({ alert: disarmed, price: 100.3 })).action, 'none');
  assert.equal(evaluateAlert(base({ alert: disarmed, price: 100.6 })).action, 'rearm');
});

test('percent_change needs history and respects direction', () => {
  const up = makeAlert({ condition: { kind: 'percent_change', percent: 5, windowMinutes: 60, direction: 'up' } });
  assert.equal(evaluateAlert(base({ alert: up })).action, 'none', 'no history');
  assert.equal(evaluateAlert(base({ alert: up, changePercent: () => 4.9 })).action, 'none');
  assert.equal(evaluateAlert(base({ alert: up, changePercent: () => 5 })).action, 'fire');
  assert.equal(evaluateAlert(base({ alert: up, changePercent: () => -8 })).action, 'none', 'wrong direction');

  const down = makeAlert({ condition: { kind: 'percent_change', percent: 5, windowMinutes: 60, direction: 'down' } });
  assert.equal(evaluateAlert(base({ alert: down, changePercent: () => -5.5 })).action, 'fire');
  assert.equal(evaluateAlert(base({ alert: down, changePercent: () => 5.5 })).action, 'none');

  const either = makeAlert({ condition: { kind: 'percent_change', percent: 5, windowMinutes: 60, direction: 'either' } });
  assert.equal(evaluateAlert(base({ alert: either, changePercent: () => -5.5 })).action, 'fire');
  assert.equal(evaluateAlert(base({ alert: either, changePercent: () => 5.5 })).action, 'fire');
});

test('percent_change passes the requested window through and re-arms after a retrace', () => {
  let asked = 0;
  const alert = makeAlert({
    condition: { kind: 'percent_change', percent: 6, windowMinutes: 240, direction: 'up' },
    armed: false,
  });
  const change = (w: number) => {
    asked = w;
    return 4;
  };
  assert.equal(evaluateAlert(base({ alert, changePercent: change })).action, 'none', 'still above half the threshold');
  assert.equal(asked, 240);
  assert.equal(evaluateAlert(base({ alert, changePercent: () => 2.9 })).action, 'rearm');
});
