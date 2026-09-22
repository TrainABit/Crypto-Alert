import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BinanceFeed } from '../src/feeds/binance.ts';
import { CoinGeckoFeed } from '../src/feeds/coingecko.ts';
import type { PriceTick, PriceSample } from '../src/domain/price-book.ts';
import { FakeWebSocket, fakeFetch } from './fakes.ts';
import { T0 } from './helpers.ts';

test('binance feed loads supported pairs, subscribes live and emits ticks', async () => {
  FakeWebSocket.instances = [];
  const fetchImpl = fakeFetch({
    'https://api.binance.com/api/v3/ticker/price': () => ({
      status: 200,
      body: [{ symbol: 'BTCUSDT' }, { symbol: 'ETHUSDT' }, { symbol: 'ETHBTC' }, { symbol: 'USDT' }],
    }),
    'https://api.binance.com/api/v3/klines': () => ({
      status: 200,
      body: [[0, '1', '1', '1', '99.5', '1', T0 - 60_000], [0, '1', '1', '1', '100.5', '1', T0 + 300_000]],
    }),
  });
  const backfills: Array<{ symbol: string; samples: PriceSample[] }> = [];
  const feed = new BinanceFeed({
    fetchImpl,
    WebSocketImpl: FakeWebSocket,
    now: () => T0,
    onBackfill: (symbol, samples) => backfills.push({ symbol, samples }),
  });
  const ticks: PriceTick[] = [];
  feed.onTick((t) => ticks.push(t));

  await feed.start();
  assert.deepEqual(feed.supportedSymbols(), ['BTC', 'ETH']);
  assert.equal(feed.supports('btc'), true);
  assert.equal(feed.supports('DOGE'), false);

  const ws = FakeWebSocket.instances[0]!;
  feed.setSymbols(['BTC', 'DOGE']);
  assert.equal(ws.sent.length, 0, 'nothing is sent before the socket opens');
  ws.open();
  assert.deepEqual(JSON.parse(ws.sent[0]!), { method: 'SUBSCRIBE', params: ['btcusdt@miniTicker'], id: 1 });

  ws.message(JSON.stringify({ stream: 'btcusdt@miniTicker', data: { e: '24hrMiniTicker', E: T0 + 5, s: 'BTCUSDT', c: '65000.10' } }));
  ws.message('garbage');
  ws.message(JSON.stringify({ stream: 'btcusdt@trade', data: {} }));
  assert.deepEqual(ticks, [{ symbol: 'BTC', price: 65000.1, at: T0 + 5, source: 'binance' }]);

  feed.setSymbols(['ETH']);
  assert.deepEqual(JSON.parse(ws.sent[1]!), { method: 'SUBSCRIBE', params: ['ethusdt@miniTicker'], id: 2 });
  assert.deepEqual(JSON.parse(ws.sent[2]!), { method: 'UNSUBSCRIBE', params: ['btcusdt@miniTicker'], id: 3 });

  await new Promise((r) => setTimeout(r, 5));
  assert.equal(backfills.length, 2);
  assert.equal(backfills[0]?.symbol, 'BTC');
  assert.deepEqual(backfills[0]?.samples, [{ at: T0 - 60_000, price: 99.5 }, { at: T0, price: 100.5 }], 'open candle is clamped to now');

  await feed.stop();
  assert.equal(ws.closed, true);
});

test('binance feed reconnects and re-subscribes after the socket drops', async () => {
  FakeWebSocket.instances = [];
  const fetchImpl = fakeFetch({
    'https://api.binance.com/api/v3/ticker/price': () => ({ status: 200, body: [{ symbol: 'BTCUSDT' }] }),
  });
  const feed = new BinanceFeed({ fetchImpl, WebSocketImpl: FakeWebSocket, backfill: false, reconnectBaseMs: 1, reconnectMaxMs: 2 });
  await feed.start();
  feed.setSymbols(['BTC']);
  const first = FakeWebSocket.instances[0]!;
  first.open();
  assert.equal(first.sent.length, 1);
  first.dropConnection();
  await new Promise((r) => setTimeout(r, 10));
  const second = FakeWebSocket.instances[1];
  assert.ok(second, 'a new socket was opened');
  second.open();
  assert.deepEqual(JSON.parse(second.sent[0]!).params, ['btcusdt@miniTicker']);
  await feed.stop();
});

test('coingecko feed polls tracked ids and backs off on 429', async () => {
  let status = 200;
  const fetchImpl = fakeFetch({
    'https://api.coingecko.com/api/v3/simple/price': () => ({
      status,
      body: { bitcoin: { usd: 64000, last_updated_at: 1_700_000_000 }, solana: { usd: 150 } },
    }),
  });
  const feed = new CoinGeckoFeed({ ids: { BTC: 'bitcoin', SOL: 'solana' }, fetchImpl, pollMs: 60_000, now: () => T0 });
  const ticks: PriceTick[] = [];
  feed.onTick((t) => ticks.push(t));
  assert.equal(feed.supports('BTC'), true);
  assert.equal(feed.supports('DOGE'), false);

  await feed.poll();
  assert.equal(fetchImpl.calls.length, 0, 'no symbols, no request');
  feed.setSymbols(['BTC', 'SOL', 'DOGE']);
  await feed.poll();
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(fetchImpl.calls[0]!.includes('ids=bitcoin%2Csolana'));
  assert.deepEqual(ticks, [
    { symbol: 'BTC', price: 64000, at: 1_700_000_000_000, source: 'coingecko' },
    { symbol: 'SOL', price: 150, at: T0, source: 'coingecko' },
  ]);

  status = 429;
  await feed.poll();
  assert.equal(ticks.length, 2, 'rate limited poll emits nothing');
});
