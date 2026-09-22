import type { PlanId } from '../domain/plan.ts';
import type { Logger } from '../logger.ts';
import type { Store, Subscription, SubscriptionStatus } from '../store/store.ts';
import type { VerifiedNotification, VerifiedRenewalInfo, VerifiedTransaction } from './verifier.ts';

export interface Entitlement {
  plan: PlanId;
  /** Null for free users and for lifetime purchases. */
  expiresAt: Date | null;
}

/** Derives the stored status of one subscription from a verified transaction. */
export function subscriptionStatusFor(
  tx: VerifiedTransaction,
  renewal: VerifiedRenewalInfo | null,
  now: Date,
): { status: SubscriptionStatus; expiresAt: Date | null } {
  if (tx.revocationDate) return { status: 'revoked', expiresAt: tx.expiresDate };
  if (tx.type === 'non_consumable') return { status: 'active', expiresAt: null };
  if (!tx.expiresDate) return { status: 'active', expiresAt: null };
  if (tx.expiresDate > now) return { status: 'active', expiresAt: tx.expiresDate };
  const grace = renewal?.gracePeriodExpiresDate ?? null;
  if (grace && grace > now) return { status: 'grace_period', expiresAt: grace };
  return { status: 'expired', expiresAt: tx.expiresDate };
}

/** Pure plan resolution from stored subscriptions. */
export function resolvePlan(subscriptions: readonly Subscription[], proProductIds: ReadonlySet<string>, now: Date): Entitlement {
  let best: Entitlement = { plan: 'free', expiresAt: null };
  for (const s of subscriptions) {
    if (!proProductIds.has(s.productId) || s.status === 'revoked' || s.status === 'expired') continue;
    if (s.expiresAt === null) return { plan: 'pro', expiresAt: null };
    if (s.expiresAt > now && (best.plan === 'free' || (best.expiresAt !== null && s.expiresAt > best.expiresAt))) {
      best = { plan: 'pro', expiresAt: s.expiresAt };
    }
  }
  return best;
}

/**
 * Applies verified App Store data to users. Both the app (after a purchase or
 * restore) and App Store Server Notifications end up here, so a user's plan is
 * always recomputed from the full set of their subscriptions.
 */
export class EntitlementService {
  private readonly store: Store;
  private readonly proProductIds: ReadonlySet<string>;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(store: Store, proProductIds: readonly string[], logger: Logger, now: () => Date = () => new Date()) {
    this.store = store;
    this.proProductIds = new Set(proProductIds);
    this.logger = logger;
    this.now = now;
  }

  isProProduct(productId: string): boolean {
    return this.proProductIds.has(productId);
  }

  async applyTransaction(userId: string, tx: VerifiedTransaction, renewal: VerifiedRenewalInfo | null): Promise<Entitlement> {
    const now = this.now();
    const { status, expiresAt } = subscriptionStatusFor(tx, renewal, now);
    const previous = await this.store.findSubscription(tx.originalTransactionId);
    await this.store.upsertSubscription({
      originalTransactionId: tx.originalTransactionId,
      userId,
      productId: tx.productId,
      environment: tx.environment,
      status,
      expiresAt,
    });
    if (!this.proProductIds.has(tx.productId)) {
      this.logger.warn('transaction for unknown product', { productId: tx.productId, userId });
    }
    if (previous && previous.userId !== userId) {
      this.logger.info('subscription moved between users', { from: previous.userId, to: userId });
      await this.recompute(previous.userId);
    }
    return this.recompute(userId);
  }

  async recompute(userId: string): Promise<Entitlement> {
    const subscriptions = await this.store.listSubscriptions(userId);
    const entitlement = resolvePlan(subscriptions, this.proProductIds, this.now());
    const user = await this.store.getUser(userId);
    if (user && (user.plan !== entitlement.plan || user.planExpiresAt?.getTime() !== entitlement.expiresAt?.getTime())) {
      await this.store.updateUserPlan(userId, entitlement.plan, entitlement.expiresAt);
      this.logger.info('plan updated', { userId, plan: entitlement.plan, expiresAt: entitlement.expiresAt });
    }
    return entitlement;
  }

  /**
   * Handles an App Store Server Notification. The user is found through the
   * stored subscription or the appAccountToken the app set at purchase time.
   */
  async handleNotification(notification: VerifiedNotification): Promise<{ handled: boolean; userId: string | null }> {
    const tx = notification.transaction;
    if (!tx) {
      this.logger.info('notification without transaction', { type: notification.notificationType });
      return { handled: notification.notificationType === 'TEST', userId: null };
    }
    let userId: string | null = null;
    const existing = await this.store.findSubscription(tx.originalTransactionId);
    if (existing) userId = existing.userId;
    else if (tx.appAccountToken && (await this.store.getUser(tx.appAccountToken))) userId = tx.appAccountToken;
    if (!userId) {
      this.logger.warn('notification for unknown user', {
        type: notification.notificationType,
        originalTransactionId: tx.originalTransactionId,
      });
      return { handled: false, userId: null };
    }
    await this.applyTransaction(userId, tx, notification.renewalInfo);
    return { handled: true, userId };
  }
}
