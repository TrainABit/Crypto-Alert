import { PGlite } from '@electric-sql/pglite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresStore, migrate } from '../src/store/postgres.ts';
import { storeContract } from './store-contract.ts';

async function makeStore() {
  const db = new PGlite();
  await migrate(db);
  return new PostgresStore(db, () => db.close());
}

test('migrate is idempotent', async () => {
  const db = new PGlite();
  assert.deepEqual(await migrate(db), [1]);
  assert.deepEqual(await migrate(db), []);
  await db.close();
});

storeContract('PostgresStore (PGlite)', makeStore);
