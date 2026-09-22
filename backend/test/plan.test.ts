import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, checkAlertAgainstPlan } from '../src/domain/plan.ts';

const simple = { condition: { kind: 'price_above' as const, price: 1 }, repeat: false, cooldownMinutes: 60 };

test('free plan caps active alerts and points to upgrade', () => {
  assert.equal(checkAlertAgainstPlan(PLANS.free, 2, simple, true), null);
  const v = checkAlertAgainstPlan(PLANS.free, 3, simple, true);
  assert.equal(v?.code, 'alert_limit');
  assert.equal(v?.upgrade, true);
  assert.equal(checkAlertAgainstPlan(PLANS.free, 3, simple, false), null, 'editing an existing alert does not count');
});

test('free plan locks repeat, percent-change and short cooldowns', () => {
  assert.equal(checkAlertAgainstPlan(PLANS.free, 0, { ...simple, repeat: true }, true)?.code, 'repeat_locked');
  assert.equal(
    checkAlertAgainstPlan(
      PLANS.free,
      0,
      { ...simple, condition: { kind: 'percent_change', percent: 5, windowMinutes: 60, direction: 'up' } },
      true,
    )?.code,
    'condition_locked',
  );
  assert.equal(checkAlertAgainstPlan(PLANS.free, 0, { ...simple, cooldownMinutes: 5 }, true)?.code, 'cooldown_too_short');
});

test('pro plan allows everything up to its own cap', () => {
  const pro = { condition: { kind: 'percent_change' as const, percent: 5, windowMinutes: 60, direction: 'either' as const }, repeat: true, cooldownMinutes: 1 };
  assert.equal(checkAlertAgainstPlan(PLANS.pro, 199, pro, true), null);
  const v = checkAlertAgainstPlan(PLANS.pro, 200, pro, true);
  assert.equal(v?.code, 'alert_limit');
  assert.equal(v?.upgrade, false);
});
