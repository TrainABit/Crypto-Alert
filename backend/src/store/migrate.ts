import pg from 'pg';
import { loadConfig } from '../config.ts';
import { createLogger } from '../logger.ts';
import { migrate } from './postgres.ts';

const config = loadConfig();
const logger = createLogger(config.logLevel, { service: 'crypto-alert-migrate' });
if (!config.databaseUrl) {
  logger.error('DATABASE_URL is not set');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: config.databaseUrl });
try {
  const applied = await migrate(pool, logger);
  logger.info('migrations complete', { applied });
} finally {
  await pool.end();
}
