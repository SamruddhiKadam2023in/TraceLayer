import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { closeConnectionPools, createSecretBox } from '@tracelayer/executor';
import { JOB_NAMES, QUEUE_NAMES, type MonitorCheckJobData } from '@tracelayer/shared';
import { createPrismaClient } from '@tracelayer/db';
import { env } from './config';
import { logger } from './logger';
import { startHeartbeat } from './heartbeat';
import { runMonitorCheck, type CheckDependencies } from './checks/run-check';
import {
  pruneMonitorRuns,
  reconcileMonitorSchedules,
  registerMaintenanceSchedules,
} from './scheduling/schedules';

async function main(): Promise<void> {
  const prisma = createPrismaClient();
  await prisma.$connect();

  // BullMQ requires maxRetriesPerRequest: null for blocking worker connections.
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const heartbeatRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
  const queue = new Queue(QUEUE_NAMES.MONITOR_CHECKS, { connection, prefix: env.QUEUE_PREFIX });

  const deps: CheckDependencies = {
    prisma,
    secrets: createSecretBox(env.ENCRYPTION_KEY),
    allowPrivateNetwork: env.ALLOW_PRIVATE_NETWORK_TARGETS,
  };
  if (env.ALLOW_PRIVATE_NETWORK_TARGETS) {
    logger.warn('ALLOW_PRIVATE_NETWORK_TARGETS is on: SSRF protection is disabled');
  }

  async function handleJob(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOB_NAMES.CHECK: {
        const data = job.data as MonitorCheckJobData;
        const result = await runMonitorCheck(data.monitorId, deps, { manual: data.manual });
        logger.debug({ monitorId: data.monitorId, ...result }, 'Monitor check finished');
        return result;
      }
      case JOB_NAMES.RECONCILE: {
        const summary = await reconcileMonitorSchedules(queue, prisma);
        if (summary.added || summary.updated || summary.removed) {
          logger.info(summary, 'Reconciled monitor schedules');
        }
        return summary;
      }
      case JOB_NAMES.PRUNE_RUNS: {
        const removed = await pruneMonitorRuns(prisma);
        logger.info({ removed }, 'Pruned old monitor runs');
        return { removed };
      }
      default:
        logger.warn({ name: job.name }, 'Ignoring unknown job');
        return undefined;
    }
  }

  // Recurring maintenance, then an immediate reconcile so schedules are right from the start.
  await registerMaintenanceSchedules(queue);
  logger.info(await reconcileMonitorSchedules(queue, prisma), 'Initial monitor schedule reconcile');

  const worker = new Worker(QUEUE_NAMES.MONITOR_CHECKS, handleJob, {
    connection,
    prefix: env.QUEUE_PREFIX,
    concurrency: env.WORKER_CONCURRENCY,
  });
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, name: job?.name, err: err.message }, 'Job failed'),
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
    // worker.close() waits for in-flight checks to finish.
    await worker.close();
    await queue.close();
    await stopHeartbeat();
    await Promise.allSettled([
      heartbeatRedis.quit(),
      connection.quit(),
      prisma.$disconnect(),
      closeConnectionPools(),
    ]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
