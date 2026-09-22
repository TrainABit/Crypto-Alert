/** Sliding window counter per key, used to cap pushes per user per hour. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  /** Records a hit when under the limit and returns whether it was allowed. */
  tryAcquire(key: string, limit: number, nowMs: number): boolean {
    const cutoff = nowMs - this.windowMs;
    let list = this.hits.get(key);
    if (!list) {
      list = [];
      this.hits.set(key, list);
    }
    while (list.length > 0 && list[0]! <= cutoff) list.shift();
    if (list.length >= limit) return false;
    list.push(nowMs);
    return true;
  }

  /** Drops keys that have no hits inside the window. Call occasionally. */
  sweep(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    for (const [key, list] of this.hits) {
      while (list.length > 0 && list[0]! <= cutoff) list.shift();
      if (list.length === 0) this.hits.delete(key);
    }
  }
}
