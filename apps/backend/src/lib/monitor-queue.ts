import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  JOB_NAMES,
  monitorSchedulerId,
  QUEUE_NAMES,
  type MonitorCheckJobData,
} from '@tracelayer/shared';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Producer side of the monitor queue. The API keeps BullMQ schedulers in step with monitors
 * as they are saved; the worker also reconciles every few minutes, so a failed call here
 * (e.g. Redis briefly down) only delays a change instead of losing it.
 */
let queue: Queue<MonitorCheckJobData> | undefined;
let connection: Redis | undefined;

function getQueue(): Queue<MonitorCheckJobData> {
  if (!queue) {
    connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
    queue = new Queue<MonitorCheckJobData>(QUEUE_NAMES.MONITOR_CHECKS, {
      connection,
      prefix: env.QUEUE_PREFIX,
    });
  }
  return queue;
}

export const CHECK_JOB_OPTIONS = {
  // A failed check is a result, not a job failure: never retry.
  attempts: 1,
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 1000 },
};

export interface SchedulableMonitor {
  id: string;
  enabled: boolean;
  intervalSeconds: number;
}

/** Creates, updates or removes the monitor's scheduler to match its settings. */
export async function syncMonitorSchedule(monitor: SchedulableMonitor): Promise<void> {
  try {
    if (!monitor.enabled) {
      await getQueue().removeJobScheduler(monitorSchedulerId(monitor.id));
      return;
    }
    await getQueue().upsertJobScheduler(
      monitorSchedulerId(monitor.id),
      { every: monitor.intervalSeconds * 1000 },
      { name: JOB_NAMES.CHECK, data: { monitorId: monitor.id }, opts: CHECK_JOB_OPTIONS },
    );
  } catch (err) {
    logger.warn(
      { err, monitorId: monitor.id },
      'Could not update monitor schedule; the worker will reconcile it',
    );
  }
}

export async function unscheduleMonitor(monitorId: string): Promise<void> {
  try {
    await getQueue().removeJobScheduler(monitorSchedulerId(monitorId));
  } catch (err) {
    logger.warn(
      { err, monitorId },
      'Could not remove monitor schedule; the worker will reconcile it',
    );
  }
}

/** Queues an immediate, one-off check. Unlike schedule changes this must succeed or fail loudly. */
export async function enqueueMonitorRun(monitorId: string): Promise<void> {
  await getQueue().add(JOB_NAMES.CHECK, { monitorId, manual: true }, CHECK_JOB_OPTIONS);
}

/** Closes the queue and its Redis connection (BullMQ leaves a connection it was given open). */
export async function closeMonitorQueue(): Promise<void> {
  await queue?.close();
  await connection?.quit();
  queue = undefined;
  connection = undefined;
}
