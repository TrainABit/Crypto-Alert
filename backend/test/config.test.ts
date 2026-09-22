import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

test('loadConfig treats blank values as unset and applies defaults', () => {
  const config = loadConfig({ DATABASE_URL: '', APNS_TEAM_ID: '  ', COINGECKO_API_KEY: '', PORT: '9000' });
  assert.equal(config.databaseUrl, undefined);
  assert.equal(config.apns, null);
  assert.equal(config.appStore, null);
  assert.equal(config.port, 9000);
  assert.deepEqual(config.feeds, ['binance', 'coingecko']);
  assert.equal(config.coingecko.apiKey, undefined);
});

test('loadConfig wires APNs, App Store and Sign in with Apple from the bundle id', () => {
  const config = loadConfig({
    APNS_TEAM_ID: 'TEAM',
    APNS_KEY_ID: 'KEY',
    APNS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
    APNS_BUNDLE_ID: 'com.example.app',
    APPSTORE_ENVIRONMENT: 'Production',
    APPSTORE_APP_APPLE_ID: '123456',
    PRO_PRODUCT_IDS: 'a, b ,c',
    COINGECKO_IDS: 'pepe=pepe, WIF=dogwifcoin',
  });
  assert.equal(config.apns?.privateKey, '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
  assert.equal(config.appStore?.bundleId, 'com.example.app');
  assert.equal(config.appStore?.environment, 'Production');
  assert.equal(config.appStore?.appAppleId, 123456);
  assert.deepEqual(config.appStore?.proProductIds, ['a', 'b', 'c']);
  assert.equal(config.appleSignInBundleId, 'com.example.app');
  assert.deepEqual(config.coingecko.extraIds, { PEPE: 'pepe', WIF: 'dogwifcoin' });
});

test('loadConfig rejects invalid values', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }));
  assert.throws(() => loadConfig({ APPSTORE_ENVIRONMENT: 'Staging' }));
});
