import type { PrismaClient } from '@tracelayer/db';
import {
  computeHealth,
  HEALTH_WINDOW,
  type FailureReason,
  type IncidentRealtimePayload,
  type MonitorRealtimePayload,
} from '@tracelayer/shared';
import type { RuleEvaluationResult } from '../alerts/evaluate-rules';
import type { RealtimePublish } from './publisher';

/**
 * Spec §19 step 15: after a check is stored and its rules evaluated, tell the monitor's
 * workspace what changed. Health before and after comes from the same rule as the metrics API
 * (the latest 10 runs), so the dashboard and these events always agree.
 */
export async function publishCheckEvents(
  prisma: PrismaClient,
  publish: RealtimePublish,
  monitorId: string,
  runId: string,
  evaluations: RuleEvaluationResult[],
): Promise<void> {
  const monitor = await prisma.monitor.findUnique({
    where: { id: monitorId },
    select: { id: true, name: true, projectId: true, project: { select: { workspaceId: true } } },
  });
  if (!monitor) return;
  const workspaceId = monitor.project.workspaceId;

  // One more than the health window, to know the health before this run too.
  const runs = await prisma.monitorRun.findMany({
    where: { monitorId },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: HEALTH_WINDOW + 1,
    select: {
      id: true,
      startedAt: true,
      success: true,
      statusCode: true,
      durationMs: true,
      failureReason: true,
    },
  });
  const run = runs.find((r) => r.id === runId);
  if (run) {
    const index = runs.indexOf(run);
    const previousRun = runs[index + 1];
    const payload: MonitorRealtimePayload = {
      workspaceId,
      projectId: monitor.projectId,
      monitor: { id: monitor.id, name: monitor.name },
      run: {
        id: run.id,
        startedAt: run.startedAt.toISOString(),
        success: run.success,
        statusCode: run.statusCode,
        durationMs: run.durationMs,
        // Stored as text; the worker only ever writes FailureReason values.
        failureReason: run.failureReason as FailureReason | null,
      },
      health: computeHealth(runs.slice(index)),
      previousHealth: computeHealth(runs.slice(index + 1)),
    };
    publish(workspaceId, 'monitor.checked', payload);
    // Transitions only, so a monitor that stays down does not notify on every check.
    if (!run.success && previousRun?.success !== false) {
      publish(workspaceId, 'monitor.failed', payload);
    }
    if (run.success && previousRun?.success === false) {
      publish(workspaceId, 'monitor.recovered', payload);
    }
    if (payload.health !== payload.previousHealth) {
      publish(workspaceId, 'monitor.status_changed', payload);
    }
  }

  // One event per incident, even when several rules changed the same one in this check.
  const changes = new Map<string, IncidentRealtimePayload['change']>();
  for (const { incident } of evaluations) {
    if (!incident) continue;
    const change = incident.created
      ? 'opened'
      : incident.resolved
        ? 'resolved_automatically'
        : 'alert_added';
    const previous = changes.get(incident.id);
    // "opened" and "resolved" say more than "an alert joined".
    if (!previous || previous === 'alert_added') changes.set(incident.id, change);
  }
  if (changes.size === 0) return;
  const incidents = await prisma.incident.findMany({
    where: { id: { in: [...changes.keys()] } },
    select: { id: true, number: true, title: true, severity: true, status: true },
  });
  for (const incident of incidents) {
    const change = changes.get(incident.id)!;
    publish(workspaceId, change === 'opened' ? 'incident.created' : 'incident.updated', {
      workspaceId,
      projectId: monitor.projectId,
      incident,
      change,
      actor: null,
    });
  }
}
