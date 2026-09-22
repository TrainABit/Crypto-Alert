import { z } from 'zod';
import { formatMinutes, formatPrice } from './format.ts';

export const CONDITION_KINDS = ['price_above', 'price_below', 'percent_change'] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

export const DIRECTIONS = ['up', 'down', 'either'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export type AlertCondition =
  | { kind: 'price_above'; price: number }
  | { kind: 'price_below'; price: number }
  | { kind: 'percent_change'; percent: number; windowMinutes: number; direction: Direction };

export const ALERT_STATUSES = ['active', 'paused', 'triggered'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export interface Alert {
  id: string;
  userId: string;
  /** Base asset symbol, upper case, e.g. "BTC". */
  symbol: string;
  /** Quote currency. Always "USD" in v1. */
  quote: string;
  condition: AlertCondition;
  /** Repeating alerts re-arm after the price crosses back; one-shot alerts end as "triggered". */
  repeat: boolean;
  /** Minimum minutes between two firings of the same alert. */
  cooldownMinutes: number;
  status: AlertStatus;
  /** False while the condition is currently true and the alert waits for the price to cross back. */
  armed: boolean;
  note: string | null;
  lastTriggeredAt: Date | null;
  triggerCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const MAX_WINDOW_MINUTES = 7 * 24 * 60;
const MAX_COOLDOWN_MINUTES = 7 * 24 * 60;

const priceSchema = z.number().finite().positive().max(1e12);

export const conditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('price_above'), price: priceSchema }),
  z.object({ kind: z.literal('price_below'), price: priceSchema }),
  z.object({
    kind: z.literal('percent_change'),
    percent: z.number().finite().min(0.1).max(1000),
    windowMinutes: z.number().int().min(1).max(MAX_WINDOW_MINUTES),
    direction: z.enum(DIRECTIONS),
  }),
]);

export const symbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .regex(/^[A-Za-z0-9]+$/, 'symbol must be alphanumeric')
  .transform((s) => s.toUpperCase());

export const createAlertSchema = z.object({
  symbol: symbolSchema,
  condition: conditionSchema,
  repeat: z.boolean().default(false),
  cooldownMinutes: z.number().int().min(1).max(MAX_COOLDOWN_MINUTES).default(60),
  note: z.string().trim().max(200).nullable().default(null),
});
export type CreateAlertInput = z.infer<typeof createAlertSchema>;

export const updateAlertSchema = z
  .object({
    condition: conditionSchema.optional(),
    repeat: z.boolean().optional(),
    cooldownMinutes: z.number().int().min(1).max(MAX_COOLDOWN_MINUTES).optional(),
    /** Clients may pause and resume. "triggered" is only ever set by the engine. */
    status: z.enum(['active', 'paused']).optional(),
    note: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });
export type UpdateAlertInput = z.infer<typeof updateAlertSchema>;

/** Short human readable description used as the notification title and in lists. */
export function describeCondition(symbol: string, condition: AlertCondition): string {
  switch (condition.kind) {
    case 'price_above':
      return `${symbol} above ${formatPrice(condition.price)}`;
    case 'price_below':
      return `${symbol} below ${formatPrice(condition.price)}`;
    case 'percent_change': {
      const dir = condition.direction === 'up' ? 'up' : condition.direction === 'down' ? 'down' : 'moves';
      return `${symbol} ${dir} ${condition.percent}% in ${formatMinutes(condition.windowMinutes)}`;
    }
  }
}

/**
 * Whether a freshly created or edited alert should start armed.
 * An alert whose condition is already true starts disarmed so it fires on the next
 * crossing instead of immediately; the client shows this to the user.
 */
export function initialArmedState(condition: AlertCondition, currentPrice: number | undefined): boolean {
  if (currentPrice === undefined) return true;
  switch (condition.kind) {
    case 'price_above':
      return currentPrice < condition.price;
    case 'price_below':
      return currentPrice > condition.price;
    case 'percent_change':
      return true;
  }
}

/** JSON shape sent to clients. Dates become ISO strings. */
export function serializeAlert(alert: Alert) {
  return {
    id: alert.id,
    symbol: alert.symbol,
    quote: alert.quote,
    condition: alert.condition,
    repeat: alert.repeat,
    cooldownMinutes: alert.cooldownMinutes,
    status: alert.status,
    armed: alert.armed,
    note: alert.note,
    title: describeCondition(alert.symbol, alert.condition),
    lastTriggeredAt: alert.lastTriggeredAt?.toISOString() ?? null,
    triggerCount: alert.triggerCount,
    createdAt: alert.createdAt.toISOString(),
    updatedAt: alert.updatedAt.toISOString(),
  };
}
export type SerializedAlert = ReturnType<typeof serializeAlert>;
