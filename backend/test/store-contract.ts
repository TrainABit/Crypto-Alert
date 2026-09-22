import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from '../src/store/store.ts';

/** Behavioural contract every Store implementation must satisfy. */
export function storeContract(label: string, make: () => Promise<Store>) {
  test(`${label}: users, sessions and plans`, async () => {
    const store = await make();
    const user = await store.createUser();
    assert.equal(user.plan, 'free');
    assert.equal(user.appleSub, null);
    assert.deepEqual(await store.getUser(user.id), user);
    assert.equal(await store.getUser('00000000-0000-4000-8000-000000000000'), null);

    const token = await store.createSession(user.id);
    assert.equal(await store.getSessionUserId(token), user.id);
    assert.equal(await store.getSessionUserId('nope'), null);

    const linked = await store.linkAppleSub(user.id, 'apple-sub-1');
    assert.equal(linked.appleSub, 'apple-sub-1');
    assert.equal((await store.findUserByAppleSub('apple-sub-1'))?.id, user.id);
    assert.equal(await store.findUserByAppleSub('missing'), null);

    const expires = new Date('2027-01-01T00:00:00Z');
    const pro = await store.updateUserPlan(user.id, 'pro', expires);
    assert.equal(pro.plan, 'pro');
    assert.equal(pro.planExpiresAt?.toISOString(), expires.toISOString());

    await store.deleteSession(token);
    assert.equal(await store.getSessionUserId(token), null);
    await store.close();
  });

  test(`${label}: devices`, async () => {
    const store = await make();
    const user = await store.createUser();
    const d1 = await store.upsertDevice({ token: 'aa11', userId: user.id, environment: 'sandbox', appVersion: '1.0' });
    assert.equal(d1.platform, 'ios');
    await store.upsertDevice({ token: 'aa11', userId: user.id, environment: 'production', appVersion: '1.1' });
    await store.upsertDevice({ token: 'bb22', userId: user.id, environment: 'production' });
    const devices = await store.listDevices(user.id);
    assert.equal(devices.length, 2);
    const first = devices.find((d) => d.token === 'aa11');
    assert.equal(first?.environment, 'production');
    assert.equal(first?.appVersion, '1.1');
    await store.removeDevice('aa11');
    assert.deepEqual((await store.listDevices(user.id)).map((d) => d.token), ['bb22']);
    await store.close();
  });

  test(`${label}: alerts`, async () => {
    const store = await make();
    const user = await store.createUser();
    const other = await store.createUser();
    const a = await store.createAlert({
      userId: user.id, symbol: 'BTC', quote: 'USD', condition: { kind: 'price_above', price: 100 },
      repeat: false, cooldownMinutes: 60, armed: true, note: 'first',
    });
    const b = await store.createAlert({
      userId: user.id, symbol: 'ETH', quote: 'USD',
      condition: { kind: 'percent_change', percent: 5, windowMinutes: 60, direction: 'either' },
      repeat: true, cooldownMinutes: 5, armed: false, note: null,
    });
    await store.createAlert({
      userId: other.id, symbol: 'BTC', quote: 'USD', condition: { kind: 'price_below', price: 1 },
      repeat: false, cooldownMinutes: 60, armed: true, note: null,
    });

    assert.equal(a.status, 'active');
    assert.equal(a.triggerCount, 0);
    assert.deepEqual(b.condition, { kind: 'percent_change', percent: 5, windowMinutes: 60, direction: 'either' });
    assert.deepEqual(await store.getAlert(a.id), a);

    const mine = await store.listAlerts(user.id);
    assert.deepEqual(mine.map((x) => x.id).sort(), [a.id, b.id].sort());
    assert.equal(await store.countActiveAlerts(user.id), 2);
    assert.equal((await store.listActiveAlerts()).length, 3);

    const firedAt = new Date('2026-03-01T12:00:00Z');
    const updated = await store.updateAlert(a.id, { status: 'triggered', armed: false, lastTriggeredAt: firedAt, triggerCount: 1 });
    assert.equal(updated?.status, 'triggered');
    assert.equal(updated?.armed, false);
    assert.equal(updated?.lastTriggeredAt?.toISOString(), firedAt.toISOString());
    assert.equal(updated?.triggerCount, 1);
    assert.equal(await store.countActiveAlerts(user.id), 1);

    const edited = await store.updateAlert(b.id, { condition: { kind: 'price_above', price: 2500 }, repeat: false, cooldownMinutes: 30, note: 'x' });
    assert.deepEqual(edited?.condition, { kind: 'price_above', price: 2500 });
    assert.equal(edited?.repeat, false);
    assert.equal(edited?.cooldownMinutes, 30);
    assert.equal(edited?.note, 'x');
    assert.equal(await store.updateAlert('00000000-0000-4000-8000-000000000000', { armed: true }), null);

    assert.equal(await store.deleteAlert(a.id), true);
    assert.equal(await store.deleteAlert(a.id), false);
    assert.equal(await store.getAlert(a.id), null);
    await store.close();
  });

  test(`${label}: events`, async () => {
    const store = await make();
    const user = await store.createUser();
    const alert = await store.createAlert({
      userId: user.id, symbol: 'BTC', quote: 'USD', condition: { kind: 'price_above', price: 100 },
      repeat: true, cooldownMinutes: 60, armed: true, note: null,
    });
    for (let i = 0; i < 3; i++) {
      await store.recordEvent({
        alertId: alert.id, userId: user.id, symbol: 'BTC', price: 100 + i, title: 't', body: 'b',
        firedAt: new Date(Date.UTC(2026, 0, 1, i)), deliveredCount: i,
      });
    }
    const events = await store.listEvents(user.id, 2);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.price, 102, 'newest first');
    assert.equal(events[0]?.deliveredCount, 2);
    assert.equal(events[0]?.alertId, alert.id);
    await store.deleteAlert(alert.id);
    assert.equal((await store.listEvents(user.id, 10))[0]?.alertId, null, 'events outlive their alert');
    await store.close();
  });

  test(`${label}: subscriptions and account deletion`, async () => {
    const store = await make();
    const user = await store.createUser();
    const expires = new Date('2027-06-01T00:00:00Z');
    const sub = await store.upsertSubscription({
      originalTransactionId: 'otx-1', userId: user.id, productId: 'pro.monthly', environment: 'Sandbox', status: 'active', expiresAt: expires,
    });
    assert.equal(sub.status, 'active');
    await store.upsertSubscription({ ...sub, status: 'expired' });
    assert.equal((await store.findSubscription('otx-1'))?.status, 'expired');
    await store.upsertSubscription({
      originalTransactionId: 'otx-2', userId: user.id, productId: 'pro.lifetime', environment: 'Sandbox', status: 'active', expiresAt: null,
    });
    assert.equal((await store.listSubscriptions(user.id)).length, 2);
    assert.equal(await store.findSubscription('missing'), null);

    const token = await store.createSession(user.id);
    await store.upsertDevice({ token: 'cc33', userId: user.id, environment: 'sandbox' });
    const alert = await store.createAlert({
      userId: user.id, symbol: 'BTC', quote: 'USD', condition: { kind: 'price_above', price: 1 },
      repeat: false, cooldownMinutes: 60, armed: true, note: null,
    });
    await store.recordEvent({ alertId: alert.id, userId: user.id, symbol: 'BTC', price: 2, title: 't', body: 'b', firedAt: new Date(), deliveredCount: 1 });

    await store.deleteUser(user.id);
    assert.equal(await store.getUser(user.id), null);
    assert.equal(await store.getSessionUserId(token), null);
    assert.deepEqual(await store.listDevices(user.id), []);
    assert.deepEqual(await store.listAlerts(user.id), []);
    assert.deepEqual(await store.listEvents(user.id, 10), []);
    assert.deepEqual(await store.listSubscriptions(user.id), []);
    assert.equal(await store.findSubscription('otx-2'), null);
    await store.close();
  });
}
