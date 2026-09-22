import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriceBook } from '../src/domain/price-book.ts';
import { T0, minutes } from './helpers.ts';

const tick = (price: number, at: number, source = 'binance', symbol = 'BTC') => ({ symbol, price, at, source });

test('accepts the first tick and reports the latest price', () => {
  const book = new PriceBook();
  assert.deepEqual(book.update(tick(100, T0)), { accepted: true, previous: undefined });
  assert.equal(book.latest('BTC')?.price, 100);
  assert.deepEqual(book.symbols(), ['BTC']);
});

test('rejects invalid and out-of-order ticks', () => {
  const book = new PriceBook();
  book.update(tick(100, T0));
  assert.deepEqual(book.update(tick(Number.NaN, T0 + 1)), { accepted: false, reason: 'invalid' });
  assert.deepEqual(book.update(tick(0, T0 + 1)), { accepted: false, reason: 'invalid' });
  assert.deepEqual(book.update(tick(101, T0 - 1)), { accepted: false, reason: 'out_of_order' });
  assert.equal(book.latest('BTC')?.price, 100);
});

test('holds a price jump until a second tick confirms it', () => {
  const book = new PriceBook({ outlierPercent: 15 });
  book.update(tick(100, T0));
  assert.deepEqual(book.update(tick(130, T0 + 1000)), { accepted: false, reason: 'outlier_pending' });
  assert.equal(book.latest('BTC')?.price, 100, 'flash print is not the current price');
  assert.deepEqual(book.update(tick(129, T0 + 2000)), { accepted: true, previous: 100 });
  assert.equal(book.latest('BTC')?.price, 129);
});

test('drops a flash wick when the next tick returns to normal', () => {
  const book = new PriceBook({ outlierPercent: 15 });
  book.update(tick(100, T0));
  book.update(tick(60, T0 + 1000));
  assert.deepEqual(book.update(tick(101, T0 + 2000)), { accepted: true, previous: 100 });
  assert.equal(book.latest('BTC')?.price, 101);
  // A later jump needs fresh confirmation; the old pending value is forgotten.
  assert.deepEqual(book.update(tick(60, T0 + 3000)), { accepted: false, reason: 'outlier_pending' });
});

test('a fallback source cannot override a fresh primary source', () => {
  const book = new PriceBook({ sourcePriority: { binance: 2, coingecko: 1 }, primaryFreshMs: 30_000 });
  book.update(tick(100, T0, 'binance'));
  assert.deepEqual(book.update(tick(90, T0 + 10_000, 'coingecko')), { accepted: false, reason: 'lower_priority' });
  assert.equal(book.latest('BTC')?.price, 100);
  assert.equal(book.update(tick(98, T0 + 40_000, 'coingecko')).accepted, true, 'primary went quiet, fallback takes over');
  assert.equal(book.update(tick(99, T0 + 41_000, 'binance')).accepted, true, 'primary always wins when it returns');
});

test('samples history at the configured interval and prunes old samples', () => {
  const book = new PriceBook({ sampleIntervalMs: 10_000, historyMs: 60_000 });
  for (let i = 0; i <= 12; i++) book.update(tick(100 + i, T0 + i * 5000));
  // 65 s of ticks every 5 s, sampled every 10 s, keeping 60 s => 7 samples (0..60 s)
  assert.equal(book.historyLength('BTC'), 7);
  assert.equal(book.priceAt('BTC', T0 + 60_000), 112);
  assert.equal(book.priceAt('BTC', T0 + 25_000), 105, 'bucket keeps the freshest price inside it');
  assert.equal(book.priceAt('BTC', T0 - 1), undefined);
});

test('changePercent compares against the price a window ago', () => {
  const book = new PriceBook({ sampleIntervalMs: 1000 });
  book.update(tick(100, T0));
  book.update(tick(105, T0 + minutes(30)));
  book.update(tick(110, T0 + minutes(60)));
  assert.equal(book.changePercent('BTC', minutes(60), T0 + minutes(60))?.toFixed(2), '10.00');
  assert.equal(book.changePercent('BTC', minutes(30), T0 + minutes(60))?.toFixed(2), '4.76');
  assert.equal(book.changePercent('BTC', minutes(120), T0 + minutes(60)), undefined, 'history too short');
  assert.equal(book.changePercent('ETH', minutes(5), T0), undefined);
});

test('seed provides history before live ticks arrive', () => {
  const book = new PriceBook({ sampleIntervalMs: 1000 });
  book.seed('BTC', [
    { at: T0 - minutes(120), price: 90 },
    { at: T0 - minutes(60), price: 95 },
  ]);
  assert.equal(book.latest('BTC')?.price, 95);
  assert.equal(book.latest('BTC')?.source, 'seed');
  book.update(tick(99, T0));
  assert.equal(book.changePercent('BTC', minutes(120), T0)?.toFixed(1), '10.0');
  // Seeding again only fills in older history, never overwrites live samples.
  book.seed('BTC', [{ at: T0 - minutes(180), price: 80 }, { at: T0 - minutes(30), price: 1 }]);
  assert.equal(book.priceAt('BTC', T0 - minutes(30)), 95);
  assert.equal(book.priceAt('BTC', T0 - minutes(180)), 80);
});

test('isStale reflects the age of the latest tick', () => {
  const book = new PriceBook();
  assert.equal(book.isStale('BTC', T0, 1000), true);
  book.update(tick(100, T0));
  assert.equal(book.isStale('BTC', T0 + 500, 1000), false);
  assert.equal(book.isStale('BTC', T0 + 1500, 1000), true);
});
