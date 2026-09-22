import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EntitlementService, resolvePlan, subscriptionStatusFor } from '../src/billing/entitlements.ts';
import type { VerifiedTransaction } from '../src/billing/verifier.ts';
import { silentLogger } from '../src/logger.ts';
import { MemoryStore } from '../src/store/memory.ts';
import type { Subscription } from '../src/store/store.ts';

const NOW = new Date('2026-06-01T00:00:00Z');
const later = new Date('2026-07-01T00:00:00Z');
const earlier = new Date('2026-05-01T00:00:00Z');
const PRO = new Set(['pro.monthly', 'pro.yearly', 'pro.lifetime']);

const tx = (over: Partial<VerifiedTransaction> = {}): VerifiedTransaction => ({
  originalTransactionId: 'otx-1',
  transactionId: 'tx-1',
  productId: 'pro.monthly',
  bundleId: 'com.example.app',
  type: 'auto_renewable',
  purchaseDate: earlier,
  expiresDate: later,
  revocationDate: null,
  environment: 'Sandbox',
  appAccountToken: null,
  ...over,
});

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  originalTransactionId: 'otx-1', userId: 'u', productId: 'pro.monthly', environment: 'Sandbox', status: 'active', expiresAt: later, updatedAt: NOW, ...over,
});

test('subscriptionStatusFor covers active, expired, grace period, lifetime and revoked', () => {
  assert.deepEqual(subscriptionStatusFor(tx(), null, NOW), { status: 'active', expiresAt: later });
  assert.deepEqual(subscriptionStatusFor(tx({ expiresDate: earlier }), null, NOW), { status: 'expired', expiresAt: earlier });
  const grace = new Date('2026-06-10T00:00:00Z');
  assert.deepEqual(
    subscriptionStatusFor(tx({ expiresDate: earlier }), { autoRenewStatus: true, isInBillingRetryPeriod: true, gracePeriodExpiresDate: grace }, NOW),
    { status: 'grace_period', expiresAt: grace },
  );
  assert.deepEqual(subscriptionStatusFor(tx({ type: 'non_consumable', productId: 'pro.lifetime', expiresDate: null }), null, NOW), { status: 'active', expiresAt: null });
  assert.deepEqual(subscriptionStatusFor(tx({ revocationDate: NOW }), null, NOW), { status: 'revoked', expiresAt: later });
});

test('resolvePlan picks the longest live pro entitlement and ignores the rest', () => {
  assert.deepEqual(resolvePlan([], PRO, NOW), { plan: 'free', expiresAt: null });
  assert.deepEqual(resolvePlan([sub({ status: 'expired', expiresAt: earlier })], PRO, NOW), { plan: 'free', expiresAt: null });
  assert.deepEqual(resolvePlan([sub({ productId: 'other.thing' })], PRO, NOW), { plan: 'free', expiresAt: null });
  assert.deepEqual(resolvePlan([sub({ status: 'revoked' })], PRO, NOW), { plan: 'free', expiresAt: null });
  const farther = new Date('2027-01-01T00:00:00Z');
  assert.deepEqual(resolvePlan([sub(), sub({ originalTransactionId: 'otx-2', productId: 'pro.yearly', expiresAt: farther })], PRO, NOW), { plan: 'pro', expiresAt: farther });
  assert.deepEqual(resolvePlan([sub({ status: 'grace_period' })], PRO, NOW), { plan: 'pro', expiresAt: later });
  assert.deepEqual(resolvePlan([sub({ status: 'expired', expiresAt: earlier }), sub({ originalTransactionId: 'l', productId: 'pro.lifetime', expiresAt: null })], PRO, NOW), { plan: 'pro', expiresAt: null });
});

test('EntitlementService updates the user plan and handles notifications', async () => {
  const store = new MemoryStore();
  const service = new EntitlementService(store, [...PRO], silentLogger, () => NOW);
  const user = await store.createUser();

  assert.deepEqual(await service.applyTransaction(user.id, tx(), null), { plan: 'pro', expiresAt: later });
  assert.equal((await store.getUser(user.id))?.plan, 'pro');

  // Renewal notification arrives from Apple; user is found through the stored subscription.
  const renewed = new Date('2026-08-01T00:00:00Z');
  const result = await service.handleNotification({
    notificationType: 'DID_RENEW', subtype: null, environment: 'Sandbox',
    transaction: tx({ transactionId: 'tx-2', expiresDate: renewed }), renewalInfo: null,
  });
  assert.deepEqual(result, { handled: true, userId: user.id });
  assert.equal((await store.getUser(user.id))?.planExpiresAt?.toISOString(), renewed.toISOString());

  // Expiration downgrades.
  await service.handleNotification({
    notificationType: 'EXPIRED', subtype: 'VOLUNTARY', environment: 'Sandbox',
    transaction: tx({ transactionId: 'tx-3', expiresDate: earlier }), renewalInfo: null,
  });
  assert.equal((await store.getUser(user.id))?.plan, 'free');

  // A notification for a transaction we have never seen maps through appAccountToken.
  const other = await store.createUser();
  const viaToken = await service.handleNotification({
    notificationType: 'SUBSCRIBED', subtype: 'INITIAL_BUY', environment: 'Sandbox',
    transaction: tx({ originalTransactionId: 'otx-9', productId: 'pro.yearly', appAccountToken: other.id }), renewalInfo: null,
  });
  assert.deepEqual(viaToken, { handled: true, userId: other.id });
  assert.equal((await store.getUser(other.id))?.plan, 'pro');

  // Unknown mapping is reported, not thrown.
  assert.deepEqual(
    await service.handleNotification({ notificationType: 'DID_RENEW', subtype: null, environment: 'Sandbox', transaction: tx({ originalTransactionId: 'ghost' }), renewalInfo: null }),
    { handled: false, userId: null },
  );
  assert.deepEqual(
    await service.handleNotification({ notificationType: 'TEST', subtype: null, environment: 'Sandbox', transaction: null, renewalInfo: null }),
    { handled: true, userId: null },
  );
});

test('a subscription restored on a second account moves and the first account is downgraded', async () => {
  const store = new MemoryStore();
  const service = new EntitlementService(store, [...PRO], silentLogger, () => NOW);
  const first = await store.createUser();
  const second = await store.createUser();
  await service.applyTransaction(first.id, tx(), null);
  await service.applyTransaction(second.id, tx(), null);
  assert.equal((await store.getUser(first.id))?.plan, 'free');
  assert.equal((await store.getUser(second.id))?.plan, 'pro');
});
