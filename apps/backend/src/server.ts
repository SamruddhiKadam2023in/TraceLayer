import { createServer } from 'node:http';
import { Redis } from 'ioredis';
import { env } from './config/env';
import { createApp } from './app';
import { logger } from './utils/logger';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { closeMonitorQueue } from './lib/monitor-queue';
import { closeNotificationQueue } from './lib/notification-queue';
import { closeConnectionPools } from '@tracelayer/executor';
import { setRealtimeServer } from './lib/realtime';
import { applyServerTimeouts } from './middleware/timeout';
import { createRealtimeServer } from './sockets/realtime-server';

async function main(): Promise<void> {
  await redis.connect().catch((err: Error) => {
    // Not fatal: /api/health reports Redis as down and ioredis keeps retrying.
    logger.warn({ err: err.message }, 'Redis unavailable at startup');
  });

  const server = createServer(createApp());
  applyServerTimeouts(server);
  if (env.NODE_ENV === 'production') {
    if (env.ALLOW_PRIVATE_NETWORK_TARGETS) {
      logger.warn('ALLOW_PRIVATE_NETWORK_TARGETS is on: SSRF protection is disabled');
    }
    if (env.ALLOW_DEV_SECRETS) {
      logger.warn('ALLOW_DEV_SECRETS is on: development secrets are accepted (local stack only)');
    }
  }
  // Pub/sub needs dedicated connections; they reconnect on their own if Redis restarts.
  const pub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  for (const client of [pub, sub]) {
    client.on('error', (err) => logger.warn({ err: err.message }, 'Realtime Redis error'));
  }
  const io = createRealtimeServer(server, { redis: { pub, sub } });
  setRealtimeServer(io);
  server.listen(env.BACKEND_PORT, () => {
    logger.info(`TraceLayer API listening on http://localhost:${env.BACKEND_PORT}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down API');
    setRealtimeServer(null);
    // Closing Socket.IO also closes the HTTP server.
    void io.close(async () => {
      await Promise.allSettled([
        prisma.$disconnect(),
        redis.quit(),
        pub.quit(),
        sub.quit(),
        closeMonitorQueue(),
        closeNotificationQueue(),
        closeConnectionPools(),
      ]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'API failed to start');
  process.exit(1);
});
