import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  NOTIFICATION_JOB_OPTIONS,
  NOTIFICATIONS_QUEUE,
  type NotificationJobData,
} from '@tracelayer/shared';
import { env } from '../config/env';

/** Producer for the worker's notification queue (used for test notifications). */
let queue: Queue<NotificationJobData> | undefined;
let connection: Redis | undefined;

export async function enqueueNotification(notificationId: string): Promise<void> {
  if (!queue) {
    connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
    queue = new Queue<NotificationJobData>(NOTIFICATIONS_QUEUE, {
      connection,
      prefix: env.QUEUE_PREFIX,
    });
  }
  await queue.add('deliver', { notificationId }, NOTIFICATION_JOB_OPTIONS);
}

/** Closes the queue and its Redis connection (BullMQ leaves a connection it was given open). */
export async function closeNotificationQueue(): Promise<void> {
  await queue?.close();
  await connection?.quit();
  queue = undefined;
  connection = undefined;
}
