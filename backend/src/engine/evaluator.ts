import type { Alert } from '../domain/alert.ts';

export interface EvaluationInput {
  alert: Alert;
  /** Current price of the alert's symbol. */
  price: number;
  /** Milliseconds since epoch. */
  now: number;
  /** Percent change over a window, or undefined when history is too short. */
  changePercent: (windowMinutes: number) => number | undefined;
  /** Distance (percent of the target) the price must cross back before a repeating alert re-arms. */
  hysteresisPercent: number;
}

export type Evaluation = { action: 'fire'; reason: string } | { action: 'rearm' } | { action: 'none' };

/**
 * Pure decision function. It never mutates the alert; the engine applies the outcome.
 *
 * Rules:
 *  - only "active" alerts fire;
 *  - an armed alert fires when its condition holds and the cooldown has passed;
 *  - after firing the engine disarms the alert; a disarmed alert re-arms once the
 *    price has crossed back by the hysteresis band (threshold alerts) or the move
 *    has retraced to half the threshold (percent-change alerts);
 *  - one-shot alerts are ended by the engine after firing, so they never re-arm.
 */
export function evaluateAlert(input: EvaluationInput): Evaluation {
  const { alert, price, now } = input;
  if (alert.status !== 'active') return { action: 'none' };
  if (!Number.isFinite(price) || price <= 0) return { action: 'none' };

  const cooldownMs = alert.cooldownMinutes * 60_000;
  const inCooldown = alert.lastTriggeredAt !== null && now - alert.lastTriggeredAt.getTime() < cooldownMs;
  const band = input.hysteresisPercent / 100;
  const c = alert.condition;

  switch (c.kind) {
    case 'price_above': {
      if (alert.armed) {
        if (price >= c.price && !inCooldown) return { action: 'fire', reason: `price ${price} >= ${c.price}` };
        return { action: 'none' };
      }
      if (price < c.price * (1 - band)) return { action: 'rearm' };
      return { action: 'none' };
    }
    case 'price_below': {
      if (alert.armed) {
        if (price <= c.price && !inCooldown) return { action: 'fire', reason: `price ${price} <= ${c.price}` };
        return { action: 'none' };
      }
      if (price > c.price * (1 + band)) return { action: 'rearm' };
      return { action: 'none' };
    }
    case 'percent_change': {
      const change = input.changePercent(c.windowMinutes);
      if (change === undefined || !Number.isFinite(change)) return { action: 'none' };
      const matches =
        (c.direction === 'up' && change >= c.percent) ||
        (c.direction === 'down' && change <= -c.percent) ||
        (c.direction === 'either' && Math.abs(change) >= c.percent);
      if (alert.armed) {
        if (matches && !inCooldown) {
          return { action: 'fire', reason: `change ${change.toFixed(2)}% over ${c.windowMinutes} min` };
        }
        return { action: 'none' };
      }
      if (Math.abs(change) < c.percent / 2) return { action: 'rearm' };
      return { action: 'none' };
    }
  }
}
