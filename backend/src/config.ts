import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { LOG_LEVELS } from './logger.ts';

const DEFAULT_PRODUCT_IDS = [
  'com.trainabit.cryptoalert.pro.monthly',
  'com.trainabit.cryptoalert.pro.yearly',
  'com.trainabit.cryptoalert.pro.lifetime',
];

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  /** Postgres connection string. Without it the server keeps everything in memory (development only). */
  DATABASE_URL: z.string().min(1).optional(),

  /** Comma separated feed names in priority order. */
  FEEDS: z.string().default('binance,coingecko'),
  COINGECKO_API_KEY: z.string().min(1).optional(),
  COINGECKO_POLL_SECONDS: z.coerce.number().int().min(15).max(3600).default(60),
  /** Extra symbol to CoinGecko id mappings: "PEPE=pepe,WIF=dogwifcoin". */
  COINGECKO_IDS: z.string().optional(),
  BINANCE_BACKFILL: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /** Engine tuning. */
  HYSTERESIS_PERCENT: z.coerce.number().min(0).max(10).default(0.5),
  STALE_AFTER_SECONDS: z.coerce.number().int().min(5).default(90),
  INDEX_REFRESH_SECONDS: z.coerce.number().int().min(5).default(30),

  /** APNs token based authentication. All four are needed to send real pushes. */
  APNS_TEAM_ID: z.string().min(1).optional(),
  APNS_KEY_ID: z.string().min(1).optional(),
  APNS_PRIVATE_KEY: z.string().min(1).optional(),
  APNS_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  APNS_BUNDLE_ID: z.string().min(1).optional(),

  /** App Store server side verification. */
  APPSTORE_BUNDLE_ID: z.string().min(1).optional(),
  APPSTORE_ENVIRONMENT: z.enum(['Sandbox', 'Production']).default('Sandbox'),
  APPSTORE_APP_APPLE_ID: z.coerce.number().int().optional(),
  APPLE_ROOT_CERTS_DIR: z.string().default('./certs'),
  PRO_PRODUCT_IDS: z.string().default(DEFAULT_PRODUCT_IDS.join(',')),

  /** Audience for Sign in with Apple identity tokens; defaults to the bundle id. */
  APPLE_SIGN_IN_BUNDLE_ID: z.string().min(1).optional(),
});

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  /** PEM encoded .p8 contents. */
  privateKey: string;
  bundleId: string;
}

export interface AppStoreConfig {
  bundleId: string;
  environment: 'Sandbox' | 'Production';
  appAppleId: number | undefined;
  rootCertsDir: string;
  proProductIds: string[];
}

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: (typeof LOG_LEVELS)[number];
  databaseUrl: string | undefined;
  feeds: string[];
  coingecko: { apiKey: string | undefined; pollSeconds: number; extraIds: Record<string, string> };
  binanceBackfill: boolean;
  engine: { hysteresisPercent: number; staleAfterMs: number; indexRefreshMs: number };
  apns: ApnsConfig | null;
  appStore: AppStoreConfig | null;
  appleSignInBundleId: string | null;
}

function parsePairs(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if (k && v) out[k.toUpperCase()] = v;
  }
  return out;
}

function readPrivateKey(env: z.infer<typeof envSchema>): string | undefined {
  if (env.APNS_PRIVATE_KEY) return env.APNS_PRIVATE_KEY.replace(/\\n/g, '\n');
  if (env.APNS_PRIVATE_KEY_PATH) return readFileSync(env.APNS_PRIVATE_KEY_PATH, 'utf8');
  return undefined;
}

/** Drops empty strings so `KEY=` lines in .env files behave like unset variables. */
function withoutBlanks(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') out[key] = value;
  }
  return out;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const env = envSchema.parse(withoutBlanks(source));
  const privateKey = readPrivateKey(env);
  const apns =
    env.APNS_TEAM_ID && env.APNS_KEY_ID && privateKey && env.APNS_BUNDLE_ID
      ? { teamId: env.APNS_TEAM_ID, keyId: env.APNS_KEY_ID, privateKey, bundleId: env.APNS_BUNDLE_ID }
      : null;
  const bundleId = env.APPSTORE_BUNDLE_ID ?? env.APNS_BUNDLE_ID;
  const appStore: AppStoreConfig | null = bundleId
    ? {
        bundleId,
        environment: env.APPSTORE_ENVIRONMENT,
        appAppleId: env.APPSTORE_APP_APPLE_ID,
        rootCertsDir: env.APPLE_ROOT_CERTS_DIR,
        proProductIds: env.PRO_PRODUCT_IDS.split(',').map((s) => s.trim()).filter(Boolean),
      }
    : null;

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    feeds: env.FEEDS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    coingecko: { apiKey: env.COINGECKO_API_KEY, pollSeconds: env.COINGECKO_POLL_SECONDS, extraIds: parsePairs(env.COINGECKO_IDS) },
    binanceBackfill: env.BINANCE_BACKFILL,
    engine: {
      hysteresisPercent: env.HYSTERESIS_PERCENT,
      staleAfterMs: env.STALE_AFTER_SECONDS * 1000,
      indexRefreshMs: env.INDEX_REFRESH_SECONDS * 1000,
    },
    apns,
    appStore,
    appleSignInBundleId: env.APPLE_SIGN_IN_BUNDLE_ID ?? bundleId ?? null,
  };
}
