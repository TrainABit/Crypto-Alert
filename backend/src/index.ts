import { serve } from '@hono/node-server';
import { createApp } from './api/app.ts';
import { AppleJwksVerifier } from './api/apple-auth.ts';
import { EntitlementService } from './billing/entitlements.ts';
import { AppleAppStoreVerifier, type AppStoreVerifier } from './billing/verifier.ts';
import { loadConfig } from './config.ts';
import { PriceBook } from './domain/price-book.ts';
import { coingeckoIdsFromCatalogue } from './domain/symbols.ts';
import { AlertEngine } from './engine/engine.ts';
import { BinanceFeed } from './feeds/binance.ts';
import { CoinGeckoFeed } from './feeds/coingecko.ts';
import type { PriceFeed } from './feeds/feed.ts';
import { FeedManager } from './feeds/manager.ts';
import { createLogger } from './logger.ts';
import { ApnsClient } from './push/apns.ts';
import { LogNotifier, type Notifier } from './push/notifier.ts';
import { MemoryStore } from './store/memory.ts';
import { createPostgresStore } from './store/postgres.ts';
import type { Store } from './store/store.ts';

const PINNED_SYMBOLS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'TON'];

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, { service: 'crypto-alert' });

  let store: Store;
  if (config.databaseUrl) {
    store = await createPostgresStore(config.databaseUrl, logger);
    logger.info('postgres store ready');
  } else {
    store = new MemoryStore();
    logger.warn('DATABASE_URL not set: using the in-memory store; all data is lost on restart');
  }

  const priceBook = new PriceBook({ sourcePriority: { binance: 2, coingecko: 1 } });

  let notifier: Notifier;
  if (config.apns) {
    notifier = new ApnsClient(config.apns, { logger });
    logger.info('apns client ready', { bundleId: config.apns.bundleId });
  } else {
    notifier = new LogNotifier(logger);
    logger.warn('APNS_* not set: pushes are logged instead of sent');
  }

  const engine = new AlertEngine({
    store,
    priceBook,
    notifier,
    logger,
    hysteresisPercent: config.engine.hysteresisPercent,
    indexRefreshMs: config.engine.indexRefreshMs,
  });

  const feeds: PriceFeed[] = [];
  for (const name of config.feeds) {
    if (name === 'binance') {
      feeds.push(
        new BinanceFeed({ logger, backfill: config.binanceBackfill, onBackfill: (symbol, samples) => priceBook.seed(symbol, samples) }),
      );
    } else if (name === 'coingecko') {
      feeds.push(
        new CoinGeckoFeed({
          ids: coingeckoIdsFromCatalogue(config.coingecko.extraIds),
          pollMs: config.coingecko.pollSeconds * 1000,
          apiKey: config.coingecko.apiKey,
          logger,
        }),
      );
    } else {
      logger.warn('unknown feed ignored', { name });
    }
  }
  if (feeds.length === 0) throw new Error('no price feeds configured');
  const feedManager = new FeedManager(feeds, engine, logger, { pinnedSymbols: PINNED_SYMBOLS });

  let verifier: AppStoreVerifier | null = null;
  if (config.appStore) {
    try {
      verifier = new AppleAppStoreVerifier(config.appStore, logger);
      logger.info('app store verifier ready', { environment: config.appStore.environment, bundleId: config.appStore.bundleId });
    } catch (err) {
      logger.error('app store verifier disabled', { err });
    }
  } else {
    logger.warn('APPSTORE_BUNDLE_ID/APNS_BUNDLE_ID not set: purchases cannot be verified');
  }
  const entitlements = new EntitlementService(store, config.appStore?.proProductIds ?? [], logger);
  const appleAuth = config.appleSignInBundleId ? new AppleJwksVerifier({ audience: config.appleSignInBundleId }) : null;

  const app = createApp({
    store,
    engine,
    priceBook,
    prices: feedManager,
    entitlements,
    logger,
    appleAuth,
    verifier,
    appStoreBundleId: config.appStore?.bundleId ?? null,
    feedNames: feedManager.feedNames(),
    version: process.env.npm_package_version ?? 'dev',
  });

  await engine.start();
  await feedManager.start();
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info('api listening', { port: info.port, env: config.nodeEnv });
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { signal });
    server.close();
    await feedManager.stop();
    await engine.stop();
    await notifier.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
