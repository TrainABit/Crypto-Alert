import { describeCondition, type Alert } from '../domain/alert.ts';
import { formatPercent, formatPrice } from '../domain/format.ts';
import type { PushPayload } from './notifier.ts';

export const PRICE_ALERT_CATEGORY = 'PRICE_ALERT';

export interface AlertPushInput {
  alert: Alert;
  price: number;
  /** Percent change over the last 24 h when history allows it. */
  change24h?: number | undefined;
  eventId?: string | undefined;
}

/** Builds the notification for a fired alert. Pure, so it is easy to test and reuse. */
export function buildAlertPush(input: AlertPushInput): PushPayload {
  const { alert, price } = input;
  const title = describeCondition(alert.symbol, alert.condition);
  const parts = [`${alert.symbol} is now ${formatPrice(price)}`];
  if (input.change24h !== undefined && Number.isFinite(input.change24h)) {
    parts.push(`${formatPercent(input.change24h)} in 24 h`);
  }
  if (!alert.repeat) parts.push('Alert done');
  return {
    title,
    body: parts.join(' · '),
    threadId: alert.symbol,
    category: PRICE_ALERT_CATEGORY,
    collapseId: alert.id,
    interruptionLevel: 'time-sensitive',
    data: {
      alertId: alert.id,
      symbol: alert.symbol,
      price,
      kind: alert.condition.kind,
      repeat: alert.repeat,
      eventId: input.eventId ?? null,
    },
  };
}

/** The JSON body APNs expects. */
export function buildApnsBody(payload: PushPayload): Record<string, unknown> {
  return {
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: 'default',
      'thread-id': payload.threadId,
      category: payload.category,
      'interruption-level': payload.interruptionLevel,
      'mutable-content': 1,
    },
    ...payload.data,
  };
}
