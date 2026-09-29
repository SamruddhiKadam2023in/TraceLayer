import type { Redis } from 'ioredis';
import {
  REDIS_KEYS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TTL_SECONDS,
} from '@tracelayer/shared';
import { logger } from './logger';

/**
 * Periodically writes the current time to a Redis key with a TTL.
 * The API reports the worker as down once the key expires.
 */
export function startHeartbeat(redis: Redis): () => Promise<void> {
  const beat = async () => {
    try {
      await redis.set(
        REDIS_KEYS.WORKER_HEARTBEAT,
        new Date().toISOString(),
        'EX',
        WORKER_HEARTBEAT_TTL_SECONDS,
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Heartbeat write failed');
    }
  };

  void beat();
  const timer = setInterval(() => void beat(), WORKER_HEARTBEAT_INTERVAL_MS);

  return async () => {
    clearInterval(timer);
    await redis.del(REDIS_KEYS.WORKER_HEARTBEAT).catch(() => undefined);
  };
}
