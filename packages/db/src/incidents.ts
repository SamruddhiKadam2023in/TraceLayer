import type { Prisma, Severity } from '../generated/client';

/**
 * Incident lifecycle shared by the worker (alerts firing and recovering) and the API (rules
 * changed or deleted). Every function runs inside the caller's transaction and locks the
 * incident row, so the worker, the API and people editing the incident never interleave.
 *
 * Lock order is always: alert rules (taken by the caller) → incident. Manual edits lock only
 * the incident, so no cycle is possible.
 */

type Tx = Prisma.TransactionClient;

const SEVERITY_RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

/** SELECT … FOR UPDATE on one incident; returns its current status, or null if it is gone. */
export async function lockIncident(
  tx: Tx,
  incidentId: string,
): Promise<{ status: string; severity: Severity } | null> {
  const rows = await tx.$queryRaw<{ status: string; severity: Severity }[]>`
    SELECT status::text AS status, severity::text AS severity
    FROM incidents WHERE id = ${incidentId}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

export interface FiredAlertInput {
  alertId: string;
  projectId: string;
  monitorId: string;
  monitorName: string;
  ruleName: string;
  severity: Severity;
  message: string;
  now: Date;
}

/**
 * Spec §26: a fired alert opens an incident, or joins the monitor's incident that is still
 * active. A more severe alert raises the incident's severity.
 */
export async function openOrJoinIncident(
  tx: Tx,
  input: FiredAlertInput,
): Promise<{ incidentId: string; number: number; created: boolean }> {
  const alertLine = `${input.ruleName}: ${input.message}`.slice(0, 2000);
  const active = await tx.incident.findFirst({
    where: { monitorId: input.monitorId, status: { not: 'RESOLVED' } },
    orderBy: { detectedAt: 'desc' },
    select: { id: true, number: true },
  });
  const locked = active ? await lockIncident(tx, active.id) : null;

  if (active && locked && locked.status !== 'RESOLVED') {
    await tx.alert.update({ where: { id: input.alertId }, data: { incidentId: active.id } });
    await tx.incidentEvent.create({
      data: {
        incidentId: active.id,
        type: 'ALERT_FIRED',
        message: alertLine,
        createdAt: input.now,
      },
    });
    if (SEVERITY_RANK[input.severity] > SEVERITY_RANK[locked.severity]) {
      await tx.incident.update({ where: { id: active.id }, data: { severity: input.severity } });
      await tx.incidentEvent.create({
        data: {
          incidentId: active.id,
          type: 'SEVERITY_CHANGED',
          fromValue: locked.severity,
          toValue: input.severity,
          createdAt: input.now,
        },
      });
    }
    return { incidentId: active.id, number: active.number, created: false };
  }

  // The counter update locks the project row, so numbers are unique and gap-free per project.
  const [counter] = await tx.$queryRaw<{ incident_counter: number }[]>`
    UPDATE projects SET incident_counter = incident_counter + 1
    WHERE id = ${input.projectId}::uuid RETURNING incident_counter`;
  if (!counter) throw new Error(`Project ${input.projectId} not found`);

  const incident = await tx.incident.create({
    data: {
      projectId: input.projectId,
      number: counter.incident_counter,
      monitorId: input.monitorId,
      title: `${input.monitorName}: ${input.message}`.slice(0, 300),
      severity: input.severity,
      detectedAt: input.now,
      alerts: { connect: { id: input.alertId } },
      events: {
        create: [
          { type: 'DETECTED', createdAt: input.now },
          { type: 'ALERT_FIRED', message: alertLine, createdAt: input.now },
        ],
      },
    },
    select: { id: true, number: true },
  });
  return { incidentId: incident.id, number: incident.number, created: true };
}

export interface ResolvedAlertInput {
  alertId: string;
  now: Date;
  /**
   * true when the monitor recovered: the incident resolves once none of its alerts fire.
   * false when a person changed or deleted the rule: the alert closes, but the incident stays
   * for a person to resolve, since nothing showed that the problem went away.
   */
  autoResolve: boolean;
  /** Why the alert closed, shown on the timeline. */
  reason: string;
}

/** Records an alert's resolution on its incident, resolving the incident if it recovered. */
export async function onAlertResolved(
  tx: Tx,
  input: ResolvedAlertInput,
): Promise<{ incidentId: string; autoResolved: boolean } | null> {
  const alert = await tx.alert.findUnique({
    where: { id: input.alertId },
    select: { incidentId: true },
  });
  if (!alert?.incidentId) return null;
  const locked = await lockIncident(tx, alert.incidentId);
  if (!locked) return null;

  await tx.incidentEvent.create({
    data: {
      incidentId: alert.incidentId,
      type: 'ALERT_RESOLVED',
      message: input.reason.slice(0, 2000),
      createdAt: input.now,
    },
  });

  if (!input.autoResolve || locked.status === 'RESOLVED') {
    return { incidentId: alert.incidentId, autoResolved: false };
  }
  const stillFiring = await tx.alert.count({
    where: { incidentId: alert.incidentId, status: 'FIRING' },
  });
  if (stillFiring > 0) return { incidentId: alert.incidentId, autoResolved: false };

  await tx.incident.update({
    where: { id: alert.incidentId },
    data: { status: 'RESOLVED', resolvedAt: input.now, resolvedById: null },
  });
  await tx.incidentEvent.create({
    data: {
      incidentId: alert.incidentId,
      type: 'STATUS_CHANGED',
      fromValue: locked.status,
      toValue: 'RESOLVED',
      createdAt: input.now,
    },
  });
  return { incidentId: alert.incidentId, autoResolved: true };
}
