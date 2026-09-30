import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { closeConnectionPools, createSecretBox } from '@tracelayer/executor';
import {
  JOB_NAMES,
  NOTIFICATION_JOB_OPTIONS,
  NOTIFICATIONS_QUEUE,
  QUEUE_NAMES,
  type MonitorCheckJobData,
  type NotificationJobData,
} from '@tracelayer/shared';
import { createPrismaClient } from '@tracelayer/db';
import { env } from './config';
import { logger } from './logger';
import { startHeartbeat } from './heartbeat';
import { processMonitorCheck, type ProcessDependencies } from './checks/process-check';
import { createRealtimePublisher } from './realtime/publisher';
import {
  createEmailAdapter,
  createMailTransport,
  type ChannelAdapters,
} from './notifications/channels';
import { deliverNotification, type DeliveryDependencies } from './notifications/deliver';
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
  const notificationsQueue = new Queue<NotificationJobData>(NOTIFICATIONS_QUEUE, {
    connection,
    prefix: env.QUEUE_PREFIX,
  });

  const deps: ProcessDependencies = {
    prisma,
    secrets: createSecretBox(env.ENCRYPTION_KEY),
    allowPrivateNetwork: env.ALLOW_PRIVATE_NETWORK_TARGETS,
    enqueueNotification: async (notificationId) => {
      await notificationsQueue.add('deliver', { notificationId }, NOTIFICATION_JOB_OPTIONS);
    },
    // PUBLISH needs no blocking connection; the heartbeat client is enough.
    publish: createRealtimePublisher(heartbeatRedis, env.QUEUE_PREFIX),
    onPublishError: (err) => logger.warn({ err }, 'Could not publish real-time events'),
  };

  // Notification channels. Without SMTP_HOST, emails are rendered and logged instead of sent.
  const transport = createMailTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
    from: env.SMTP_FROM,
  });
  const email = createEmailAdapter(transport, env.SMTP_FROM);
  const adapters: ChannelAdapters = {
    EMAIL: env.SMTP_HOST
      ? email
      : {
          async send(config, message) {
            await email.send(config, message);
            logger.info(
              { subject: message.subject, config },
              'Email rendered (SMTP_HOST not set, not sent)',
            );
          },
        },
  };
  const deliveryDeps: DeliveryDependencies = { prisma, adapters, appUrl: env.APP_URL };
  if (!env.SMTP_HOST) logger.warn('SMTP_HOST is not set: notification emails are logged, not sent');
  if (env.ALLOW_PRIVATE_NETWORK_TARGETS) {
    logger.warn('ALLOW_PRIVATE_NETWORK_TARGETS is on: SSRF protection is disabled');
  }

  async function handleJob(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOB_NAMES.CHECK: {
        const data = job.data as MonitorCheckJobData;
        const result = await processMonitorCheck(data.monitorId, deps, { manual: data.manual });
        const { check: _check, ...counts } = result;
        logger.debug({ monitorId: data.monitorId, ...counts }, 'Monitor check finished');
        if (result.incidentsOpened || result.incidentsResolved) {
          logger.info({ monitorId: data.monitorId, ...counts }, 'Incident state changed');
        }
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

  // Deliveries run separately from checks, so a slow mail server never delays monitoring.
  const notificationWorker = new Worker<NotificationJobData>(
    NOTIFICATIONS_QUEUE,
    async (job) => {
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      return deliverNotification(job.data.notificationId, deliveryDeps, finalAttempt);
    },
    { connection, prefix: env.QUEUE_PREFIX, concurrency: 5 },
  );
  notificationWorker.on('failed', (job, err) =>
    logger.warn(
      { notificationId: job?.data.notificationId, attempt: job?.attemptsMade, err: err.message },
      'Notification delivery failed',
    ),
  );

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
    await Promise.all([worker.close(), notificationWorker.close()]);
    await Promise.all([queue.close(), notificationsQueue.close()]);
    transport.close();
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
