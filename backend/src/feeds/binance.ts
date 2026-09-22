import type { PriceSample, PriceTick } from '../domain/price-book.ts';
import type { Logger } from '../logger.ts';
import { silentLogger } from '../logger.ts';
import {
  WS_OPEN,
  globalFetch,
  globalWebSocket,
  type FetchLike,
  type PriceFeed,
  type TickListener,
  type WebSocketConstructor,
  type WebSocketLike,
} from './feed.ts';

export interface BinanceFeedOptions {
  restBaseUrl?: string;
  wsUrl?: string;
  /** Quote asset used as the USD proxy. */
  quote?: string;
  logger?: Logger;
  fetchImpl?: FetchLike;
  WebSocketImpl?: WebSocketConstructor;
  /** Seed history from candles when a symbol is first tracked. */
  backfill?: boolean;
  onBackfill?: (symbol: string, samples: PriceSample[]) => void;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  supportedRefreshMs?: number;
  now?: () => number;
}

interface MiniTicker {
  e: string;
  E: number;
  s: string;
  c: string;
}

/**
 * Binance spot WebSocket feed. One combined stream connection carries every
 * tracked symbol; subscriptions are adjusted live with SUBSCRIBE messages.
 * USDT pairs stand in for USD prices.
 */
export class BinanceFeed implements PriceFeed {
  readonly name = 'binance';
  readonly priority = 2;

  private readonly restBaseUrl: string;
  private readonly wsUrl: string;
  private readonly quoteAsset: string;
  private readonly logger: Logger;
  private readonly fetchImpl: FetchLike;
  private readonly WebSocketImpl: WebSocketConstructor;
  private readonly backfill: boolean;
  private readonly onBackfill: ((symbol: string, samples: PriceSample[]) => void) | undefined;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly supportedRefreshMs: number;
  private readonly now: () => number;

  private listeners: TickListener[] = [];
  private supported = new Set<string>();
  private wanted = new Set<string>();
  private subscribed = new Set<string>();
  private backfilled = new Set<string>();
  private ws: WebSocketLike | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private supportedTimer: NodeJS.Timeout | null = null;
  private messageId = 0;

  constructor(options: BinanceFeedOptions = {}) {
    this.restBaseUrl = options.restBaseUrl ?? 'https://api.binance.com';
    this.wsUrl = options.wsUrl ?? 'wss://stream.binance.com:9443/stream';
    this.quoteAsset = (options.quote ?? 'USDT').toUpperCase();
    this.logger = options.logger ?? silentLogger;
    this.fetchImpl = options.fetchImpl ?? globalFetch();
    this.WebSocketImpl = options.WebSocketImpl ?? globalWebSocket();
    this.backfill = options.backfill ?? true;
    this.onBackfill = options.onBackfill;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
    this.supportedRefreshMs = options.supportedRefreshMs ?? 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  onTick(listener: TickListener): void {
    this.listeners.push(listener);
  }

  supports(symbol: string): boolean {
    return this.supported.has(symbol.toUpperCase());
  }

  supportedSymbols(): string[] {
    return [...this.supported].sort();
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.loadSupported();
    this.supportedTimer = setInterval(() => void this.loadSupported(), this.supportedRefreshMs);
    this.supportedTimer.unref();
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.supportedTimer) clearInterval(this.supportedTimer);
    this.reconnectTimer = null;
    this.supportedTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  setSymbols(symbols: readonly string[]): void {
    this.wanted = new Set(symbols.map((s) => s.toUpperCase()).filter((s) => this.supports(s)));
    this.syncSubscriptions();
    if (this.backfill) {
      for (const symbol of this.wanted) {
        if (!this.backfilled.has(symbol)) {
          this.backfilled.add(symbol);
          void this.backfillSymbol(symbol);
        }
      }
    }
  }

  async quote(symbol: string): Promise<PriceTick | undefined> {
    const upper = symbol.toUpperCase();
    if (!this.supports(upper)) return undefined;
    try {
      const res = await this.fetchImpl(`${this.restBaseUrl}/api/v3/ticker/price?symbol=${this.pair(upper)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { price?: unknown };
      const price = Number(body.price);
      if (!Number.isFinite(price) || price <= 0) return undefined;
      return { symbol: upper, price, at: this.now(), source: this.name };
    } catch (err) {
      this.logger.warn('binance quote failed', { symbol: upper, err });
      return undefined;
    }
  }

  /** Loads every pair quoted in the quote asset so `supports()` answers instantly. */
  async loadSupported(): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.restBaseUrl}/api/v3/ticker/price`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as Array<{ symbol?: unknown }>;
      const next = new Set<string>();
      for (const row of rows) {
        if (typeof row.symbol !== 'string') continue;
        if (row.symbol.endsWith(this.quoteAsset) && row.symbol.length > this.quoteAsset.length) {
          next.add(row.symbol.slice(0, -this.quoteAsset.length));
        }
      }
      if (next.size > 0) this.supported = next;
      this.logger.info('binance supported symbols loaded', { count: this.supported.size });
    } catch (err) {
      this.logger.error('binance supported symbols failed', { err });
    }
  }

  private pair(symbol: string): string {
    return `${symbol}${this.quoteAsset}`;
  }

  private stream(symbol: string): string {
    return `${this.pair(symbol).toLowerCase()}@miniTicker`;
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocketLike;
    try {
      ws = new this.WebSocketImpl(this.wsUrl);
    } catch (err) {
      this.logger.error('binance websocket construct failed', { err });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.attempt = 0;
      this.subscribed.clear();
      this.logger.info('binance websocket open');
      this.syncSubscriptions();
    });
    ws.addEventListener('message', (event) => this.handleMessage(event.data));
    ws.addEventListener('error', (event) => {
      this.logger.warn('binance websocket error', { event: String((event as { message?: string })?.message ?? event) });
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null;
      this.subscribed.clear();
      if (!this.stopped) {
        this.logger.warn('binance websocket closed; reconnecting');
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private syncSubscriptions(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return;
    const add = [...this.wanted].filter((s) => !this.subscribed.has(s));
    const remove = [...this.subscribed].filter((s) => !this.wanted.has(s));
    if (add.length > 0) {
      ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: add.map((s) => this.stream(s)), id: ++this.messageId }));
      for (const s of add) this.subscribed.add(s);
    }
    if (remove.length > 0) {
      ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: remove.map((s) => this.stream(s)), id: ++this.messageId }));
      for (const s of remove) this.subscribed.delete(s);
    }
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: { stream?: unknown; data?: unknown };
    try {
      msg = JSON.parse(raw) as { stream?: unknown; data?: unknown };
    } catch {
      return;
    }
    if (typeof msg.stream !== 'string' || !msg.stream.endsWith('@miniTicker')) return;
    const data = msg.data as Partial<MiniTicker> | undefined;
    if (!data || typeof data.s !== 'string' || typeof data.c !== 'string') return;
    if (!data.s.endsWith(this.quoteAsset)) return;
    const tick: PriceTick = {
      symbol: data.s.slice(0, -this.quoteAsset.length),
      price: Number(data.c),
      at: typeof data.E === 'number' ? data.E : this.now(),
      source: this.name,
    };
    if (!Number.isFinite(tick.price)) return;
    for (const listener of this.listeners) listener(tick);
  }

  /** Seeds about 25 hours of 5 minute closes so window alerts work immediately. */
  private async backfillSymbol(symbol: string): Promise<void> {
    if (!this.onBackfill) return;
    try {
      const url = `${this.restBaseUrl}/api/v3/klines?symbol=${this.pair(symbol)}&interval=5m&limit=300`;
      const res = await this.fetchImpl(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as unknown[];
      const samples: PriceSample[] = [];
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const close = Number(row[4]);
        const closeTime = Number(row[6]);
        if (Number.isFinite(close) && Number.isFinite(closeTime)) samples.push({ at: closeTime, price: close });
      }
      samples.sort((a, b) => a.at - b.at);
      // The last candle is still open; its close time lies in the future. Clamp it to now.
      const now = this.now();
      for (const s of samples) if (s.at > now) s.at = now;
      this.onBackfill(symbol, samples);
      this.logger.debug('binance backfill done', { symbol, samples: samples.length });
    } catch (err) {
      this.backfilled.delete(symbol);
      this.logger.warn('binance backfill failed', { symbol, err });
    }
  }
}
