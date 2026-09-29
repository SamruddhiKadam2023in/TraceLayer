import type { Redis } from 'ioredis';
import { REDIS_KEYS, WORKER_HEARTBEAT_TTL_SECONDS } from '@tracelayer/shared';

jest.mock('./logger', () => ({ logger: { warn: jest.fn() } }));

import { startHeartbeat } from './heartbeat';

function fakeRedis() {
  return {
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };
}

describe('startHeartbeat', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('writes the heartbeat key with a TTL immediately and on every interval', async () => {
    const redis = fakeRedis();
    const stop = startHeartbeat(redis as unknown as Redis);

    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      REDIS_KEYS.WORKER_HEARTBEAT,
      expect.any(String),
      'EX',
      WORKER_HEARTBEAT_TTL_SECONDS,
    );

    jest.advanceTimersByTime(10_000);
    expect(redis.set).toHaveBeenCalledTimes(2);

    await stop();
    jest.advanceTimersByTime(30_000);
    expect(redis.set).toHaveBeenCalledTimes(2);
    expect(redis.del).toHaveBeenCalledWith(REDIS_KEYS.WORKER_HEARTBEAT);
  });

  it('keeps beating after a failed write', async () => {
    const redis = fakeRedis();
    redis.set.mockRejectedValueOnce(new Error('READONLY'));
    const stop = startHeartbeat(redis as unknown as Redis);

    jest.advanceTimersByTime(10_000);
    expect(redis.set).toHaveBeenCalledTimes(2);
    await stop();
  });
});
