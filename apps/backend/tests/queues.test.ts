import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  JOB_NAMES,
  monitorSchedulerId,
  NOTIFICATIONS_QUEUE,
  QUEUE_NAMES,
} from '@tracelayer/shared';
import { env } from '../src/config/env';
import {
  closeMonitorQueue,
  enqueueMonitorRun,
  syncMonitorSchedule,
  unscheduleMonitor,
} from '../src/lib/monitor-queue';
import { closeNotificationQueue, enqueueNotification } from '../src/lib/notification-queue';

// The real producers against Redis (other suites mock them), in the tests' own queue prefix.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const checks = new Queue(QUEUE_NAMES.MONITOR_CHECKS, { connection, prefix: env.QUEUE_PREFIX });
const notifications = new Queue(NOTIFICATIONS_QUEUE, { connection, prefix: env.QUEUE_PREFIX });

beforeEach(async () => {
  await checks.obliterate({ force: true });
  await notifications.obliterate({ force: true });
});

afterAll(async () => {
  await checks.obliterate({ force: true });
  await notifications.obliterate({ force: true });
  await Promise.all([
    closeMonitorQueue(),
    closeNotificationQueue(),
    checks.close(),
    notifications.close(),
  ]);
  await connection.quit();
});

const MONITOR = '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** The scheduler as BullMQ lists it (the list includes the interval). */
const scheduled = async (monitorId: string) =>
  (await checks.getJobSchedulers(0, -1)).find((s) => s.key === monitorSchedulerId(monitorId));

describe('monitor schedules', () => {
  it('creates, updates and removes the scheduler as the monitor changes', async () => {
    expect(env.QUEUE_PREFIX).toBe('tracelayer-test');

    await syncMonitorSchedule({ id: MONITOR, enabled: true, intervalSeconds: 300 });
    expect(await scheduled(MONITOR)).toMatchObject({ every: 300_000, name: JOB_NAMES.CHECK });
    // The next run is already queued, with the monitor to check and no retries: a failed
    // check is a result, not a job failure.
    const [next] = await checks.getJobs(['delayed', 'waiting']);
    expect(next?.data).toEqual({ monitorId: MONITOR });
    expect(next?.opts.attempts).toBe(1);

    await syncMonitorSchedule({ id: MONITOR, enabled: true, intervalSeconds: 60 });
    expect((await scheduled(MONITOR))?.every).toBe(60_000);
    expect(await checks.getJobSchedulersCount()).toBe(1);

    // Pausing removes it; syncing a paused monitor again is harmless.
    await syncMonitorSchedule({ id: MONITOR, enabled: false, intervalSeconds: 60 });
    await syncMonitorSchedule({ id: MONITOR, enabled: false, intervalSeconds: 60 });
    expect(await scheduled(MONITOR)).toBeUndefined();
  });

  it('unschedules deleted monitors, even ones that were never scheduled', async () => {
    await syncMonitorSchedule({ id: MONITOR, enabled: true, intervalSeconds: 300 });
    await unscheduleMonitor(MONITOR);
    await unscheduleMonitor('00000000-0000-4000-8000-000000000000');
    expect(await checks.getJobSchedulersCount()).toBe(0);
  });

  it('queues a one-off manual check', async () => {
    await enqueueMonitorRun(MONITOR);
    const [job] = await checks.getWaiting();
    expect(job).toMatchObject({
      name: JOB_NAMES.CHECK,
      data: { monitorId: MONITOR, manual: true },
    });
    expect(job?.opts.attempts).toBe(1);
  });
});

describe('notification queue', () => {
  it('queues deliveries with retries and backoff', async () => {
    await enqueueNotification('notification-1');
    const [job] = await notifications.getWaiting();
    expect(job).toMatchObject({ name: 'deliver', data: { notificationId: 'notification-1' } });
    expect(job?.opts).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
    });
  });
});
