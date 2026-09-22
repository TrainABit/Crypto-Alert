import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api/app.ts';
import type { AppleIdTokenVerifier } from '../src/api/apple-auth.ts';
import { AppleAuthError } from '../src/api/apple-auth.ts';
import { EntitlementService } from '../src/billing/entitlements.ts';
import { VerificationError, type AppStoreVerifier, type VerifiedNotification, type VerifiedTransaction } from '../src/billing/verifier.ts';
import { PriceBook, type PriceTick } from '../src/domain/price-book.ts';
import { AlertEngine } from '../src/engine/engine.ts';
import { silentLogger } from '../src/logger.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { RecordingNotifier } from './fakes.ts';
import { T0 } from './helpers.ts';

const NOW = new Date(T0);
const PRO = ['pro.monthly', 'pro.yearly', 'pro.lifetime'];

/** Test doubles: "jws" strings are JSON, Apple tokens are "apple:<sub>". */
const fakeVerifier: AppStoreVerifier = {
  async verifyTransaction(jws) {
    if (!jws.startsWith('{')) throw new VerificationError('VERIFICATION_FAILURE', 'bad signature');
    const raw = JSON.parse(jws) as Partial<VerifiedTransaction> & { expiresDate?: string | null };
    return {
      originalTransactionId: raw.originalTransactionId ?? 'otx',
      transactionId: raw.transactionId ?? 'tx',
      productId: raw.productId ?? 'pro.monthly',
      bundleId: raw.bundleId ?? 'com.example.app',
      type: raw.type ?? 'auto_renewable',
      purchaseDate: NOW,
      expiresDate: raw.expiresDate === null ? null : new Date(raw.expiresDate ?? '2027-01-01T00:00:00Z'),
      revocationDate: null,
      environment: 'Sandbox',
      appAccountToken: raw.appAccountToken ?? null,
    };
  },
  async verifyNotification(signedPayload) {
    if (!signedPayload.startsWith('{')) throw new VerificationError('VERIFICATION_FAILURE', 'bad signature');
    const raw = JSON.parse(signedPayload) as { type: string; transaction?: string };
    const transaction = raw.transaction ? await this.verifyTransaction(raw.transaction) : null;
    const n: VerifiedNotification = { notificationType: raw.type, subtype: null, environment: 'Sandbox', transaction, renewalInfo: null };
    return n;
  },
};

/** Fake identity tokens look like "apple:<sub>:<padding>" so they pass the length check. */
const appleToken = (sub: string) => `apple:${sub}:${'x'.repeat(24)}`;
const fakeApple: AppleIdTokenVerifier = {
  async verify(token) {
    const [prefix, sub] = token.split(':');
    if (prefix !== 'apple' || !sub) throw new AppleAuthError('invalid signature');
    return { sub, email: null };
  },
};

function setup() {
  const store = new MemoryStore();
  const priceBook = new PriceBook();
  priceBook.update({ symbol: 'BTC', price: 60_000, at: T0 - 1000, source: 'test' });
  const engine = new AlertEngine({ store, priceBook, notifier: new RecordingNotifier(), logger: silentLogger, now: () => T0, invalidateDelayMs: 1 });
  const quotes = new Map<string, number>([['ETH', 2500]]);
  const quoteCalls: string[] = [];
  const prices = {
    supports: (s: string) => ['BTC', 'ETH', 'SOL'].includes(s),
    quote: async (s: string): Promise<PriceTick | undefined> => {
      quoteCalls.push(s);
      const price = quotes.get(s);
      return price ? { symbol: s, price, at: T0, source: 'quote' } : undefined;
    },
  };
  const entitlements = new EntitlementService(store, PRO, silentLogger, () => NOW);
  const app = createApp({
    store, engine, priceBook, prices, entitlements, logger: silentLogger,
    appleAuth: fakeApple, verifier: fakeVerifier, appStoreBundleId: 'com.example.app', now: () => NOW,
  });
  const call = async (path: string, init: { method?: string; token?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(path, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
  };
  const signUp = async () => {
    const r = await call('/v1/auth/anonymous', { method: 'POST' });
    assert.equal(r.status, 201);
    return r.body.token as string;
  };
  return { store, engine, app, call, signUp, quoteCalls };
}

test('anonymous sign-up, me, logout and account deletion', async () => {
  const { call, signUp } = setup();
  const token = await signUp();
  const me = await call('/v1/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.plan, 'free');
  assert.equal(me.body.limits.maxActiveAlerts, 3);
  assert.deepEqual(me.body.counts, { activeAlerts: 0, devices: 0 });

  assert.equal((await call('/v1/me')).status, 401);
  assert.equal((await call('/v1/me', { token: 'bogus' })).status, 401);

  assert.equal((await call('/v1/auth/logout', { method: 'POST', token })).status, 204);
  assert.equal((await call('/v1/me', { token })).status, 401);

  const token2 = await signUp();
  assert.equal((await call('/v1/me', { method: 'DELETE', token: token2 })).status, 204);
  assert.equal((await call('/v1/me', { token: token2 })).status, 401);
});

test('alerts: create, plan limits, edit, pause, ownership and delete', async () => {
  const { call, signUp, quoteCalls } = setup();
  const token = await signUp();

  const created = await call('/v1/alerts', { method: 'POST', token, body: { symbol: 'btc', condition: { kind: 'price_above', price: 50_000 } } });
  assert.equal(created.status, 201);
  assert.equal(created.body.alert.symbol, 'BTC');
  assert.equal(created.body.alert.armed, false, 'BTC already trades above 50k');
  assert.equal(created.body.alert.title, 'BTC above $50,000');
  assert.equal(created.body.currentPrice.price, 60_000);
  assert.deepEqual(quoteCalls, [], 'fresh price book entry needs no quote');

  const eth = await call('/v1/alerts', { method: 'POST', token, body: { symbol: 'ETH', condition: { kind: 'price_below', price: 2000 } } });
  assert.equal(eth.status, 201);
  assert.equal(eth.body.alert.armed, true);
  assert.deepEqual(quoteCalls, ['ETH'], 'unknown symbol is quoted on demand');

  assert.equal((await call('/v1/alerts', { method: 'POST', token, body: { symbol: 'DOGE', condition: { kind: 'price_above', price: 1 } } })).status, 422);
  assert.equal((await call('/v1/alerts', { method: 'POST', token, body: { symbol: 'BTC' } })).status, 422);

  const locked = await call('/v1/alerts', { method: 'POST', token, body: { symbol: 'BTC', condition: { kind: 'price_above', price: 1 }, repeat: true } });
  assert.equal(locked.status, 402);
  assert.equal(locked.body.error.code, 'repeat_locked');
  assert.equal(locked.body.error.upgrade, true);

  assert.equal((await call('/v1/alerts', { method: 'POST', token, body: { symbol: 'SOL', condition: { kind: 'price_above', price: 1 } } })).status, 201);
  const limit = await call('/v1/alerts', { method: 'POST', token, body: { symbol: 'SOL', condition: { kind: 'price_above', price: 2 } } });
  assert.equal(limit.status, 402);
  assert.equal(limit.body.error.code, 'alert_limit');

  const list = await call('/v1/alerts', { token });
  assert.equal(list.body.alerts.length, 3);

  const id = created.body.alert.id as string;
  const paused = await call(`/v1/alerts/${id}`, { method: 'PATCH', token, body: { status: 'paused' } });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.alert.status, 'paused');
  assert.equal((await call('/v1/alerts', { method: 'POST', token, body: { symbol: 'SOL', condition: { kind: 'price_above', price: 2 } } })).status, 201, 'pausing frees a slot');
  const resume = await call(`/v1/alerts/${id}`, { method: 'PATCH', token, body: { status: 'active' } });
  assert.equal(resume.status, 402, 'resuming needs a free slot');

  const edited = await call(`/v1/alerts/${id}`, { method: 'PATCH', token, body: { condition: { kind: 'price_above', price: 70_000 }, note: 'moon' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.alert.armed, true, 're-armed for the new target');
  assert.equal(edited.body.alert.note, 'moon');
  assert.equal((await call(`/v1/alerts/${id}`, { method: 'PATCH', token, body: {} })).status, 422);

  const stranger = await signUp();
  assert.equal((await call(`/v1/alerts/${id}`, { token: stranger, method: 'DELETE' })).status, 404);
  assert.equal((await call(`/v1/alerts/${id}`, { token: stranger, method: 'PATCH', body: { note: 'x' } })).status, 404);
  assert.equal((await call(`/v1/alerts/${id}`, { token, method: 'DELETE' })).status, 204);
  assert.equal((await call(`/v1/alerts/${id}`, { token, method: 'DELETE' })).status, 404);
});

test('devices, prices, symbols and events', async () => {
  const { call, signUp, store } = setup();
  const token = await signUp();
  const hex = 'ab'.repeat(32);
  const dev = await call('/v1/devices', { method: 'PUT', token, body: { token: hex.toUpperCase(), environment: 'sandbox', appVersion: '1.0.0' } });
  assert.equal(dev.status, 200);
  assert.equal(dev.body.device.token, hex);
  assert.equal((await call('/v1/devices', { method: 'PUT', token, body: { token: 'zz', environment: 'sandbox' } })).status, 422);
  assert.equal((await call('/v1/me', { token })).body.counts.devices, 1);
  assert.equal((await call(`/v1/devices/${hex}`, { method: 'DELETE', token })).status, 204);
  assert.equal((await call(`/v1/devices/${hex}`, { method: 'DELETE', token })).status, 404);

  const prices = await call('/v1/prices?symbols=btc,ETH,DOGE,SOL,BTC', { token });
  assert.equal(prices.status, 200);
  assert.equal(prices.body.prices.BTC.price, 60_000);
  assert.equal(prices.body.prices.ETH.price, 2500);
  assert.equal(prices.body.prices.DOGE, null, 'unsupported');
  assert.equal(prices.body.prices.SOL, null, 'supported but no quote available');

  const symbols = await call('/v1/symbols');
  assert.equal(symbols.status, 200);
  assert.equal(symbols.body.symbols.find((s: any) => s.symbol === 'BTC').supported, true);
  assert.equal(symbols.body.symbols.find((s: any) => s.symbol === 'DOGE').supported, false);

  const me = await call('/v1/me', { token });
  await store.recordEvent({ alertId: null, userId: me.body.user.id, symbol: 'BTC', price: 1, title: 't', body: 'b', firedAt: NOW, deliveredCount: 1 });
  const events = await call('/v1/alerts/events?limit=5', { token });
  assert.equal(events.body.events.length, 1);
  assert.equal(events.body.events[0].delivered, true);
});

test('Sign in with Apple links, merges and re-uses accounts', async () => {
  const { call, signUp } = setup();
  // Anonymous user with an alert links their Apple id.
  const anon = await signUp();
  await call('/v1/alerts', { method: 'POST', token: anon, body: { symbol: 'BTC', condition: { kind: 'price_above', price: 1 } } });
  const linked = await call('/v1/auth/apple', { method: 'POST', token: anon, body: { identityToken: appleToken('sub-A') } });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.user.appleLinked, true);
  const meA = await call('/v1/me', { token: linked.body.token });
  assert.equal(meA.body.counts.activeAlerts, 1);

  // Same Apple id on a fresh install: the anonymous account merges into the real one.
  const fresh = await signUp();
  await call('/v1/alerts', { method: 'POST', token: fresh, body: { symbol: 'ETH', condition: { kind: 'price_above', price: 1 } } });
  const merged = await call('/v1/auth/apple', { method: 'POST', token: fresh, body: { identityToken: appleToken('sub-A') } });
  assert.equal(merged.body.user.id, meA.body.user.id);
  assert.equal((await call('/v1/me', { token: merged.body.token })).body.counts.activeAlerts, 2);
  assert.equal((await call('/v1/me', { token: fresh })).status, 401, 'the anonymous account is gone');

  // Sign in without any session at all.
  const direct = await call('/v1/auth/apple', { method: 'POST', body: { identityToken: appleToken('sub-B') } });
  assert.equal(direct.status, 200);
  assert.equal(direct.body.user.appleLinked, true);
  assert.notEqual(direct.body.user.id, meA.body.user.id);

  assert.equal((await call('/v1/auth/apple', { method: 'POST', body: { identityToken: 'garbage-token-value-long' } })).status, 401);
});

test('billing: transactions upgrade, expiry downgrades, notifications map by appAccountToken', async () => {
  const { call, signUp } = setup();
  const token = await signUp();
  const me = await call('/v1/me', { token });
  const userId = me.body.user.id as string;

  assert.equal((await call('/v1/billing/transactions', { method: 'POST', token, body: { jws: 'not-a-real-jws-string-value' } })).status, 400);
  const wrongApp = await call('/v1/billing/transactions', { method: 'POST', token, body: { jws: JSON.stringify({ bundleId: 'com.other.app' }) } });
  assert.equal(wrongApp.status, 400);

  const pro = await call('/v1/billing/transactions', { method: 'POST', token, body: { jws: JSON.stringify({ originalTransactionId: 'otx-1', productId: 'pro.yearly' }) } });
  assert.equal(pro.status, 200);
  assert.equal(pro.body.plan, 'pro');
  assert.equal(pro.body.user.plan, 'pro');
  assert.equal((await call('/v1/me', { token })).body.limits.maxActiveAlerts, 200);

  const status = await call('/v1/billing/status', { token });
  assert.equal(status.body.subscriptions[0].productId, 'pro.yearly');

  const expired = await call('/v1/billing/appstore-notifications', {
    method: 'POST', body: { signedPayload: JSON.stringify({ type: 'EXPIRED', transaction: JSON.stringify({ originalTransactionId: 'otx-1', productId: 'pro.yearly', expiresDate: '2020-01-01T00:00:00Z' }) }) },
  });
  assert.equal(expired.status, 200);
  assert.deepEqual(expired.body, { handled: true });
  assert.equal((await call('/v1/me', { token })).body.user.plan, 'free');

  const lifetime = await call('/v1/billing/appstore-notifications', {
    method: 'POST', body: { signedPayload: JSON.stringify({ type: 'ONE_TIME_CHARGE', transaction: JSON.stringify({ originalTransactionId: 'otx-2', productId: 'pro.lifetime', type: 'non_consumable', expiresDate: null, appAccountToken: userId }) }) },
  });
  assert.deepEqual(lifetime.body, { handled: true });
  const after = await call('/v1/me', { token });
  assert.equal(after.body.user.plan, 'pro');
  assert.equal(after.body.user.planExpiresAt, null);

  assert.deepEqual((await call('/v1/billing/appstore-notifications', { method: 'POST', body: { signedPayload: JSON.stringify({ type: 'TEST', padding: 'x'.repeat(16) }) } })).body, { handled: true });
  assert.equal((await call('/v1/billing/appstore-notifications', { method: 'POST', body: { signedPayload: 'definitely-not-signed-payload' } })).status, 401);
});

test('healthz and unknown routes', async () => {
  const { call } = setup();
  const health = await call('/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.purchases, true);
  assert.equal((await call('/nope')).status, 404);
});
