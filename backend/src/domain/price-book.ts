/**
 * In-memory view of the latest price per symbol plus a sampled history so
 * percent-change alerts can look back over a window.
 *
 * Guards built in:
 *  - outlier confirmation: a tick that jumps more than `outlierPercent` from the
 *    last accepted price is held back until a second tick confirms it (flash wicks
 *    and bad prints must not fire alerts);
 *  - source priority: a fallback feed cannot override a fresh primary feed;
 *  - staleness: consumers can ask whether a symbol has gone quiet.
 */

export interface PriceTick {
  symbol: string;
  price: number;
  /** Milliseconds since epoch when the source produced the price. */
  at: number;
  /** Feed name, e.g. "binance" or "coingecko". */
  source: string;
}

export interface PriceSample {
  at: number;
  price: number;
}

export interface PriceBookOptions {
  /** How much history to keep per symbol. Default 24 h. */
  historyMs?: number;
  /** Minimum spacing between stored samples. Default 10 s. */
  sampleIntervalMs?: number;
  /** Jump (percent) from the last accepted price that needs confirmation. Default 15. */
  outlierPercent?: number;
  /** Higher number wins. Unknown sources get priority 0. */
  sourcePriority?: Record<string, number>;
  /** A higher-priority source counts as fresh for this long. Default 30 s. */
  primaryFreshMs?: number;
}

export type UpdateResult =
  | { accepted: true; previous: number | undefined }
  | { accepted: false; reason: 'outlier_pending' | 'lower_priority' | 'out_of_order' | 'invalid' };

interface SymbolState {
  latest: PriceTick;
  history: PriceSample[];
  pending: PriceTick | null;
}

export class PriceBook {
  private readonly historyMs: number;
  private readonly sampleIntervalMs: number;
  private readonly outlierPercent: number;
  private readonly sourcePriority: Record<string, number>;
  private readonly primaryFreshMs: number;
  private readonly state = new Map<string, SymbolState>();

  constructor(options: PriceBookOptions = {}) {
    this.historyMs = options.historyMs ?? 24 * 60 * 60 * 1000;
    this.sampleIntervalMs = options.sampleIntervalMs ?? 10_000;
    this.outlierPercent = options.outlierPercent ?? 15;
    this.sourcePriority = options.sourcePriority ?? {};
    this.primaryFreshMs = options.primaryFreshMs ?? 30_000;
  }

  private priority(source: string): number {
    return this.sourcePriority[source] ?? 0;
  }

  /** Feeds in a new tick. Returns whether it became the current price. */
  update(tick: PriceTick): UpdateResult {
    if (!Number.isFinite(tick.price) || tick.price <= 0 || !Number.isFinite(tick.at)) {
      return { accepted: false, reason: 'invalid' };
    }
    const current = this.state.get(tick.symbol);
    if (!current) {
      this.state.set(tick.symbol, { latest: tick, history: [{ at: tick.at, price: tick.price }], pending: null });
      return { accepted: true, previous: undefined };
    }

    if (tick.at < current.latest.at) {
      return { accepted: false, reason: 'out_of_order' };
    }

    const incomingPriority = this.priority(tick.source);
    const currentPriority = this.priority(current.latest.source);
    if (incomingPriority < currentPriority && tick.at - current.latest.at < this.primaryFreshMs) {
      return { accepted: false, reason: 'lower_priority' };
    }

    const jump = Math.abs(tick.price / current.latest.price - 1) * 100;
    if (jump > this.outlierPercent) {
      const pending = current.pending;
      const confirms =
        pending !== null &&
        Math.sign(pending.price - current.latest.price) === Math.sign(tick.price - current.latest.price) &&
        Math.abs(tick.price / pending.price - 1) * 100 <= this.outlierPercent;
      if (!confirms) {
        current.pending = tick;
        return { accepted: false, reason: 'outlier_pending' };
      }
    }
    current.pending = null;

    const previous = current.latest.price;
    current.latest = tick;
    this.addSample(current, tick.at, tick.price);
    return { accepted: true, previous };
  }

  /**
   * Seeds history for a symbol, e.g. from exchange candles, so window based
   * alerts work right after start-up. Samples must be sorted by time.
   */
  seed(symbol: string, samples: readonly PriceSample[]): void {
    if (samples.length === 0) return;
    const existing = this.state.get(symbol);
    const clean = samples.filter((s) => Number.isFinite(s.price) && s.price > 0 && Number.isFinite(s.at));
    if (clean.length === 0) return;
    if (!existing) {
      const last = clean[clean.length - 1]!;
      this.state.set(symbol, {
        latest: { symbol, price: last.price, at: last.at, source: 'seed' },
        history: [...clean],
        pending: null,
      });
      return;
    }
    // Keep only seeded samples older than what we already have, then merge.
    const oldest = existing.history[0]?.at ?? Number.POSITIVE_INFINITY;
    const older = clean.filter((s) => s.at < oldest);
    existing.history = [...older, ...existing.history];
    this.prune(existing, existing.latest.at);
  }

  latest(symbol: string): PriceTick | undefined {
    return this.state.get(symbol)?.latest;
  }

  /** Price of the last sample at or before `atMs`, or undefined when history does not reach back that far. */
  priceAt(symbol: string, atMs: number): number | undefined {
    const s = this.state.get(symbol);
    if (!s || s.history.length === 0) return undefined;
    const history = s.history;
    if (atMs < history[0]!.at) return undefined;
    let lo = 0;
    let hi = history.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (history[mid]!.at <= atMs) lo = mid;
      else hi = mid - 1;
    }
    return history[lo]!.price;
  }

  /** Percent change of the latest price versus the price `windowMs` ago. */
  changePercent(symbol: string, windowMs: number, nowMs: number): number | undefined {
    const latest = this.latest(symbol);
    if (!latest) return undefined;
    const reference = this.priceAt(symbol, nowMs - windowMs);
    if (reference === undefined || reference <= 0) return undefined;
    return (latest.price / reference - 1) * 100;
  }

  isStale(symbol: string, nowMs: number, maxAgeMs: number): boolean {
    const latest = this.latest(symbol);
    return !latest || nowMs - latest.at > maxAgeMs;
  }

  symbols(): string[] {
    return [...this.state.keys()];
  }

  historyLength(symbol: string): number {
    return this.state.get(symbol)?.history.length ?? 0;
  }

  private addSample(s: SymbolState, at: number, price: number): void {
    const last = s.history[s.history.length - 1];
    if (!last || at - last.at >= this.sampleIntervalMs) {
      s.history.push({ at, price });
    } else {
      // Keep the freshest price for the current bucket without growing the array.
      last.price = price;
    }
    this.prune(s, at);
  }

  private prune(s: SymbolState, nowMs: number): void {
    const cutoff = nowMs - this.historyMs;
    let drop = 0;
    while (drop < s.history.length - 1 && s.history[drop + 1]!.at <= cutoff) drop++;
    if (drop > 0) s.history.splice(0, drop);
  }
}
