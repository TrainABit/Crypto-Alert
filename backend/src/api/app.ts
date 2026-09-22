import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z, type ZodTypeAny } from 'zod';
import { AppleAuthError, type AppleIdTokenVerifier } from './apple-auth.ts';
import { EntitlementService } from '../billing/entitlements.ts';
import { VerificationError, type AppStoreVerifier } from '../billing/verifier.ts';
import {
  createAlertSchema,
  initialArmedState,
  serializeAlert,
  symbolSchema,
  updateAlertSchema,
  type Alert,
} from '../domain/alert.ts';
import { PLANS, checkAlertAgainstPlan, serializePlan } from '../domain/plan.ts';
import type { PriceBook, PriceTick } from '../domain/price-book.ts';
import { SYMBOL_CATALOGUE } from '../domain/symbols.ts';
import type { AlertEngine } from '../engine/engine.ts';
import type { PriceSource } from '../feeds/manager.ts';
import type { Logger } from '../logger.ts';
import type { Store, User } from '../store/store.ts';

export interface ApiDeps {
  store: Store;
  engine: AlertEngine;
  priceBook: PriceBook;
  prices: PriceSource;
  entitlements: EntitlementService;
  logger: Logger;
  /** Null disables Sign in with Apple. */
  appleAuth: AppleIdTokenVerifier | null;
  /** Null disables purchase verification. */
  verifier: AppStoreVerifier | null;
  appStoreBundleId: string | null;
  feedNames?: string[];
  now?: () => Date;
  version?: string;
}

type Env = { Variables: { userId: string; sessionToken: string } };

const FRESH_QUOTE_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(c: Context, status: ContentfulStatusCode, code: string, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ error: { code, message, ...extra } }, status);
}

async function parseBody<T extends ZodTypeAny>(c: Context, schema: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: fail(c, 400, 'invalid_json', 'Body must be valid JSON') };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: fail(c, 422, 'validation_failed', 'Request failed validation', { issues: parsed.error.issues }) };
  }
  return { ok: true, data: parsed.data };
}

function serializeUser(user: User) {
  return {
    id: user.id,
    plan: user.plan,
    planExpiresAt: user.planExpiresAt?.toISOString() ?? null,
    appleLinked: user.appleSub !== null,
    createdAt: user.createdAt.toISOString(),
  };
}

function serializeTick(tick: PriceTick, change24h: number | undefined) {
  return {
    symbol: tick.symbol,
    price: tick.price,
    at: new Date(tick.at).toISOString(),
    source: tick.source,
    change24h: change24h === undefined || !Number.isFinite(change24h) ? null : Number(change24h.toFixed(4)),
  };
}

const deviceSchema = z.object({
  token: z.string().regex(/^[0-9a-fA-F]{32,512}$/, 'token must be the hex APNs device token'),
  environment: z.enum(['sandbox', 'production']),
  appVersion: z.string().max(40).nullable().optional(),
});

const appleAuthSchema = z.object({ identityToken: z.string().min(20) });
const transactionSchema = z.object({ jws: z.string().min(20) });
const notificationSchema = z.object({ signedPayload: z.string().min(20) });

export function createApp(deps: ApiDeps): Hono<Env> {
  const { store, engine, priceBook, prices, entitlements, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const startedAt = Date.now();

  const app = new Hono<Env>();

  app.onError((err, c) => {
    logger.error('unhandled api error', { err, path: c.req.path });
    return fail(c, 500, 'internal_error', 'Something went wrong');
  });
  app.notFound((c) => fail(c, 404, 'not_found', 'No such route'));

  /** Resolves a bearer session token; sets userId when valid. */
  const requireAuth = createMiddleware<Env>(async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return fail(c, 401, 'unauthorized', 'Missing bearer token');
    const userId = await store.getSessionUserId(token);
    if (!userId) return fail(c, 401, 'unauthorized', 'Session is not valid');
    c.set('userId', userId);
    c.set('sessionToken', token);
    await next();
  });

  const optionalUser = async (c: Context<Env>): Promise<User | null> => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return null;
    const userId = await store.getSessionUserId(token);
    return userId ? store.getUser(userId) : null;
  };

  /** Latest known price, refreshed through the feeds when stale or unknown. */
  const currentPrice = async (symbol: string): Promise<PriceTick | undefined> => {
    const latest = priceBook.latest(symbol);
    if (latest && now().getTime() - latest.at < FRESH_QUOTE_MS) return latest;
    const fresh = await prices.quote(symbol);
    return fresh ?? latest;
  };

  const planResponse = (user: User) => ({ user: serializeUser(user), limits: serializePlan(PLANS[user.plan]) });

  // ---------- public ----------
  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      version: deps.version ?? 'dev',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      engine: engine.stats(),
      feeds: deps.feedNames ?? [],
      appleSignIn: deps.appleAuth !== null,
      purchases: deps.verifier !== null,
    }),
  );

  app.post('/v1/auth/anonymous', async (c) => {
    const user = await store.createUser();
    const token = await store.createSession(user.id);
    logger.info('anonymous user created', { userId: user.id });
    return c.json({ token, ...planResponse(user) }, 201);
  });

  app.post('/v1/auth/apple', async (c) => {
    if (!deps.appleAuth) return fail(c, 503, 'apple_sign_in_unavailable', 'Sign in with Apple is not configured');
    const body = await parseBody(c, appleAuthSchema);
    if (!body.ok) return body.response;
    let identity;
    try {
      identity = await deps.appleAuth.verify(body.data.identityToken);
    } catch (err) {
      if (err instanceof AppleAuthError) return fail(c, 401, 'apple_token_invalid', err.message);
      throw err;
    }
    const current = await optionalUser(c);
    const existing = await store.findUserByAppleSub(identity.sub);

    let user: User;
    if (existing) {
      user = existing;
      if (current && current.id !== existing.id && current.appleSub === null) {
        // The anonymous account merges into the real one: alerts and devices move over.
        for (const alert of await store.listAlerts(current.id)) {
          await store.createAlert({
            userId: existing.id,
            symbol: alert.symbol,
            quote: alert.quote,
            condition: alert.condition,
            repeat: alert.repeat,
            cooldownMinutes: alert.cooldownMinutes,
            armed: alert.armed,
            note: alert.note,
          });
        }
        for (const device of await store.listDevices(current.id)) {
          await store.upsertDevice({ ...device, userId: existing.id });
        }
        await store.deleteUser(current.id);
        engine.invalidate();
        logger.info('anonymous account merged', { from: current.id, into: existing.id });
      }
    } else if (current && current.appleSub === null) {
      user = await store.linkAppleSub(current.id, identity.sub);
    } else {
      user = await store.createUser({ appleSub: identity.sub });
    }
    const token = await store.createSession(user.id);
    return c.json({ token, ...planResponse(user) });
  });

  app.post('/v1/billing/appstore-notifications', async (c) => {
    if (!deps.verifier) return fail(c, 503, 'purchases_unavailable', 'Purchase verification is not configured');
    const body = await parseBody(c, notificationSchema);
    if (!body.ok) return body.response;
    let notification;
    try {
      notification = await deps.verifier.verifyNotification(body.data.signedPayload);
    } catch (err) {
      if (err instanceof VerificationError) return fail(c, 401, 'notification_invalid', err.message);
      throw err;
    }
    const result = await entitlements.handleNotification(notification);
    logger.info('app store notification', { type: notification.notificationType, subtype: notification.subtype, ...result });
    return c.json({ handled: result.handled });
  });

  app.get('/v1/symbols', (c) =>
    c.json({
      symbols: SYMBOL_CATALOGUE.map((e) => ({ symbol: e.symbol, name: e.name, supported: prices.supports(e.symbol) })),
      customSymbolsAllowed: true,
    }),
  );

  // ---------- authenticated ----------
  const authed = new Hono<Env>();
  authed.use('*', requireAuth);

  authed.get('/me', async (c) => {
    const user = await store.getUser(c.get('userId'));
    if (!user) return fail(c, 401, 'unauthorized', 'User no longer exists');
    const [activeAlerts, devices] = await Promise.all([store.countActiveAlerts(user.id), store.listDevices(user.id)]);
    return c.json({ ...planResponse(user), counts: { activeAlerts, devices: devices.length } });
  });

  authed.delete('/me', async (c) => {
    await store.deleteUser(c.get('userId'));
    engine.invalidate();
    logger.info('account deleted', { userId: c.get('userId') });
    return c.body(null, 204);
  });

  authed.post('/auth/logout', async (c) => {
    await store.deleteSession(c.get('sessionToken'));
    return c.body(null, 204);
  });

  authed.put('/devices', async (c) => {
    const body = await parseBody(c, deviceSchema);
    if (!body.ok) return body.response;
    const device = await store.upsertDevice({
      token: body.data.token.toLowerCase(),
      userId: c.get('userId'),
      environment: body.data.environment,
      appVersion: body.data.appVersion ?? null,
    });
    return c.json({ device: { token: device.token, environment: device.environment, updatedAt: device.updatedAt.toISOString() } });
  });

  authed.delete('/devices/:token', async (c) => {
    const token = c.req.param('token').toLowerCase();
    const mine = (await store.listDevices(c.get('userId'))).some((d) => d.token === token);
    if (!mine) return fail(c, 404, 'not_found', 'No such device');
    await store.removeDevice(token);
    return c.body(null, 204);
  });

  authed.get('/alerts', async (c) => {
    const alerts = await store.listAlerts(c.get('userId'));
    return c.json({ alerts: alerts.map(serializeAlert) });
  });

  authed.get('/alerts/events', async (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
    const events = await store.listEvents(c.get('userId'), limit);
    return c.json({
      events: events.map((e) => ({
        id: e.id,
        alertId: e.alertId,
        symbol: e.symbol,
        price: e.price,
        title: e.title,
        body: e.body,
        firedAt: e.firedAt.toISOString(),
        delivered: e.deliveredCount > 0,
      })),
    });
  });

  authed.post('/alerts', async (c) => {
    const body = await parseBody(c, createAlertSchema);
    if (!body.ok) return body.response;
    const input = body.data;
    const user = await store.getUser(c.get('userId'));
    if (!user) return fail(c, 401, 'unauthorized', 'User no longer exists');
    if (!prices.supports(input.symbol)) {
      return fail(c, 422, 'unsupported_symbol', `No price feed covers ${input.symbol}`);
    }
    const activeCount = await store.countActiveAlerts(user.id);
    const violation = checkAlertAgainstPlan(PLANS[user.plan], activeCount, input, true);
    if (violation) return fail(c, violation.upgrade ? 402 : 403, violation.code, violation.message, { upgrade: violation.upgrade });

    const tick = await currentPrice(input.symbol);
    const alert = await store.createAlert({
      userId: user.id,
      symbol: input.symbol,
      quote: 'USD',
      condition: input.condition,
      repeat: input.repeat,
      cooldownMinutes: input.cooldownMinutes,
      armed: initialArmedState(input.condition, tick?.price),
      note: input.note,
    });
    engine.invalidate();
    logger.info('alert created', { userId: user.id, alertId: alert.id, symbol: alert.symbol, kind: alert.condition.kind });
    return c.json({ alert: serializeAlert(alert), currentPrice: tick ? serializeTick(tick, undefined) : null }, 201);
  });

  const ownAlert = async (c: Context<Env>): Promise<Alert | null> => {
    const alert = await store.getAlert(c.req.param('id') ?? '');
    return alert && alert.userId === c.get('userId') ? alert : null;
  };

  authed.patch('/alerts/:id', async (c) => {
    const alert = await ownAlert(c);
    if (!alert) return fail(c, 404, 'not_found', 'No such alert');
    const body = await parseBody(c, updateAlertSchema);
    if (!body.ok) return body.response;
    const patch = body.data;
    const user = await store.getUser(c.get('userId'));
    if (!user) return fail(c, 401, 'unauthorized', 'User no longer exists');

    const nextShape = {
      condition: patch.condition ?? alert.condition,
      repeat: patch.repeat ?? alert.repeat,
      cooldownMinutes: patch.cooldownMinutes ?? alert.cooldownMinutes,
    };
    const nextStatus = patch.status ?? (alert.status === 'triggered' && (patch.condition || patch.repeat !== undefined) ? 'active' : alert.status);
    const becomesActive = nextStatus === 'active' && alert.status !== 'active';
    const activeCount = await store.countActiveAlerts(user.id);
    const violation = checkAlertAgainstPlan(PLANS[user.plan], activeCount, nextShape, becomesActive);
    if (violation) return fail(c, violation.upgrade ? 402 : 403, violation.code, violation.message, { upgrade: violation.upgrade });

    const storePatch: Parameters<Store['updateAlert']>[1] = {};
    if (patch.condition !== undefined) storePatch.condition = patch.condition;
    if (patch.repeat !== undefined) storePatch.repeat = patch.repeat;
    if (patch.cooldownMinutes !== undefined) storePatch.cooldownMinutes = patch.cooldownMinutes;
    if (patch.note !== undefined) storePatch.note = patch.note;
    if (nextStatus !== alert.status) storePatch.status = nextStatus;
    if (patch.condition !== undefined || becomesActive) {
      const tick = await currentPrice(alert.symbol);
      storePatch.armed = initialArmedState(nextShape.condition, tick?.price);
    }
    const updated = await store.updateAlert(alert.id, storePatch);
    if (!updated) return fail(c, 404, 'not_found', 'No such alert');
    engine.invalidate();
    return c.json({ alert: serializeAlert(updated) });
  });

  authed.delete('/alerts/:id', async (c) => {
    const alert = await ownAlert(c);
    if (!alert) return fail(c, 404, 'not_found', 'No such alert');
    await store.deleteAlert(alert.id);
    engine.invalidate();
    return c.body(null, 204);
  });

  authed.get('/prices', async (c) => {
    const raw = (c.req.query('symbols') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
    const symbols = [...new Set(raw.map((s) => symbolSchema.safeParse(s)).filter((r) => r.success).map((r) => r.data))];
    const out: Record<string, ReturnType<typeof serializeTick> | null> = {};
    await Promise.all(
      symbols.map(async (symbol) => {
        const tick = prices.supports(symbol) ? await currentPrice(symbol) : undefined;
        out[symbol] = tick ? serializeTick(tick, priceBook.changePercent(symbol, DAY_MS, now().getTime())) : null;
      }),
    );
    return c.json({ prices: out });
  });

  authed.post('/billing/transactions', async (c) => {
    if (!deps.verifier) return fail(c, 503, 'purchases_unavailable', 'Purchase verification is not configured');
    const body = await parseBody(c, transactionSchema);
    if (!body.ok) return body.response;
    let tx;
    try {
      tx = await deps.verifier.verifyTransaction(body.data.jws);
    } catch (err) {
      if (err instanceof VerificationError) return fail(c, 400, 'transaction_invalid', err.message);
      throw err;
    }
    if (deps.appStoreBundleId && tx.bundleId && tx.bundleId !== deps.appStoreBundleId) {
      return fail(c, 400, 'transaction_invalid', 'Transaction belongs to another app');
    }
    const entitlement = await entitlements.applyTransaction(c.get('userId'), tx, null);
    const user = await store.getUser(c.get('userId'));
    if (!user) return fail(c, 401, 'unauthorized', 'User no longer exists');
    return c.json({ plan: entitlement.plan, expiresAt: entitlement.expiresAt?.toISOString() ?? null, ...planResponse(user) });
  });

  authed.get('/billing/status', async (c) => {
    const entitlement = await entitlements.recompute(c.get('userId'));
    const subscriptions = await store.listSubscriptions(c.get('userId'));
    return c.json({
      plan: entitlement.plan,
      expiresAt: entitlement.expiresAt?.toISOString() ?? null,
      subscriptions: subscriptions.map((s) => ({
        productId: s.productId,
        status: s.status,
        environment: s.environment,
        expiresAt: s.expiresAt?.toISOString() ?? null,
      })),
    });
  });

  app.route('/v1', authed);
  return app;
}
