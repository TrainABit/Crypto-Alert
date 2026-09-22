import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindowLimiter } from '../src/engine/rate-limit.ts';
import { T0, minutes } from './helpers.ts';

test('sliding window allows `limit` hits per window and recovers as hits age out', () => {
  const limiter = new SlidingWindowLimiter(minutes(60));
  assert.equal(limiter.tryAcquire('u', 2, T0), true);
  assert.equal(limiter.tryAcquire('u', 2, T0 + minutes(10)), true);
  assert.equal(limiter.tryAcquire('u', 2, T0 + minutes(20)), false);
  assert.equal(limiter.tryAcquire('other', 2, T0 + minutes(20)), true, 'keys are independent');
  assert.equal(limiter.tryAcquire('u', 2, T0 + minutes(60) + 1), true, 'first hit aged out');
  limiter.sweep(T0 + minutes(200));
  assert.equal(limiter.tryAcquire('u', 1, T0 + minutes(200)), true);
});
