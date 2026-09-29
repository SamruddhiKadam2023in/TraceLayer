import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_NAMES } from '@tracelayer/shared';
import { createPrismaClient } from '@tracelayer/db';
import { env } from './config';
import { logger } from './logger';
import { startHeartbeat } from './heartbeat';

async function processMonitorCheck(job: Job): Promise<void> {
  // Monitor execution (SSRF-safe HTTP check, run persistence, rule evaluation) lands in Phase 7.
  logger.info({ jobId: job.id, name: job.name }, 'Received monitor check job');
}

async function main(): Promise<void> {
  const prisma = createPrismaClient();
  await prisma.$connect();

  // BullMQ requires maxRetriesPerRequest: null for blocking worker connections.
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const heartbeatRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });

  const worker = new Worker(QUEUE_NAMES.MONITOR_CHECKS, processMonitorCheck, {
    connection,
    concurrency: env.WORKER_CONCURRENCY,
  });
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err.message }, 'Monitor check job failed'),
  );
  worker.on('error', (err) => logger.error({ err: err.message }, 'Worker error'));

  const stopHeartbeat = startHeartbeat(heartbeatRedis);
  logger.info(
    { queue: QUEUE_NAMES.MONITOR_CHECKS, concurrency: env.WORKER_CONCURRENCY },
    'TraceLayer worker started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down worker');
    setTimeout(() => process.exit(1), 15_000).unref();
    // worker.close() waits for in-flight jobs to finish.
    await worker.close();
    await stopHeartbeat();
    await Promise.allSettled([heartbeatRedis.quit(), connection.quit(), prisma.$disconnect()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
