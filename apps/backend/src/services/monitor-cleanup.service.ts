import type { Prisma } from '@tracelayer/db';
import { unscheduleMonitor } from '../lib/monitor-queue';
import { prisma } from '../lib/prisma';

/**
 * Deleting a workspace, project or endpoint removes its monitors through database cascades,
 * which BullMQ knows nothing about. Call this with the same filter *before* deleting, then
 * `unschedule` the returned ids after, so their schedules stop at once instead of lingering
 * until the worker's next reconcile.
 */
export async function monitorIdsFor(where: Prisma.MonitorWhereInput): Promise<string[]> {
  const monitors = await prisma.monitor.findMany({ where, select: { id: true } });
  return monitors.map((m) => m.id);
}

export async function unscheduleMonitors(ids: string[]): Promise<void> {
  // unscheduleMonitor never throws: the worker's reconcile is the safety net.
  await Promise.all(ids.map((id) => unscheduleMonitor(id)));
}
