import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Alert, AlertCondition } from '../domain/alert.ts';
import type { PlanId } from '../domain/plan.ts';
import type { Logger } from '../logger.ts';
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

/** The subset of a pg Pool (or PGlite instance) the store needs. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface Migration {
  version: number;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
         id uuid PRIMARY KEY,
         apple_sub text UNIQUE,
         plan text NOT NULL DEFAULT 'free',
         plan_expires_at timestamptz,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE TABLE IF NOT EXISTS sessions (
         token text PRIMARY KEY,
         user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)`,
      `CREATE TABLE IF NOT EXISTS devices (
         token text PRIMARY KEY,
         user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         environment text NOT NULL,
         platform text NOT NULL DEFAULT 'ios',
         app_version text,
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS devices_user_idx ON devices(user_id)`,
      `CREATE TABLE IF NOT EXISTS alerts (
         id uuid PRIMARY KEY,
         user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         symbol text NOT NULL,
         quote text NOT NULL DEFAULT 'USD',
         condition jsonb NOT NULL,
         repeat boolean NOT NULL DEFAULT false,
         cooldown_minutes int NOT NULL DEFAULT 60,
         status text NOT NULL DEFAULT 'active',
         armed boolean NOT NULL DEFAULT true,
         note text,
         last_triggered_at timestamptz,
         trigger_count int NOT NULL DEFAULT 0,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS alerts_user_idx ON alerts(user_id)`,
      `CREATE INDEX IF NOT EXISTS alerts_active_symbol_idx ON alerts(symbol) WHERE status = 'active'`,
      `CREATE TABLE IF NOT EXISTS alert_events (
         id uuid PRIMARY KEY,
         alert_id uuid REFERENCES alerts(id) ON DELETE SET NULL,
         user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         symbol text NOT NULL,
         price double precision NOT NULL,
         title text NOT NULL,
         body text NOT NULL,
         fired_at timestamptz NOT NULL,
         delivered_count int NOT NULL DEFAULT 0
       )`,
      `CREATE INDEX IF NOT EXISTS alert_events_user_idx ON alert_events(user_id, fired_at DESC)`,
      `CREATE TABLE IF NOT EXISTS subscriptions (
         original_transaction_id text PRIMARY KEY,
         user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         product_id text NOT NULL,
         environment text NOT NULL,
         status text NOT NULL,
         expires_at timestamptz,
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions(user_id)`,
    ],
  },
];

/** Applies pending migrations. Statements are idempotent, so a crash mid-way is safe to retry. */
export async function migrate(db: Queryable, logger?: Logger): Promise<number[]> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const { rows } = await db.query(`SELECT version FROM schema_migrations`);
  const applied = new Set(rows.map((r) => Number(r.version)));
  const done: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    for (const statement of m.statements) await db.query(statement);
    await db.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [m.version]);
    done.push(m.version);
    logger?.info('migration applied', { version: m.version });
  }
  return done;
}

const toDate = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string));
const toDateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : toDate(v));
const toJson = <T>(v: unknown): T => (typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));

function rowToUser(r: Record<string, unknown>): User {
  return {
    id: String(r.id),
    appleSub: r.apple_sub === null || r.apple_sub === undefined ? null : String(r.apple_sub),
    plan: String(r.plan) as PlanId,
    planExpiresAt: toDateOrNull(r.plan_expires_at),
    createdAt: toDate(r.created_at),
  };
}

function rowToDevice(r: Record<string, unknown>): Device {
  return {
    token: String(r.token),
    userId: String(r.user_id),
    environment: String(r.environment) as Device['environment'],
    platform: String(r.platform),
    appVersion: r.app_version === null || r.app_version === undefined ? null : String(r.app_version),
    updatedAt: toDate(r.updated_at),
  };
}

function rowToAlert(r: Record<string, unknown>): Alert {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    symbol: String(r.symbol),
    quote: String(r.quote),
    condition: toJson<AlertCondition>(r.condition),
    repeat: Boolean(r.repeat),
    cooldownMinutes: Number(r.cooldown_minutes),
    status: String(r.status) as Alert['status'],
    armed: Boolean(r.armed),
    note: r.note === null || r.note === undefined ? null : String(r.note),
    lastTriggeredAt: toDateOrNull(r.last_triggered_at),
    triggerCount: Number(r.trigger_count),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

function rowToEvent(r: Record<string, unknown>): AlertEvent {
  return {
    id: String(r.id),
    alertId: r.alert_id === null || r.alert_id === undefined ? null : String(r.alert_id),
    userId: String(r.user_id),
    symbol: String(r.symbol),
    price: Number(r.price),
    title: String(r.title),
    body: String(r.body),
    firedAt: toDate(r.fired_at),
    deliveredCount: Number(r.delivered_count),
  };
}

function rowToSubscription(r: Record<string, unknown>): Subscription {
  return {
    originalTransactionId: String(r.original_transaction_id),
    userId: String(r.user_id),
    productId: String(r.product_id),
    environment: String(r.environment),
    status: String(r.status) as Subscription['status'],
    expiresAt: toDateOrNull(r.expires_at),
    updatedAt: toDate(r.updated_at),
  };
}

/** Production store. Works with a pg Pool and, in tests, with PGlite. */
export class PostgresStore implements Store {
  private readonly db: Queryable;
  private readonly onClose: () => Promise<void>;

  constructor(db: Queryable, onClose: () => Promise<void> = async () => {}) {
    this.db = db;
    this.onClose = onClose;
  }

  async createUser(input: { appleSub?: string | null } = {}): Promise<User> {
    const { rows } = await this.db.query(`INSERT INTO users (id, apple_sub) VALUES ($1, $2) RETURNING *`, [
      randomUUID(),
      input.appleSub ?? null,
    ]);
    return rowToUser(rows[0]!);
  }

  async getUser(id: string): Promise<User | null> {
    const { rows } = await this.db.query(`SELECT * FROM users WHERE id = $1`, [id]);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async findUserByAppleSub(sub: string): Promise<User | null> {
    const { rows } = await this.db.query(`SELECT * FROM users WHERE apple_sub = $1`, [sub]);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async linkAppleSub(userId: string, sub: string): Promise<User> {
    const { rows } = await this.db.query(`UPDATE users SET apple_sub = $2 WHERE id = $1 RETURNING *`, [userId, sub]);
    if (!rows[0]) throw new Error(`unknown user ${userId}`);
    return rowToUser(rows[0]);
  }

  async updateUserPlan(userId: string, plan: PlanId, planExpiresAt: Date | null): Promise<User> {
    const { rows } = await this.db.query(`UPDATE users SET plan = $2, plan_expires_at = $3 WHERE id = $1 RETURNING *`, [
      userId,
      plan,
      planExpiresAt,
    ]);
    if (!rows[0]) throw new Error(`unknown user ${userId}`);
    return rowToUser(rows[0]);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.db.query(`DELETE FROM users WHERE id = $1`, [userId]);
  }

  async createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.query(`INSERT INTO sessions (token, user_id) VALUES ($1, $2)`, [token, userId]);
    return token;
  }

  async getSessionUserId(token: string): Promise<string | null> {
    const { rows } = await this.db.query(`SELECT user_id FROM sessions WHERE token = $1`, [token]);
    return rows[0] ? String(rows[0].user_id) : null;
  }

  async deleteSession(token: string): Promise<void> {
    await this.db.query(`DELETE FROM sessions WHERE token = $1`, [token]);
  }

  async upsertDevice(input: DeviceInput): Promise<Device> {
    const { rows } = await this.db.query(
      `INSERT INTO devices (token, user_id, environment, platform, app_version, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (token) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         environment = EXCLUDED.environment,
         platform = EXCLUDED.platform,
         app_version = EXCLUDED.app_version,
         updated_at = now()
       RETURNING *`,
      [input.token, input.userId, input.environment, input.platform ?? 'ios', input.appVersion ?? null],
    );
    return rowToDevice(rows[0]!);
  }

  async listDevices(userId: string): Promise<Device[]> {
    const { rows } = await this.db.query(`SELECT * FROM devices WHERE user_id = $1 ORDER BY updated_at DESC`, [userId]);
    return rows.map(rowToDevice);
  }

  async removeDevice(token: string): Promise<void> {
    await this.db.query(`DELETE FROM devices WHERE token = $1`, [token]);
  }

  async createAlert(input: NewAlert): Promise<Alert> {
    const { rows } = await this.db.query(
      `INSERT INTO alerts (id, user_id, symbol, quote, condition, repeat, cooldown_minutes, armed, note)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
       RETURNING *`,
      [
        randomUUID(),
        input.userId,
        input.symbol,
        input.quote,
        JSON.stringify(input.condition),
        input.repeat,
        input.cooldownMinutes,
        input.armed,
        input.note,
      ],
    );
    return rowToAlert(rows[0]!);
  }

  async getAlert(id: string): Promise<Alert | null> {
    const { rows } = await this.db.query(`SELECT * FROM alerts WHERE id = $1`, [id]);
    return rows[0] ? rowToAlert(rows[0]) : null;
  }

  async listAlerts(userId: string): Promise<Alert[]> {
    const { rows } = await this.db.query(`SELECT * FROM alerts WHERE user_id = $1 ORDER BY created_at DESC, id DESC`, [userId]);
    return rows.map(rowToAlert);
  }

  async listActiveAlerts(): Promise<Alert[]> {
    const { rows } = await this.db.query(`SELECT * FROM alerts WHERE status = 'active'`);
    return rows.map(rowToAlert);
  }

  async countActiveAlerts(userId: string): Promise<number> {
    const { rows } = await this.db.query(`SELECT count(*) AS n FROM alerts WHERE user_id = $1 AND status = 'active'`, [userId]);
    return Number(rows[0]?.n ?? 0);
  }

  async updateAlert(id: string, patch: AlertPatch): Promise<Alert | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (column: string, value: unknown, cast = '') => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if (patch.condition !== undefined) add('condition', JSON.stringify(patch.condition), '::jsonb');
    if (patch.repeat !== undefined) add('repeat', patch.repeat);
    if (patch.cooldownMinutes !== undefined) add('cooldown_minutes', patch.cooldownMinutes);
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.armed !== undefined) add('armed', patch.armed);
    if (patch.note !== undefined) add('note', patch.note);
    if (patch.lastTriggeredAt !== undefined) add('last_triggered_at', patch.lastTriggeredAt);
    if (patch.triggerCount !== undefined) add('trigger_count', patch.triggerCount);
    sets.push(`updated_at = now()`);
    const { rows } = await this.db.query(`UPDATE alerts SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return rows[0] ? rowToAlert(rows[0]) : null;
  }

  async deleteAlert(id: string): Promise<boolean> {
    const { rows } = await this.db.query(`DELETE FROM alerts WHERE id = $1 RETURNING id`, [id]);
    return rows.length > 0;
  }

  async recordEvent(input: NewEvent): Promise<AlertEvent> {
    const { rows } = await this.db.query(
      `INSERT INTO alert_events (id, alert_id, user_id, symbol, price, title, body, fired_at, delivered_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [randomUUID(), input.alertId, input.userId, input.symbol, input.price, input.title, input.body, input.firedAt, input.deliveredCount],
    );
    return rowToEvent(rows[0]!);
  }

  async listEvents(userId: string, limit: number): Promise<AlertEvent[]> {
    const { rows } = await this.db.query(`SELECT * FROM alert_events WHERE user_id = $1 ORDER BY fired_at DESC LIMIT $2`, [
      userId,
      limit,
    ]);
    return rows.map(rowToEvent);
  }

  async upsertSubscription(input: SubscriptionInput): Promise<Subscription> {
    const { rows } = await this.db.query(
      `INSERT INTO subscriptions (original_transaction_id, user_id, product_id, environment, status, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (original_transaction_id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         product_id = EXCLUDED.product_id,
         environment = EXCLUDED.environment,
         status = EXCLUDED.status,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()
       RETURNING *`,
      [input.originalTransactionId, input.userId, input.productId, input.environment, input.status, input.expiresAt],
    );
    return rowToSubscription(rows[0]!);
  }

  async listSubscriptions(userId: string): Promise<Subscription[]> {
    const { rows } = await this.db.query(`SELECT * FROM subscriptions WHERE user_id = $1`, [userId]);
    return rows.map(rowToSubscription);
  }

  async findSubscription(originalTransactionId: string): Promise<Subscription | null> {
    const { rows } = await this.db.query(`SELECT * FROM subscriptions WHERE original_transaction_id = $1`, [originalTransactionId]);
    return rows[0] ? rowToSubscription(rows[0]) : null;
  }

  async close(): Promise<void> {
    await this.onClose();
  }
}

/** Connects a pg Pool, runs migrations and returns a ready store. */
export async function createPostgresStore(databaseUrl: string, logger?: Logger): Promise<PostgresStore> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  pool.on('error', (err) => logger?.error('postgres pool error', { err }));
  await migrate(pool, logger);
  return new PostgresStore(pool, () => pool.end());
}
