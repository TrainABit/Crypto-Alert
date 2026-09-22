import type { PriceTick } from '../domain/price-book.ts';
import type { Logger } from '../logger.ts';
import { silentLogger } from '../logger.ts';
import { globalFetch, type FetchLike, type PriceFeed, type TickListener } from './feed.ts';

export interface CoinGeckoFeedOptions {
  /** Symbol (upper case) to CoinGecko id. */
  ids: Record<string, string>;
  pollMs?: number;
  apiKey?: string | undefined;
  /** Use https://pro-api.coingecko.com/api/v3 with a paid key. */
  baseUrl?: string;
  fetchImpl?: FetchLike;
  logger?: Logger;
  now?: () => number;
}

/**
 * Polling fallback for symbols Binance does not list and for when the
 * WebSocket feed goes quiet. Free tier limits are low, so one request carries
 * every tracked symbol and 429 responses back the poll interval off.
 */
export class CoinGeckoFeed implements PriceFeed {
  readonly name = 'coingecko';
  readonly priority = 1;

  private readonly ids: Record<string, string>;
  private readonly bySymbol = new Map<string, string>();
  private readonly byId = new Map<string, string>();
  private readonly pollMs: number;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private readonly now: () => number;

  private listeners: TickListener[] = [];
  private symbols = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private backoffMs = 0;
  private polling: Promise<void> | null = null;

  constructor(options: CoinGeckoFeedOptions) {
    this.ids = options.ids;
    for (const [symbol, id] of Object.entries(options.ids)) {
      this.bySymbol.set(symbol.toUpperCase(), id);
      this.byId.set(id, symbol.toUpperCase());
    }
    this.pollMs = options.pollMs ?? 60_000;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://api.coingecko.com/api/v3';
    this.fetchImpl = options.fetchImpl ?? globalFetch();
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? Date.now;
  }

  onTick(listener: TickListener): void {
    this.listeners.push(listener);
  }

  supports(symbol: string): boolean {
    return this.bySymbol.has(symbol.toUpperCase());
  }

  supportedSymbols(): string[] {
    return [...this.bySymbol.keys()].sort();
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.polling) await this.polling;
  }

  setSymbols(symbols: readonly string[]): void {
    const next = new Set(symbols.map((s) => s.toUpperCase()).filter((s) => this.supports(s)));
    const changed = next.size !== this.symbols.size || [...next].some((s) => !this.symbols.has(s));
    this.symbols = next;
    if (changed && !this.stopped && next.size > 0) this.schedule(1000);
  }

  async quote(symbol: string): Promise<PriceTick | undefined> {
    const upper = symbol.toUpperCase();
    const id = this.bySymbol.get(upper);
    if (!id) return undefined;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) headers['x-cg-demo-api-key'] = this.apiKey;
    try {
      const url = `${this.baseUrl}/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_last_updated_at=true`;
      const res = await this.fetchImpl(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, { usd?: unknown; last_updated_at?: unknown }>;
      const entry = body[id];
      if (!entry || typeof entry.usd !== 'number') return undefined;
      const at = typeof entry.last_updated_at === 'number' ? entry.last_updated_at * 1000 : this.now();
      return { symbol: upper, price: entry.usd, at, source: this.name };
    } catch (err) {
      this.logger.warn('coingecko quote failed', { symbol: upper, err });
      return undefined;
    }
  }

  /** Runs one poll. Exposed for tests and for the feed manager's health checks. */
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.doPoll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll().then(() => this.schedule(this.pollMs + this.backoffMs));
    }, delay);
    this.timer.unref();
  }

  private async doPoll(): Promise<void> {
    if (this.symbols.size === 0) return;
    const ids = [...this.symbols].map((s) => this.bySymbol.get(s)!);
    const url = `${this.baseUrl}/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=usd&include_last_updated_at=true`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) headers['x-cg-demo-api-key'] = this.apiKey;
    try {
      const res = await this.fetchImpl(url, { headers });
      if (res.status === 429) {
        this.backoffMs = Math.min(10 * 60_000, Math.max(this.pollMs, this.backoffMs * 2));
        this.logger.warn('coingecko rate limited; backing off', { backoffMs: this.backoffMs });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.backoffMs = 0;
      const body = (await res.json()) as Record<string, { usd?: unknown; last_updated_at?: unknown }>;
      const now = this.now();
      for (const [id, entry] of Object.entries(body)) {
        const symbol = this.byId.get(id);
        if (!symbol || typeof entry?.usd !== 'number') continue;
        const at = typeof entry.last_updated_at === 'number' ? entry.last_updated_at * 1000 : now;
        const tick: PriceTick = { symbol, price: entry.usd, at, source: this.name };
        for (const listener of this.listeners) listener(tick);
      }
    } catch (err) {
      this.logger.warn('coingecko poll failed', { err });
    }
  }

  /** Returns the id map, mainly for diagnostics. */
  idMap(): Record<string, string> {
    return { ...this.ids };
  }
}
