import type { Alert } from '../domain/alert.ts';
import { PLANS, type PlanLimits } from '../domain/plan.ts';
import type { PriceBook, PriceTick } from '../domain/price-book.ts';
import type { Logger } from '../logger.ts';
import type { Notifier } from '../push/notifier.ts';
import { buildAlertPush } from '../push/payload.ts';
import type { Store, User } from '../store/store.ts';
import { evaluateAlert } from './evaluator.ts';
import { SlidingWindowLimiter } from './rate-limit.ts';

export interface EngineOptions {
  store: Store;
  priceBook: PriceBook;
  notifier: Notifier;
  logger: Logger;
  now?: () => number;
  hysteresisPercent?: number;
  indexRefreshMs?: number;
  /** Debounce for invalidate(). */
  invalidateDelayMs?: number;
  planFor?: (user: User) => PlanLimits;
}

export interface EngineStats {
  trackedAlerts: number;
  trackedSymbols: number;
  ticks: number;
  fired: number;
  delivered: number;
  rateLimited: number;
  errors: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Turns price ticks into notifications.
 *
 * The engine keeps every active alert in memory, indexed by symbol, so a tick
 * costs no database round trip unless something fires. State changes are
 * written through to the store immediately; the index is rebuilt from the
 * store periodically and on demand (`invalidate()` after API changes).
 */
export class AlertEngine {
  private readonly store: Store;
  private readonly priceBook: PriceBook;
  private readonly notifier: Notifier;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly hysteresisPercent: number;
  private readonly indexRefreshMs: number;
  private readonly invalidateDelayMs: number;
  private readonly planFor: (user: User) => PlanLimits;
  private readonly limiter = new SlidingWindowLimiter(60 * 60 * 1000);

  private index = new Map<string, Map<string, Alert>>();
  private inflight = new Set<string>();
  private symbolListeners = new Set<(symbols: string[]) => void>();
  private lastSymbols = '';
  private refreshTimer: NodeJS.Timeout | null = null;
  private invalidateTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly counters = { ticks: 0, fired: 0, delivered: 0, rateLimited: 0, errors: 0 };

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.priceBook = options.priceBook;
    this.notifier = options.notifier;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.hysteresisPercent = options.hysteresisPercent ?? 0.5;
    this.indexRefreshMs = options.indexRefreshMs ?? 30_000;
    this.invalidateDelayMs = options.invalidateDelayMs ?? 100;
    this.planFor = options.planFor ?? ((user) => PLANS[user.plan]);
  }

  async start(): Promise<void> {
    await this.refreshIndex();
    this.refreshTimer = setInterval(() => {
      void this.refreshIndex();
      this.limiter.sweep(this.now());
    }, this.indexRefreshMs);
    this.refreshTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.invalidateTimer) clearTimeout(this.invalidateTimer);
    this.refreshTimer = null;
    this.invalidateTimer = null;
    if (this.refreshing) await this.refreshing;
  }

  /** Reloads active alerts from the store. Safe to call at any time. */
  refreshIndex(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Schedules a refresh soon; the API calls this after alerts change. */
  invalidate(): void {
    if (this.invalidateTimer) return;
    this.invalidateTimer = setTimeout(() => {
      this.invalidateTimer = null;
      void this.refreshIndex();
    }, this.invalidateDelayMs);
    this.invalidateTimer.unref();
  }

  onSymbolsChanged(listener: (symbols: string[]) => void): () => void {
    this.symbolListeners.add(listener);
    return () => this.symbolListeners.delete(listener);
  }

  trackedSymbols(): string[] {
    return [...this.index.keys()].sort();
  }

  stats(): EngineStats {
    let trackedAlerts = 0;
    for (const m of this.index.values()) trackedAlerts += m.size;
    return { trackedAlerts, trackedSymbols: this.index.size, ...this.counters };
  }

  /** Entry point for feeds. Never throws. */
  async handleTick(tick: PriceTick): Promise<void> {
    this.counters.ticks += 1;
    const update = this.priceBook.update(tick);
    if (!update.accepted) return;
    const alerts = this.index.get(tick.symbol);
    if (!alerts || alerts.size === 0) return;

    const now = this.now();
    for (const alert of [...alerts.values()]) {
      if (this.inflight.has(alert.id)) continue;
      try {
        const evaluation = evaluateAlert({
          alert,
          price: tick.price,
          now,
          hysteresisPercent: this.hysteresisPercent,
          changePercent: (windowMinutes) => this.priceBook.changePercent(tick.symbol, windowMinutes * 60_000, now),
        });
        if (evaluation.action === 'rearm') {
          alert.armed = true;
          await this.store.updateAlert(alert.id, { armed: true });
          this.logger.debug('alert re-armed', { alertId: alert.id, symbol: alert.symbol, price: tick.price });
        } else if (evaluation.action === 'fire') {
          await this.fire(alert, tick.price, now, evaluation.reason);
        }
      } catch (err) {
        this.counters.errors += 1;
        this.logger.error('alert evaluation failed', { alertId: alert.id, err });
      }
    }
  }

  private async fire(alert: Alert, price: number, now: number, reason: string): Promise<void> {
    // Mutate in memory first so a second tick arriving while we await cannot fire the same alert again.
    this.inflight.add(alert.id);
    alert.armed = false;
    alert.lastTriggeredAt = new Date(now);
    alert.triggerCount += 1;
    if (!alert.repeat) {
      alert.status = 'triggered';
      this.index.get(alert.symbol)?.delete(alert.id);
      if (this.index.get(alert.symbol)?.size === 0) {
        this.index.delete(alert.symbol);
        this.emitSymbols();
      }
    }
    this.counters.fired += 1;
    this.logger.info('alert fired', { alertId: alert.id, userId: alert.userId, symbol: alert.symbol, price, reason });

    try {
      await this.store.updateAlert(alert.id, {
        armed: false,
        lastTriggeredAt: alert.lastTriggeredAt,
        triggerCount: alert.triggerCount,
        status: alert.status,
      });

      const user = await this.store.getUser(alert.userId);
      if (!user) {
        this.index.get(alert.symbol)?.delete(alert.id);
        return;
      }
      const payload = buildAlertPush({ alert, price, change24h: this.priceBook.changePercent(alert.symbol, DAY_MS, now) });

      const plan = this.planFor(user);
      if (!this.limiter.tryAcquire(user.id, plan.pushesPerHour, now)) {
        this.counters.rateLimited += 1;
        this.logger.warn('push rate limited', { userId: user.id, limit: plan.pushesPerHour });
        await this.store.recordEvent({
          alertId: alert.id,
          userId: alert.userId,
          symbol: alert.symbol,
          price,
          title: payload.title,
          body: payload.body,
          firedAt: new Date(now),
          deliveredCount: 0,
        });
        return;
      }

      const devices = await this.store.listDevices(alert.userId);
      let delivered = 0;
      for (const device of devices) {
        const result = await this.notifier.send({ token: device.token, environment: device.environment }, payload);
        if (result.ok) {
          delivered += 1;
        } else if (result.unregister) {
          this.logger.info('removing dead device token', { userId: alert.userId, reason: result.reason });
          await this.store.removeDevice(device.token);
        } else {
          this.logger.warn('push delivery failed', { userId: alert.userId, status: result.status, reason: result.reason });
        }
      }
      this.counters.delivered += delivered;
      if (devices.length === 0) {
        this.logger.info('alert fired for a user without devices', { userId: alert.userId, alertId: alert.id });
      }
      await this.store.recordEvent({
        alertId: alert.id,
        userId: alert.userId,
        symbol: alert.symbol,
        price,
        title: payload.title,
        body: payload.body,
        firedAt: new Date(now),
        deliveredCount: delivered,
      });
    } finally {
      this.inflight.delete(alert.id);
    }
  }

  private async doRefresh(): Promise<void> {
    let alerts: Alert[];
    try {
      alerts = await this.store.listActiveAlerts();
    } catch (err) {
      this.counters.errors += 1;
      this.logger.error('index refresh failed', { err });
      return;
    }
    const next = new Map<string, Map<string, Alert>>();
    for (const fresh of alerts) {
      const current = this.index.get(fresh.symbol)?.get(fresh.id);
      // An alert whose firing is still being persisted keeps its in-memory state.
      const alert = current && this.inflight.has(fresh.id) ? current : fresh;
      let bySymbol = next.get(alert.symbol);
      if (!bySymbol) {
        bySymbol = new Map();
        next.set(alert.symbol, bySymbol);
      }
      bySymbol.set(alert.id, alert);
    }
    this.index = next;
    this.emitSymbols();
  }

  private emitSymbols(): void {
    const symbols = this.trackedSymbols();
    const key = symbols.join(',');
    if (key === this.lastSymbols) return;
    this.lastSymbols = key;
    for (const listener of this.symbolListeners) {
      try {
        listener(symbols);
      } catch (err) {
        this.logger.error('symbol listener failed', { err });
      }
    }
  }
}
