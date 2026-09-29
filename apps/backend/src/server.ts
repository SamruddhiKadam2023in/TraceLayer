import { createServer } from 'node:http';
import { env } from './config/env';
import { createApp } from './app';
import { logger } from './utils/logger';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';

async function main(): Promise<void> {
  await redis.connect().catch((err: Error) => {
    // Not fatal: /api/health reports Redis as down and ioredis keeps retrying.
    logger.warn({ err: err.message }, 'Redis unavailable at startup');
  });

  const server = createServer(createApp());
  server.listen(env.BACKEND_PORT, () => {
    logger.info(`TraceLayer API listening on http://localhost:${env.BACKEND_PORT}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down API');
    server.close(async () => {
      await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
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
