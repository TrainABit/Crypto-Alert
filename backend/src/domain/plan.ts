import { CONDITION_KINDS, type AlertCondition, type ConditionKind } from './alert.ts';

export const PLAN_IDS = ['free', 'pro'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanLimits {
  id: PlanId;
  /** Alerts in status "active" a user may hold at once. */
  maxActiveAlerts: number;
  /** Whether repeating alerts are available. */
  repeatAlerts: boolean;
  /** Condition kinds the plan may use. */
  conditionKinds: readonly ConditionKind[];
  /** Shortest cooldown between two firings of one alert. */
  minCooldownMinutes: number;
  /** Push notifications per user per rolling hour before the engine throttles. */
  pushesPerHour: number;
}

/**
 * Plan limits are enforced on the server. The client only mirrors them for UI.
 * Numbers are a starting point for A/B tests, not gospel.
 */
export const PLANS: Readonly<Record<PlanId, PlanLimits>> = {
  free: {
    id: 'free',
    maxActiveAlerts: 3,
    repeatAlerts: false,
    conditionKinds: ['price_above', 'price_below'],
    minCooldownMinutes: 60,
    pushesPerHour: 20,
  },
  pro: {
    id: 'pro',
    maxActiveAlerts: 200,
    repeatAlerts: true,
    conditionKinds: CONDITION_KINDS,
    minCooldownMinutes: 1,
    pushesPerHour: 240,
  },
};

export type PlanViolationCode = 'alert_limit' | 'repeat_locked' | 'condition_locked' | 'cooldown_too_short';

export interface PlanViolation {
  code: PlanViolationCode;
  message: string;
  /** True when upgrading to Pro would lift the restriction. The client uses this to show the paywall. */
  upgrade: boolean;
}

export interface AlertShape {
  condition: AlertCondition;
  repeat: boolean;
  cooldownMinutes: number;
}

/**
 * Checks an alert against a plan.
 * @param activeCount active alerts the user already has, excluding the one being checked
 * @param addsActive whether the checked alert would add one more active alert
 */
export function checkAlertAgainstPlan(
  plan: PlanLimits,
  activeCount: number,
  shape: AlertShape,
  addsActive: boolean,
): PlanViolation | null {
  const pro = PLANS.pro;
  if (addsActive && activeCount >= plan.maxActiveAlerts) {
    return {
      code: 'alert_limit',
      message: `Your plan allows ${plan.maxActiveAlerts} active alerts.`,
      upgrade: pro.maxActiveAlerts > plan.maxActiveAlerts,
    };
  }
  if (shape.repeat && !plan.repeatAlerts) {
    return { code: 'repeat_locked', message: 'Repeating alerts are a Pro feature.', upgrade: pro.repeatAlerts };
  }
  if (!plan.conditionKinds.includes(shape.condition.kind)) {
    return {
      code: 'condition_locked',
      message: 'This alert type is a Pro feature.',
      upgrade: pro.conditionKinds.includes(shape.condition.kind),
    };
  }
  if (shape.cooldownMinutes < plan.minCooldownMinutes) {
    return {
      code: 'cooldown_too_short',
      message: `Your plan allows a cooldown of at least ${plan.minCooldownMinutes} minutes.`,
      upgrade: pro.minCooldownMinutes < plan.minCooldownMinutes,
    };
  }
  return null;
}

export function serializePlan(plan: PlanLimits) {
  return {
    id: plan.id,
    maxActiveAlerts: plan.maxActiveAlerts,
    repeatAlerts: plan.repeatAlerts,
    conditionKinds: [...plan.conditionKinds],
    minCooldownMinutes: plan.minCooldownMinutes,
    pushesPerHour: plan.pushesPerHour,
  };
}
