import { randomUUID } from 'node:crypto';
import type { Options } from 'express-rate-limit';
import { RedisRateLimitStore } from '../src/middleware/rate-limit';
import { redis } from '../src/lib/redis';

const WINDOW_MS = 60_000;

describe('RedisRateLimitStore (real Redis)', () => {
  // A unique name per run keeps keys isolated from other runs and from dev data.
  const store = new RedisRateLimitStore(`test-${randomUUID()}`);
  store.init({ windowMs: WINDOW_MS } as Options);

  afterAll(async () => {
    const keys = await redis.keys(`${store.prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it('counts hits per key within one window', async () => {
    const first = await store.increment('1.2.3.4');
    const second = await store.increment('1.2.3.4');
    const other = await store.increment('5.6.7.8');

    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(other.totalHits).toBe(1);
  });

  it('sets the window expiry once, on the first hit', async () => {
    await store.increment('ttl-key');
    const ttlAfterFirst = await redis.pttl(`${store.prefix}ttl-key`);
    await new Promise((r) => setTimeout(r, 50));
    const { resetTime } = await store.increment('ttl-key');
    const ttlAfterSecond = await redis.pttl(`${store.prefix}ttl-key`);

    expect(ttlAfterFirst).toBeGreaterThan(WINDOW_MS - 1_000);
    // Later hits must not push the window back out.
    expect(ttlAfterSecond).toBeLessThan(ttlAfterFirst);
    expect(resetTime!.getTime()).toBeLessThanOrEqual(Date.now() + WINDOW_MS);
  });

  it('supports decrement and reset', async () => {
    await store.increment('dec-key');
    await store.increment('dec-key');
    await store.decrement('dec-key');
    expect((await store.increment('dec-key')).totalHits).toBe(2);

    await store.resetKey('dec-key');
    expect((await store.increment('dec-key')).totalHits).toBe(1);
  });
});
