import type { Alert, AlertCondition } from '../src/domain/alert.ts';

let counter = 0;

/** Builds an alert with sensible defaults for tests. */
export function makeAlert(overrides: Partial<Alert> & { condition?: AlertCondition } = {}): Alert {
  counter += 1;
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: `alert-${counter}`,
    userId: 'user-1',
    symbol: 'BTC',
    quote: 'USD',
    condition: { kind: 'price_above', price: 100 },
    repeat: false,
    cooldownMinutes: 60,
    status: 'active',
    armed: true,
    note: null,
    lastTriggeredAt: null,
    triggerCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export const T0 = Date.parse('2026-01-01T00:00:00Z');
export const minutes = (n: number) => n * 60_000;
