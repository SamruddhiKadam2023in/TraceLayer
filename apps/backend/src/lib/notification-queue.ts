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

export async function enqueueNotification(notificationId: string): Promise<void> {
  queue ??= new Queue<NotificationJobData>(NOTIFICATIONS_QUEUE, {
    connection: new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true }),
    prefix: env.QUEUE_PREFIX,
  });
  await queue.add('deliver', { notificationId }, NOTIFICATION_JOB_OPTIONS);
}

export async function closeNotificationQueue(): Promise<void> {
  await queue?.close();
}
