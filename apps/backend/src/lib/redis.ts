import { Redis } from 'ioredis';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const redis = new Redis(env.REDIS_URL, {
  // Fail fast on individual commands instead of queueing forever while Redis is down.
  maxRetriesPerRequest: 2,
  lazyConnect: true,
});

redis.on('error', (err) => logger.warn({ err: err.message }, 'Redis connection error'));
