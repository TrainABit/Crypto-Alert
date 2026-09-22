import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertEngine } from '../src/engine/engine.ts';
import { PriceBook } from '../src/domain/price-book.ts';
import { PLANS } from '../src/domain/plan.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { silentLogger } from '../src/logger.ts';
import { RecordingNotifier } from './fakes.ts';
import { T0, minutes } from './helpers.ts';

async function setup(opts: { pushesPerHour?: number } = {}) {
  const store = new MemoryStore();
  const priceBook = new PriceBook({ sampleIntervalMs: 1000 });
  const notifier = new RecordingNotifier();
  let now = T0;
  const engine = new AlertEngine({
    store,
    priceBook,
    notifier,
    logger: silentLogger,
    now: () => now,
    hysteresisPercent: 0.5,
    planFor: (user) => ({ ...PLANS[user.plan], pushesPerHour: opts.pushesPerHour ?? 100 }),
  });
  const user = await store.createUser();
  await store.upsertDevice({ token: 'tok-1', userId: user.id, environment: 'sandbox' });
  const tick = async (price: number, at = now) => {
    now = at;
    await engine.handleTick({ symbol: 'BTC', price, at, source: 'test' });
  };
  return { store, priceBook, notifier, engine, user, tick, setNow: (t: number) => (now = t) };
}

test('a one-shot alert fires once, is delivered and ends as triggered', async () => {
  const { store, notifier, engine, user, tick } = await setup();
  const alert = await store.createAlert({
    userId: user.id, symbol: 'BTC', quote: 'USD', condition: { kind: 'price_above', price: 100 },
    repeat: false, cooldownMinutes: 60, armed: true, note: null,
  });
  await engine.refreshIndex();
  assert.deepEqual(engine.trackedSymbols(), ['BTC']);

  await tick(99);
  assert.equal(notifier.sent.length, 0);
  await tick(100.5, T0 + 1000);
  assert.equal(notifier.sent.length, 1);
  assert.equal(notifier.sent[0]?.target.token, 'tok-1');
  assert.equal(notifier.sent[0]?.payload.title, 'BTC above $100.00');

  const stored = await store.getAlert(alert.id);
  assert.equal(stored?.status, 'triggered');
  assert.equal(stored?.triggerCount, 1);
  assert.equal(stored?.armed, false);
  assert.equal(stored?.lastTriggeredAt?.getTime(), T0 + 1000);
  assert.deepEqual(engine.trackedSymbols(), [], 'triggered alerts leave the index');

  await tick(150, T0 + 2000);
  assert.equal(notifier.sent.length, 1, 'never fires twice');

  const events = await store.listEvents(user.id, 10);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.deliveredCount, 1);
  assert.equal(events[0]?.price, 100.5);
  assert.equal(engine.stats().fired, 1);
});

test('a repeating alert disarms, re-arms after crossing back and honours the cooldown', async () => {
  const { store, notifier, engine, user, tick } = await setup();
  await store.createAlert({
    userId: user.id, symbol: 'BTC', quote: 'USD', condition: { kind: 'price_above', price: 100 },
    repeat: true, cooldownMinutes: 30, armed: true, note: null,
  });
  await engine.refreshIndex();

  await tick(101, T0);
  assert.equal(notifier.sent.length, 1);
  await tick(102, T0 + 1000);
  assert.equal(notifier.sent.length, 1, 'stays disarmed while above');
  await tick(99.8, T0 + 2000);
  await tick(101, T0 + 3000);
  assert.equal(notifier.sent.length, 1, 'a dip inside the hysteresis band does not re-arm');
  await tick(99, T0 + 4000);
  await tick(101, T0 + 5000);
  assert.equal(notifier.sent.length, 1, 're-armed but still inside the cooldown');
  await tick(101, T0 + minutes(31));
  assert.equal(notifier.sent.length, 2, 'fires again after the cooldown');
  const [alert] = await store.listAlerts(user.id);
  assert.equal(alert?.status, 'active');
  assert.equal(alert?.triggerCount, 2);
});

test('percent-change alerts use price history', async () => {
  const { store, notifier, engine, user, tick } = await setup();
  await store.createAlert({
    userId: user.id, symbol: 'BTC', quote: 'USD',
    condition: { kind: 'percent_change', percent: 5, windowMinutes: 60, direction: 'up' },
    repeat: true, cooldownMinutes: 1, armed: true, note: null,
  });
  await engine.refreshIndex();
  await tick(100, T0);
  await tick(104, T0 + minutes(30));
  assert.equal(notifier.sent.length, 0);
  await tick(105.5, T0 + minutes(60));
  assert.equal(notifier.sent.length, 1);
  assert.equal(notifier.sent[0]?.payload.title, 'BTC up 5% in 1 h');
});

test('dead device tokens are forgotten and delivery counts stay honest', async () => {
  const { store, notifier, engine, user, tick } = await setup();
  await store.upsertDevice({ token: 'tok-dead', userId: user.id, environment: 'production' });
  notifier.results.set('tok-dead', { ok: false, status: 410, reason: 'Unregistered', unregister: true, retryable: false });
  await store.createAlert({
    userId: user.id, symbol: 'BTC', quote: 'USD', condition: { kind: 'price_below', price: 50 },
    repeat: false, cooldownMinutes: 60, armed: true, note: null,
  });
  await engine.refreshIndex();
  await tick(49);
  assert.equal(notifier.sent.length, 2);
  const devices = await store.listDevices(user.id);
  assert.deepEqual(devices.map((d) => d.token), ['tok-1']);
  const [event] = await store.listEvents(user.id, 1);
  assert.equal(event?.deliveredCount, 1);
});

test('pushes are throttled per user per hour but alert state still advances', async () => {
  const { store, notifier, engine, user, tick } = await setup({ pushesPerHour: 1 });
  for (const price of [10, 20]) {
    await store.createAlert({
      userId: user.id, symbol: 'BTC', quote: 'USD', condition: { kind: 'price_above', price },
      repeat: false, cooldownMinutes: 60, armed: true, note: null,
    });
  }
  await engine.refreshIndex();
  await tick(25);
  assert.equal(notifier.sent.length, 1);
  assert.equal(engine.stats().rateLimited, 1);
  const alerts = await store.listAlerts(user.id);
  assert.deepEqual(alerts.map((a) => a.status), ['triggered', 'triggered']);
  const events = await store.listEvents(user.id, 10);
  assert.deepEqual(events.map((e) => e.deliveredCount).sort(), [0, 1]);
});

test('index refresh tracks new alerts and announces symbol changes', async () => {
  const { store, engine, user } = await setup();
  const seen: string[][] = [];
  engine.onSymbolsChanged((s) => seen.push(s));
  await engine.refreshIndex();
  await store.createAlert({
    userId: user.id, symbol: 'ETH', quote: 'USD', condition: { kind: 'price_above', price: 1 },
    repeat: false, cooldownMinutes: 60, armed: true, note: null,
  });
  await engine.refreshIndex();
  assert.deepEqual(engine.trackedSymbols(), ['ETH']);
  assert.deepEqual(seen, [['ETH']]);
  await engine.refreshIndex();
  assert.equal(seen.length, 1, 'no announcement when nothing changed');
});

test('paused alerts and deleted users never fire', async () => {
  const { store, notifier, engine, user, tick } = await setup();
  const paused = await store.createAlert({
    userId: user.id, symbol: 'BTC', quote: 'USD', condition: { kind: 'price_above', price: 1 },
    repeat: false, cooldownMinutes: 60, armed: true, note: null,
  });
  await store.updateAlert(paused.id, { status: 'paused' });
  await engine.refreshIndex();
  assert.deepEqual(engine.trackedSymbols(), []);

  await store.updateAlert(paused.id, { status: 'active' });
  await engine.refreshIndex();
  await store.deleteUser(user.id);
  await tick(5);
  assert.equal(notifier.sent.length, 0);
});
