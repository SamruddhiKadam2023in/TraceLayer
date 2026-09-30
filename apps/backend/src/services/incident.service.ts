import { lockIncident, type Prisma } from '@tracelayer/db';
import {
  hasPermission,
  type IncidentDetail,
  type IncidentEventType,
  type IncidentEventView,
  type IncidentListQueryParsed,
  type IncidentPage,
  type IncidentSummary,
  type UpdateIncidentInput,
} from '@tracelayer/shared';
import { prisma } from '../lib/prisma';
import { AppError } from '../utils/errors';
import type { IncidentAccess, ProjectAccess, WorkspaceAccess } from './access.service';

const person = { select: { id: true, name: true } } as const;

const summaryInclude = {
  project: { select: { id: true, name: true } },
  monitor: { select: { id: true, name: true } },
  assignee: person,
  resolvedBy: person,
  _count: { select: { alerts: { where: { status: 'FIRING' } } } },
} as const satisfies Prisma.IncidentInclude;

type SummaryRow = Prisma.IncidentGetPayload<{ include: typeof summaryInclude }>;

function toSummary(row: SummaryRow): IncidentSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    title: row.title,
    severity: row.severity,
    status: row.status,
    project: row.project,
    monitor: row.monitor,
    assignee: row.assignee,
    firingAlerts: row._count.alerts,
    detectedAt: row.detectedAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
  };
}

type EventRow = Prisma.IncidentEventGetPayload<{ include: { actor: typeof person } }>;

function toEventView(e: EventRow): IncidentEventView {
  return {
    id: e.id,
    type: e.type,
    actor: e.actor,
    message: e.message,
    fromValue: e.fromValue,
    toValue: e.toValue,
    createdAt: e.createdAt.toISOString(),
  };
}

/**
 * System events written in one step share a timestamp; this keeps them in the order they
 * happen: detected → alert → (recovery → resolution | escalation), and a person's status,
 * severity and assignee changes in the order they are written.
 */
const EVENT_ORDER: Record<IncidentEventType, number> = {
  DETECTED: 0,
  ALERT_FIRED: 1,
  ALERT_RESOLVED: 2,
  STATUS_CHANGED: 3,
  SEVERITY_CHANGED: 4,
  ASSIGNED: 5,
  COMMENT: 6,
};

export async function listIncidents(
  scope: ProjectAccess | WorkspaceAccess,
  query: IncidentListQueryParsed,
): Promise<IncidentPage> {
  const where: Prisma.IncidentWhereInput = {
    ...('projectId' in scope
      ? { projectId: scope.projectId }
      : { project: { workspaceId: scope.workspaceId } }),
    ...(query.status === 'ACTIVE'
      ? { status: { not: 'RESOLVED' } }
      : query.status
        ? { status: query.status }
        : {}),
    ...(query.severity ? { severity: query.severity } : {}),
    ...(query.assigneeId ? { assigneeId: query.assigneeId } : {}),
    ...(query.monitorId ? { monitorId: query.monitorId } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.incident.findMany({
      where,
      include: summaryInclude,
      orderBy: [{ detectedAt: 'desc' }, { number: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.incident.count({ where }),
  ]);
  return { items: rows.map(toSummary), total, page: query.page, pageSize: query.pageSize };
}

export async function getIncident(access: IncidentAccess): Promise<IncidentDetail> {
  const row = await prisma.incident.findUniqueOrThrow({
    where: { id: access.incidentId },
    include: {
      ...summaryInclude,
      alerts: {
        include: { rule: { select: { id: true, name: true } } },
        orderBy: { firedAt: 'asc' },
      },
      events: { include: { actor: person }, orderBy: { createdAt: 'asc' } },
    },
  });
  const events = row.events
    .map((e) => ({ row: e, t: e.createdAt.getTime() }))
    .sort((a, b) => a.t - b.t || EVENT_ORDER[a.row.type] - EVENT_ORDER[b.row.type])
    .map(({ row: e }) => toEventView(e));
  return {
    ...toSummary(row),
    alerts: row.alerts.map((a) => ({
      id: a.id,
      rule: a.rule,
      severity: a.severity,
      status: a.status,
      message: a.message,
      firedAt: a.firedAt.toISOString(),
      resolvedAt: a.resolvedAt?.toISOString() ?? null,
    })),
    events,
  };
}

/** Only people who can work on incidents can be assigned one (spec §26: existing members). */
async function findAssignee(workspaceId: string, userId: string) {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true, user: { select: { id: true, name: true } } },
  });
  if (!member) {
    throw new AppError('NOT_FOUND', 'Assignee not found in this workspace', [
      { path: 'assigneeId', message: 'Choose a member of this workspace' },
    ]);
  }
  if (!hasPermission(member.role, 'incidents.manage')) {
    throw new AppError('VALIDATION_ERROR', 'Viewers cannot be assigned incidents', [
      { path: 'assigneeId', message: 'Viewers cannot be assigned incidents' },
    ]);
  }
  return member.user;
}

/**
 * Status, severity and assignment changes (spec §26: acknowledge, assign, update status,
 * resolve, reopen). Each change is written to the timeline with the person who made it.
 * The incident row is locked, so a concurrent automatic resolution by the worker is applied
 * either fully before or fully after.
 */
export async function updateIncident(
  access: IncidentAccess,
  changes: UpdateIncidentInput,
): Promise<IncidentDetail> {
  const assignee =
    changes.assigneeId === undefined || changes.assigneeId === null
      ? changes.assigneeId
      : await findAssignee(access.workspaceId, changes.assigneeId);

  await prisma.$transaction(async (tx) => {
    await lockIncident(tx, access.incidentId);
    const current = await tx.incident.findUniqueOrThrow({
      where: { id: access.incidentId },
      include: { assignee: person },
    });
    const now = new Date();
    const data: Prisma.IncidentUncheckedUpdateInput = {};
    const events: Prisma.IncidentEventCreateManyInput[] = [];
    const event = (type: IncidentEventType, fromValue: string | null, toValue: string | null) =>
      events.push({
        incidentId: access.incidentId,
        type,
        actorId: access.userId,
        fromValue,
        toValue,
        createdAt: now,
      });

    if (changes.status && changes.status !== current.status) {
      data.status = changes.status;
      if (changes.status === 'RESOLVED') {
        data.resolvedAt = now;
        data.resolvedById = access.userId;
      } else if (current.status === 'RESOLVED') {
        data.resolvedAt = null;
        data.resolvedById = null;
      }
      if (!current.acknowledgedAt && changes.status !== 'OPEN') data.acknowledgedAt = now;
      event('STATUS_CHANGED', current.status, changes.status);
    }
    if (changes.severity && changes.severity !== current.severity) {
      data.severity = changes.severity;
      event('SEVERITY_CHANGED', current.severity, changes.severity);
    }
    if (assignee !== undefined && (assignee?.id ?? null) !== current.assigneeId) {
      data.assigneeId = assignee?.id ?? null;
      event('ASSIGNED', current.assignee?.name ?? null, assignee?.name ?? null);
    }

    if (events.length === 0) return;
    await tx.incident.update({ where: { id: access.incidentId }, data });
    await tx.incidentEvent.createMany({ data: events });
  });
  return getIncident(access);
}

export async function addComment(
  access: IncidentAccess,
  message: string,
): Promise<IncidentEventView> {
  const event = await prisma.incidentEvent.create({
    data: { incidentId: access.incidentId, type: 'COMMENT', actorId: access.userId, message },
    include: { actor: person },
  });
  return toEventView(event);
}
