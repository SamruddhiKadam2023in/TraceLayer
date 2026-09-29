import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createPrismaClient } from '@tracelayer/db';
import { JOB_NAMES, monitorSchedulerId, QUEUE_NAMES } from '@tracelayer/shared';
import {
  pruneMonitorRuns,
  reconcileMonitorSchedules,
  registerMaintenanceSchedules,
} from '../src/scheduling/schedules';

const prisma = createPrismaClient();
// A unique prefix isolates these queues from any running worker and from other test runs.
const prefix = `tracelayer-test-${randomUUID()}`;
const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_NAMES.MONITOR_CHECKS, { connection, prefix });

afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  await connection.quit();
  await prisma.$disconnect();
});

let ids: { projectId: string; endpointId: string };
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE workspaces, projects, environments, endpoints, monitors, monitor_runs CASCADE',
  );
  for (const s of await queue.getJobSchedulers(0, -1)) await queue.removeJobScheduler(s.key);
  // New schedulers fire a first job at once; drop jobs left waiting by earlier tests.
  await queue.drain(true);
  const workspace = await prisma.workspace.create({ data: { name: 'Acme' } });
  const project = await prisma.project.create({ data: { workspaceId: workspace.id, name: 'P' } });
  const endpoint = await prisma.endpoint.create({
    data: { projectId: project.id, name: 'E', method: 'GET', url: 'https://example.com/' },
  });
  ids = { projectId: project.id, endpointId: endpoint.id };
});

function createMonitor(name: string, intervalSeconds: number, enabled = true) {
  return prisma.monitor.create({
    data: { ...ids, name, type: 'AVAILABILITY', intervalSeconds, timeoutMs: 5000, enabled },
  });
}

async function monitorSchedulers() {
  return (await queue.getJobSchedulers(0, -1))
    .filter((s) => s.key.startsWith('monitor:'))
    .map((s) => ({ id: s.key, every: s.every }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

describe('reconcileMonitorSchedules', () => {
  it('schedules every enabled monitor at its interval, and nothing for paused ones', async () => {
    const a = await createMonitor('a', 60);
    const b = await createMonitor('b', 300);
    await createMonitor('paused', 60, false);

    expect(await reconcileMonitorSchedules(queue, prisma)).toEqual({
      added: 2,
      updated: 0,
      removed: 0,
    });
    expect(await monitorSchedulers()).toEqual(
      [
        { id: monitorSchedulerId(a.id), every: 60_000 },
        { id: monitorSchedulerId(b.id), every: 300_000 },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
  });

  it('fixes drifted intervals and removes schedules of paused or deleted monitors', async () => {
    const keep = await createMonitor('keep', 60);
    const change = await createMonitor('change', 60);
    const pause = await createMonitor('pause', 60);
    const remove = await createMonitor('remove', 60);
    await reconcileMonitorSchedules(queue, prisma);

    await prisma.monitor.update({ where: { id: change.id }, data: { intervalSeconds: 900 } });
    await prisma.monitor.update({ where: { id: pause.id }, data: { enabled: false } });
    await prisma.monitor.delete({ where: { id: remove.id } });

    expect(await reconcileMonitorSchedules(queue, prisma)).toEqual({
      added: 0,
      updated: 1,
      removed: 2,
    });
    expect(await monitorSchedulers()).toEqual(
      [
        { id: monitorSchedulerId(keep.id), every: 60_000 },
        { id: monitorSchedulerId(change.id), every: 900_000 },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
    // Running again changes nothing: reconciliation is idempotent.
    expect(await reconcileMonitorSchedules(queue, prisma)).toEqual({
      added: 0,
      updated: 0,
      removed: 0,
    });
  });

  it('leaves the maintenance schedules alone', async () => {
    await registerMaintenanceSchedules(queue);
    await reconcileMonitorSchedules(queue, prisma);
    const keys = (await queue.getJobSchedulers(0, -1)).map((s) => s.key).sort();
    expect(keys).toEqual(['maintenance:prune-runs', 'maintenance:reconcile']);
  });

  it('actually produces check jobs that a worker receives', async () => {
    const m = await createMonitor('live', 60);
    // BullMQ does not close connections it was given, so keep hold of them to close below.
    const eventsConnection = connection.duplicate();
    const workerConnection = connection.duplicate();
    const events = new QueueEvents(QUEUE_NAMES.MONITOR_CHECKS, {
      connection: eventsConnection,
      prefix,
    });
    const received: unknown[] = [];
    const worker = new Worker(
      QUEUE_NAMES.MONITOR_CHECKS,
      async (job) => {
        if (job.name === JOB_NAMES.CHECK) received.push(job.data);
      },
      { connection: workerConnection, prefix },
    );
    try {
      await reconcileMonitorSchedules(queue, prisma);
      // A new scheduler fires its first job immediately.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no job within 10s')), 10_000);
        events.on('completed', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      expect(received).toEqual([{ monitorId: m.id }]);
    } finally {
      await worker.close();
      await events.close();
      await Promise.all([eventsConnection.quit(), workerConnection.quit()]);
    }
  });
});

describe('pruneMonitorRuns', () => {
  it('deletes runs older than 30 days and keeps the rest', async () => {
    const m = await createMonitor('m', 60);
    const now = new Date('2026-09-29T12:00:00.000Z');
    const day = 86_400_000;
    await prisma.monitorRun.createMany({
      data: [29, 30.5, 45].map((ageDays) => ({
        monitorId: m.id,
        projectId: ids.projectId,
        endpointId: ids.endpointId,
        startedAt: new Date(now.getTime() - ageDays * day),
        success: true,
      })),
    });
    expect(await pruneMonitorRuns(prisma, now)).toBe(2);
    expect(await prisma.monitorRun.count()).toBe(1);
  });
});
