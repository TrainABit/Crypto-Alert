import type { PriceTick } from '../domain/price-book.ts';
import type { AlertEngine } from '../engine/engine.ts';
import type { Logger } from '../logger.ts';
import type { PriceFeed } from './feed.ts';

export interface FeedManagerOptions {
  /** Symbols streamed at all times, so the app can show live prices without alerts. */
  pinnedSymbols?: string[];
}

/** What the API needs from the feeds: support checks and one-off quotes. */
export interface PriceSource {
  supports(symbol: string): boolean;
  quote(symbol: string): Promise<PriceTick | undefined>;
}

/** Wires feeds to the engine and keeps their symbol subscriptions in sync with tracked alerts. */
export class FeedManager implements PriceSource {
  private unsubscribe: (() => void) | null = null;
  private readonly feeds: PriceFeed[];
  private readonly engine: AlertEngine;
  private readonly logger: Logger;
  private readonly pinned: string[];

  constructor(feeds: PriceFeed[], engine: AlertEngine, logger: Logger, options: FeedManagerOptions = {}) {
    this.feeds = [...feeds].sort((a, b) => b.priority - a.priority);
    this.engine = engine;
    this.logger = logger;
    this.pinned = (options.pinnedSymbols ?? []).map((s) => s.toUpperCase());
  }

  async start(): Promise<void> {
    for (const feed of this.feeds) {
      feed.onTick((tick) => {
        void this.engine.handleTick(tick).catch((err: unknown) => this.logger.error('tick handling failed', { err }));
      });
      await feed.start();
      this.logger.info('feed started', { feed: feed.name });
    }
    this.unsubscribe = this.engine.onSymbolsChanged((symbols) => this.distribute(symbols));
    this.distribute(this.engine.trackedSymbols());
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const feed of this.feeds) await feed.stop();
  }

  /** Whether any feed can price the symbol. */
  supports(symbol: string): boolean {
    return this.feeds.some((f) => f.supports(symbol));
  }

  /** Asks feeds in priority order for a fresh price and records it in the price book via the engine. */
  async quote(symbol: string): Promise<PriceTick | undefined> {
    for (const feed of this.feeds) {
      if (!feed.supports(symbol)) continue;
      const tick = await feed.quote(symbol);
      if (tick) {
        await this.engine.handleTick(tick);
        return tick;
      }
    }
    return undefined;
  }

  feedNames(): string[] {
    return this.feeds.map((f) => f.name);
  }

  private distribute(symbols: string[]): void {
    const all = [...new Set([...symbols, ...this.pinned])];
    for (const feed of this.feeds) {
      const mine = all.filter((s) => feed.supports(s));
      feed.setSymbols(mine);
      this.logger.debug('feed symbols updated', { feed: feed.name, count: mine.length });
    }
  }
}
