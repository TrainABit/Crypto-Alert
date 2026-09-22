import { randomBytes, randomUUID } from 'node:crypto';
import type { Alert } from '../domain/alert.ts';
import type { PlanId } from '../domain/plan.ts';
import type {
  AlertEvent,
  AlertPatch,
  Device,
  DeviceInput,
  NewAlert,
  NewEvent,
  Store,
  Subscription,
  SubscriptionInput,
  User,
} from './store.ts';

const clone = <T>(v: T): T => structuredClone(v);

/** In-memory store for development and tests. Nothing survives a restart. */
export class MemoryStore implements Store {
  private users = new Map<string, User>();
  private sessions = new Map<string, string>();
  private devices = new Map<string, Device>();
  private alerts = new Map<string, Alert>();
  private events: AlertEvent[] = [];
  private subscriptions = new Map<string, Subscription>();

  async createUser(input: { appleSub?: string | null } = {}): Promise<User> {
    const user: User = { id: randomUUID(), appleSub: input.appleSub ?? null, plan: 'free', planExpiresAt: null, createdAt: new Date() };
    this.users.set(user.id, user);
    return clone(user);
  }

  async getUser(id: string): Promise<User | null> {
    const u = this.users.get(id);
    return u ? clone(u) : null;
  }

  async findUserByAppleSub(sub: string): Promise<User | null> {
    for (const u of this.users.values()) if (u.appleSub === sub) return clone(u);
    return null;
  }

  async linkAppleSub(userId: string, sub: string): Promise<User> {
    const u = this.mustUser(userId);
    u.appleSub = sub;
    return clone(u);
  }

  async updateUserPlan(userId: string, plan: PlanId, planExpiresAt: Date | null): Promise<User> {
    const u = this.mustUser(userId);
    u.plan = plan;
    u.planExpiresAt = planExpiresAt;
    return clone(u);
  }

  async deleteUser(userId: string): Promise<void> {
    this.users.delete(userId);
    for (const [t, uid] of this.sessions) if (uid === userId) this.sessions.delete(t);
    for (const [t, d] of this.devices) if (d.userId === userId) this.devices.delete(t);
    for (const [id, a] of this.alerts) if (a.userId === userId) this.alerts.delete(id);
    this.events = this.events.filter((e) => e.userId !== userId);
    for (const [id, s] of this.subscriptions) if (s.userId === userId) this.subscriptions.delete(id);
  }

  async createSession(userId: string): Promise<string> {
    this.mustUser(userId);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, userId);
    return token;
  }

  async getSessionUserId(token: string): Promise<string | null> {
    return this.sessions.get(token) ?? null;
  }

  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  async upsertDevice(input: DeviceInput): Promise<Device> {
    this.mustUser(input.userId);
    const device: Device = {
      token: input.token,
      userId: input.userId,
      environment: input.environment,
      platform: input.platform ?? 'ios',
      appVersion: input.appVersion ?? null,
      updatedAt: new Date(),
    };
    this.devices.set(device.token, device);
    return clone(device);
  }

  async listDevices(userId: string): Promise<Device[]> {
    return [...this.devices.values()].filter((d) => d.userId === userId).map(clone);
  }

  async removeDevice(token: string): Promise<void> {
    this.devices.delete(token);
  }

  async createAlert(input: NewAlert): Promise<Alert> {
    this.mustUser(input.userId);
    const now = new Date();
    const alert: Alert = {
      id: randomUUID(),
      userId: input.userId,
      symbol: input.symbol,
      quote: input.quote,
      condition: clone(input.condition),
      repeat: input.repeat,
      cooldownMinutes: input.cooldownMinutes,
      status: 'active',
      armed: input.armed,
      note: input.note,
      lastTriggeredAt: null,
      triggerCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.alerts.set(alert.id, alert);
    return clone(alert);
  }

  async getAlert(id: string): Promise<Alert | null> {
    const a = this.alerts.get(id);
    return a ? clone(a) : null;
  }

  async listAlerts(userId: string): Promise<Alert[]> {
    return [...this.alerts.values()]
      .filter((a) => a.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(clone);
  }

  async listActiveAlerts(): Promise<Alert[]> {
    return [...this.alerts.values()].filter((a) => a.status === 'active').map(clone);
  }

  async countActiveAlerts(userId: string): Promise<number> {
    let n = 0;
    for (const a of this.alerts.values()) if (a.userId === userId && a.status === 'active') n++;
    return n;
  }

  async updateAlert(id: string, patch: AlertPatch): Promise<Alert | null> {
    const a = this.alerts.get(id);
    if (!a) return null;
    if (patch.condition !== undefined) a.condition = clone(patch.condition);
    if (patch.repeat !== undefined) a.repeat = patch.repeat;
    if (patch.cooldownMinutes !== undefined) a.cooldownMinutes = patch.cooldownMinutes;
    if (patch.status !== undefined) a.status = patch.status;
    if (patch.armed !== undefined) a.armed = patch.armed;
    if (patch.note !== undefined) a.note = patch.note;
    if (patch.lastTriggeredAt !== undefined) a.lastTriggeredAt = patch.lastTriggeredAt;
    if (patch.triggerCount !== undefined) a.triggerCount = patch.triggerCount;
    a.updatedAt = new Date();
    return clone(a);
  }

  async deleteAlert(id: string): Promise<boolean> {
    const existed = this.alerts.delete(id);
    if (existed) for (const e of this.events) if (e.alertId === id) e.alertId = null;
    return existed;
  }

  async recordEvent(input: NewEvent): Promise<AlertEvent> {
    const event: AlertEvent = { id: randomUUID(), ...input };
    this.events.push(event);
    return clone(event);
  }

  async listEvents(userId: string, limit: number): Promise<AlertEvent[]> {
    return this.events
      .filter((e) => e.userId === userId)
      .sort((a, b) => b.firedAt.getTime() - a.firedAt.getTime())
      .slice(0, limit)
      .map(clone);
  }

  async upsertSubscription(input: SubscriptionInput): Promise<Subscription> {
    this.mustUser(input.userId);
    const sub: Subscription = { ...input, updatedAt: new Date() };
    this.subscriptions.set(sub.originalTransactionId, sub);
    return clone(sub);
  }

  async listSubscriptions(userId: string): Promise<Subscription[]> {
    return [...this.subscriptions.values()].filter((s) => s.userId === userId).map(clone);
  }

  async findSubscription(originalTransactionId: string): Promise<Subscription | null> {
    const s = this.subscriptions.get(originalTransactionId);
    return s ? clone(s) : null;
  }

  async close(): Promise<void> {
    /* nothing to release */
  }

  private mustUser(id: string): User {
    const u = this.users.get(id);
    if (!u) throw new Error(`unknown user ${id}`);
    return u;
  }
}
