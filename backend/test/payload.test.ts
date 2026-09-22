import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAlertPush, buildApnsBody } from '../src/push/payload.ts';
import { makeAlert } from './helpers.ts';

test('buildAlertPush writes a readable title and body', () => {
  const alert = makeAlert({ condition: { kind: 'price_above', price: 65000 } });
  const push = buildAlertPush({ alert, price: 65120.5, change24h: 2.345 });
  assert.equal(push.title, 'BTC above $65,000');
  assert.equal(push.body, 'BTC is now $65,121 · +2.35% in 24 h · Alert done');
  assert.equal(push.threadId, 'BTC');
  assert.equal(push.collapseId, alert.id);
  assert.equal(push.interruptionLevel, 'time-sensitive');
  assert.equal(push.data.alertId, alert.id);
  assert.equal(push.data.kind, 'price_above');
});

test('repeating alerts do not announce completion and missing history is skipped', () => {
  const alert = makeAlert({ repeat: true, condition: { kind: 'price_below', price: 0.5 } });
  const push = buildAlertPush({ alert, price: 0.4321 });
  assert.equal(push.body, 'BTC is now $0.4321');
});

test('buildApnsBody produces the aps dictionary APNs expects', () => {
  const push = buildAlertPush({ alert: makeAlert(), price: 101 });
  const body = buildApnsBody(push) as { aps: Record<string, unknown>; alertId: string };
  assert.deepEqual(body.aps.alert, { title: push.title, body: push.body });
  assert.equal(body.aps.sound, 'default');
  assert.equal(body.aps['interruption-level'], 'time-sensitive');
  assert.equal(body.aps['mutable-content'], 1);
  assert.equal(body.aps.category, 'PRICE_ALERT');
  assert.equal(body.alertId, push.data.alertId);
});
