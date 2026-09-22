import type { Alert, AlertCondition, AlertStatus } from '../domain/alert.ts';
import type { PlanId } from '../domain/plan.ts';

export interface User {
  id: string;
  appleSub: string | null;
  plan: PlanId;
  planExpiresAt: Date | null;
  createdAt: Date;
}

export type PushEnvironment = 'sandbox' | 'production';

export interface Device {
  token: string;
  userId: string;
  environment: PushEnvironment;
  platform: string;
  appVersion: string | null;
  updatedAt: Date;
}

export interface DeviceInput {
  token: string;
  userId: string;
  environment: PushEnvironment;
  platform?: string;
  appVersion?: string | null;
}

export interface NewAlert {
  userId: string;
  symbol: string;
  quote: string;
  condition: AlertCondition;
  repeat: boolean;
  cooldownMinutes: number;
  armed: boolean;
  note: string | null;
}

export interface AlertPatch {
  condition?: AlertCondition;
  repeat?: boolean;
  cooldownMinutes?: number;
  status?: AlertStatus;
  armed?: boolean;
  note?: string | null;
  lastTriggeredAt?: Date | null;
  triggerCount?: number;
}

export interface AlertEvent {
  id: string;
  alertId: string | null;
  userId: string;
  symbol: string;
  price: number;
  title: string;
  body: string;
  firedAt: Date;
  deliveredCount: number;
}

export interface NewEvent {
  alertId: string | null;
  userId: string;
  symbol: string;
  price: number;
  title: string;
  body: string;
  firedAt: Date;
  deliveredCount: number;
}

export type SubscriptionStatus = 'active' | 'grace_period' | 'expired' | 'revoked';

export interface Subscription {
  originalTransactionId: string;
  userId: string;
  productId: string;
  environment: string;
  status: SubscriptionStatus;
  /** Null for lifetime purchases. */
  expiresAt: Date | null;
  updatedAt: Date;
}

export interface SubscriptionInput {
  originalTransactionId: string;
  userId: string;
  productId: string;
  environment: string;
  status: SubscriptionStatus;
  expiresAt: Date | null;
}

/**
 * Persistence boundary. Implementations: MemoryStore (development, tests) and
 * PostgresStore (production). All methods are safe to call concurrently.
 */
export interface Store {
  createUser(input?: { appleSub?: string | null }): Promise<User>;
  getUser(id: string): Promise<User | null>;
  findUserByAppleSub(sub: string): Promise<User | null>;
  linkAppleSub(userId: string, sub: string): Promise<User>;
  updateUserPlan(userId: string, plan: PlanId, planExpiresAt: Date | null): Promise<User>;
  /** Removes the user with all sessions, devices, alerts, events and subscriptions. */
  deleteUser(userId: string): Promise<void>;

  createSession(userId: string): Promise<string>;
  getSessionUserId(token: string): Promise<string | null>;
  deleteSession(token: string): Promise<void>;

  upsertDevice(input: DeviceInput): Promise<Device>;
  listDevices(userId: string): Promise<Device[]>;
  removeDevice(token: string): Promise<void>;

  createAlert(input: NewAlert): Promise<Alert>;
  getAlert(id: string): Promise<Alert | null>;
  listAlerts(userId: string): Promise<Alert[]>;
  listActiveAlerts(): Promise<Alert[]>;
  countActiveAlerts(userId: string): Promise<number>;
  updateAlert(id: string, patch: AlertPatch): Promise<Alert | null>;
  deleteAlert(id: string): Promise<boolean>;

  recordEvent(input: NewEvent): Promise<AlertEvent>;
  listEvents(userId: string, limit: number): Promise<AlertEvent[]>;

  upsertSubscription(input: SubscriptionInput): Promise<Subscription>;
  listSubscriptions(userId: string): Promise<Subscription[]>;
  findSubscription(originalTransactionId: string): Promise<Subscription | null>;

  close(): Promise<void>;
}
