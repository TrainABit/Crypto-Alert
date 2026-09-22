#!/usr/bin/env node
/**
 * End-to-end smoke test: boots the built server with the in-memory store and
 * log notifier, creates a user and two alerts, and waits for live prices.
 * Usage: npm run build && node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';

const port = Number(process.env.SMOKE_PORT ?? 8091);
const base = `http://127.0.0.1:${port}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env, PORT: String(port), LOG_LEVEL: process.env.LOG_LEVEL ?? 'info' };
delete env.DATABASE_URL;
const child = spawn(process.execPath, ['dist/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', (d) => (logs += d));
child.stderr.on('data', (d) => (logs += d));

async function until(check, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      /* not yet */
    }
    await wait(1000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const json = async (path, init = {}) => {
  const res = await fetch(base + path, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const authed = (token, body) => ({
  method: body ? 'POST' : 'GET',
  headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

let exitCode = 0;
try {
  await until(async () => (await fetch(base + '/healthz')).ok, 30_000, 'server start');
  console.log('server up');

  const signup = await json('/v1/auth/anonymous', { method: 'POST' });
  console.log('anonymous user:', signup.status, signup.body.user.plan);
  const token = signup.body.token;

  const btc = await json('/v1/alerts', authed(token, { symbol: 'BTC', condition: { kind: 'price_above', price: 1_000_000 } }));
  console.log('BTC alert:', btc.status, btc.body.alert?.title, 'armed=' + btc.body.alert?.armed, 'currentPrice=' + JSON.stringify(btc.body.currentPrice));
  const eth = await json('/v1/alerts', authed(token, { symbol: 'ETH', condition: { kind: 'price_below', price: 1 } }));
  console.log('ETH alert:', eth.status, eth.body.alert?.title, 'armed=' + eth.body.alert?.armed);

  const health = await until(
    async () => {
      const h = await json('/healthz');
      return h.body.engine.ticks > 5 && h.body.engine.trackedSymbols >= 2 ? h.body : null;
    },
    90_000,
    'live ticks',
  );
  console.log('engine stats:', JSON.stringify(health.engine));

  const prices = await json('/v1/prices?symbols=BTC,ETH,SOL', authed(token));
  console.log('prices:', JSON.stringify(prices.body.prices));
  const sources = new Set(Object.values(prices.body.prices).filter(Boolean).map((p) => p.source));
  console.log('price sources seen:', [...sources].join(', ') || 'none');

  const me = await json('/v1/me', authed(token));
  console.log('me:', me.status, JSON.stringify(me.body.counts));
  if (!Object.values(prices.body.prices).some(Boolean)) throw new Error('no live prices arrived');
  console.log('SMOKE OK');
} catch (err) {
  exitCode = 1;
  console.error('SMOKE FAILED:', err.message);
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise((r) => child.once('exit', r)), wait(5000)]);
  console.log('--- last server log lines ---');
  console.log(logs.trim().split('\n').slice(-25).join('\n'));
}
process.exit(exitCode);
