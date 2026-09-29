import type { Queue } from 'bullmq';
import type { PrismaClient } from '@tracelayer/db';
import {
  JOB_NAMES,
  MONITOR_RUN_RETENTION_DAYS,
  monitorSchedulerId,
  type MonitorCheckJobData,
} from '@tracelayer/shared';

export const CHECK_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 1000 },
};

const MONITOR_PREFIX = monitorSchedulerId('');
const RECONCILE_EVERY_MS = 5 * 60_000;
/** 03:17 UTC daily: off the hour, to avoid the rush of jobs every other system schedules. */
const PRUNE_PATTERN = '17 3 * * *';

export interface ReconcileSummary {
  added: number;
  updated: number;
  removed: number;
}

/**
 * Makes BullMQ's monitor schedulers match the monitors table, which is the source of truth.
 * Adds missing schedulers (e.g. created while Redis was down), fixes intervals that drifted,
 * and removes schedulers for monitors that were paused or deleted.
 */
export async function reconcileMonitorSchedules(
  queue: Queue,
  prisma: PrismaClient,
): Promise<ReconcileSummary> {
  const monitors = await prisma.monitor.findMany({
    where: { enabled: true },
    select: { id: true, intervalSeconds: true },
  });
  const wanted = new Map(monitors.map((m) => [monitorSchedulerId(m.id), m.intervalSeconds * 1000]));

  const existing = new Map<string, number | undefined>();
  for (const scheduler of await queue.getJobSchedulers(0, -1)) {
    const id = scheduler.key;
    if (id.startsWith(MONITOR_PREFIX)) existing.set(id, scheduler.every ?? undefined);
  }

  const summary: ReconcileSummary = { added: 0, updated: 0, removed: 0 };
  for (const id of existing.keys()) {
    if (!wanted.has(id)) {
      await queue.removeJobScheduler(id);
      summary.removed++;
    }
  }
  for (const [id, every] of wanted) {
    const current = existing.get(id);
    if (current === every) continue;
    const monitorId = id.slice(MONITOR_PREFIX.length);
    const data: MonitorCheckJobData = { monitorId };
    await queue.upsertJobScheduler(
      id,
      { every },
      { name: JOB_NAMES.CHECK, data, opts: CHECK_JOB_OPTIONS },
    );
    if (existing.has(id)) summary.updated++;
    else summary.added++;
  }
  return summary;
}

/** Registers the worker's own recurring jobs. Idempotent: safe on every start. */
export async function registerMaintenanceSchedules(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    'maintenance:reconcile',
    { every: RECONCILE_EVERY_MS },
    { name: JOB_NAMES.RECONCILE, opts: { removeOnComplete: true, removeOnFail: 50 } },
  );
  await queue.upsertJobScheduler(
    'maintenance:prune-runs',
    { pattern: PRUNE_PATTERN, tz: 'UTC' },
    { name: JOB_NAMES.PRUNE_RUNS, opts: { removeOnComplete: true, removeOnFail: 50 } },
  );
}

/** Deletes monitor runs older than the retention window. Returns how many were removed. */
export async function pruneMonitorRuns(prisma: PrismaClient, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - MONITOR_RUN_RETENTION_DAYS * 86_400_000);
  const { count } = await prisma.monitorRun.deleteMany({ where: { startedAt: { lt: cutoff } } });
  return count;
}
