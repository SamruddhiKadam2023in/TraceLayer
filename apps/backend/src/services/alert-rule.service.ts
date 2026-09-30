import { onAlertResolved, type Prisma } from '@tracelayer/db';
import {
  alertRuleSchema,
  describeRule,
  MAX_RULES_PER_MONITOR,
  type AlertRuleConfig,
  type AlertRuleView,
  type FiredAlertView,
  type UpdateAlertRuleInput,
} from '@tracelayer/shared';
import { lockRow } from '../lib/locks';
import { publishIncidentChange } from './incident.service';
import { prisma } from '../lib/prisma';
import { AppError } from '../utils/errors';
import { compareNames } from '../utils/sort';
import type { AlertRuleAccess, ProjectAccess } from './access.service';

const ruleInclude = {
  monitor: { select: { id: true, name: true } },
  channels: { select: { channelId: true } },
} as const satisfies Prisma.AlertRuleInclude;

type RuleRow = Prisma.AlertRuleGetPayload<{ include: typeof ruleInclude }>;

function toView(row: RuleRow): AlertRuleView {
  const config = {
    monitorId: row.monitorId,
    name: row.name,
    metric: row.metric,
    threshold: row.threshold,
    durationMinutes: row.durationMinutes,
    severity: row.severity,
    enabled: row.enabled,
    channelIds: row.channels.map((c) => c.channelId).sort(),
  };
  return {
    id: row.id,
    projectId: row.projectId,
    ...config,
    monitor: row.monitor,
    state: row.state,
    pendingSince: row.pendingSince?.toISOString() ?? null,
    lastValue: row.lastValue,
    lastEvaluatedAt: row.lastEvaluatedAt?.toISOString() ?? null,
    description: describeRule(config),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function fieldError(code: 'NOT_FOUND' | 'CONFLICT', path: string, message: string): AppError {
  return new AppError(code, message, [{ path, message }]);
}

/** Channels must belong to the rule's workspace. */
async function assertChannelsInWorkspace(workspaceId: string, channelIds: string[]): Promise<void> {
  if (channelIds.length === 0) return;
  const found = await prisma.notificationChannel.count({
    where: { id: { in: channelIds }, workspaceId },
  });
  if (found !== channelIds.length) {
    throw fieldError(
      'NOT_FOUND',
      'channelIds',
      'A notification channel was not found in this workspace',
    );
  }
}

/**
 * Resolves the rule's open alert, e.g. when the rule is changed, disabled or deleted, and notes
 * it on the incident's timeline. The incident itself stays open: a changed rule says nothing
 * about whether the problem went away. The rule row is locked first, the same order the worker
 * uses, so an evaluation in progress finishes before the alert is closed.
 */
async function resolveOpenAlert(
  tx: Prisma.TransactionClient,
  ruleId: string,
  reason: string,
): Promise<string[]> {
  await lockRow(tx, 'alert_rules', ruleId);
  const open = await tx.alert.findMany({
    where: { ruleId, status: 'FIRING' },
    select: { id: true, rule: { select: { name: true } } },
  });
  const now = new Date();
  const incidentIds: string[] = [];
  for (const alert of open) {
    await tx.alert.update({
      where: { id: alert.id },
      data: { status: 'RESOLVED', resolvedAt: now },
    });
    const outcome = await onAlertResolved(tx, {
      alertId: alert.id,
      now,
      autoResolve: false,
      reason: `${alert.rule?.name ?? 'Alert rule'}: ${reason}`,
    });
    if (outcome) incidentIds.push(outcome.incidentId);
  }
  return incidentIds;
}

export async function listRules(
  access: ProjectAccess,
  monitorId?: string,
): Promise<AlertRuleView[]> {
  const rows = await prisma.alertRule.findMany({
    where: { projectId: access.projectId, ...(monitorId ? { monitorId } : {}) },
    include: ruleInclude,
  });
  return rows.map(toView).sort((a, b) => compareNames(a.name, b.name));
}

export async function createRule(
  access: ProjectAccess,
  config: AlertRuleConfig,
): Promise<AlertRuleView> {
  const monitor = await prisma.monitor.findFirst({
    where: { id: config.monitorId, projectId: access.projectId },
    select: { id: true },
  });
  if (!monitor) throw fieldError('NOT_FOUND', 'monitorId', 'Monitor not found in this project');
  await assertChannelsInWorkspace(access.workspaceId, config.channelIds);

  const row = await prisma.$transaction(async (tx) => {
    await lockRow(tx, 'projects', access.projectId);
    const count = await tx.alertRule.count({ where: { monitorId: config.monitorId } });
    if (count >= MAX_RULES_PER_MONITOR) {
      throw new AppError(
        'CONFLICT',
        `A monitor can have at most ${MAX_RULES_PER_MONITOR} alert rules`,
      );
    }
    return tx.alertRule.create({
      data: {
        projectId: access.projectId,
        monitorId: config.monitorId,
        name: config.name,
        metric: config.metric,
        threshold: config.threshold,
        durationMinutes: config.durationMinutes,
        severity: config.severity,
        enabled: config.enabled,
        createdById: access.userId,
        channels: { create: config.channelIds.map((channelId) => ({ channelId })) },
      },
      include: ruleInclude,
    });
  });
  return toView(row);
}

export async function getRule(access: AlertRuleAccess): Promise<AlertRuleView> {
  return toView(
    await prisma.alertRule.findUniqueOrThrow({
      where: { id: access.ruleId },
      include: ruleInclude,
    }),
  );
}

/**
 * Changing what a rule measures starts it afresh: its state resets and an open alert is
 * resolved, since that alert was raised under different conditions. If the new condition is
 * breached, the next check fires a new alert.
 */
export async function updateRule(
  access: AlertRuleAccess,
  changes: UpdateAlertRuleInput,
): Promise<AlertRuleView> {
  const current = await getRule(access);
  const config = alertRuleSchema.parse({ ...current, ...changes });
  if (changes.channelIds) await assertChannelsInWorkspace(access.workspaceId, config.channelIds);

  const conditionChanged =
    config.metric !== current.metric ||
    config.threshold !== current.threshold ||
    config.durationMinutes !== current.durationMinutes ||
    (current.enabled && !config.enabled);

  let closedIncidents: string[] = [];
  const row = await prisma.$transaction(async (tx) => {
    if (conditionChanged) {
      closedIncidents = await resolveOpenAlert(
        tx,
        access.ruleId,
        config.enabled
          ? 'closed because the rule was changed'
          : 'closed because the rule was disabled',
      );
    }
    if (changes.channelIds) {
      await tx.alertRuleChannel.deleteMany({ where: { ruleId: access.ruleId } });
      await tx.alertRuleChannel.createMany({
        data: config.channelIds.map((channelId) => ({ ruleId: access.ruleId, channelId })),
      });
    }
    return tx.alertRule.update({
      where: { id: access.ruleId },
      data: {
        name: config.name,
        metric: config.metric,
        threshold: config.threshold,
        durationMinutes: config.durationMinutes,
        severity: config.severity,
        enabled: config.enabled,
        ...(conditionChanged ? { state: 'OK', pendingSince: null } : {}),
      },
      include: ruleInclude,
    });
  });
  for (const id of closedIncidents) {
    publishIncidentChange(access.workspaceId, id, 'alert_closed', access.userId);
  }
  return toView(row);
}

/** Deletes the rule; its alert history stays (with the rule reference cleared). */
export async function deleteRule(access: AlertRuleAccess): Promise<void> {
  const closedIncidents = await prisma.$transaction(async (tx) => {
    const ids = await resolveOpenAlert(tx, access.ruleId, 'closed because the rule was deleted');
    await tx.alertRule.delete({ where: { id: access.ruleId } });
    return ids;
  });
  for (const id of closedIncidents) {
    publishIncidentChange(access.workspaceId, id, 'alert_closed', access.userId);
  }
}

export async function listFiredAlerts(
  access: ProjectAccess,
  query: { status?: 'FIRING' | 'RESOLVED'; limit: number },
): Promise<FiredAlertView[]> {
  const rows = await prisma.alert.findMany({
    where: { projectId: access.projectId, ...(query.status ? { status: query.status } : {}) },
    include: {
      rule: { select: { id: true, name: true } },
      monitor: { select: { id: true, name: true } },
      incident: { select: { id: true, number: true } },
    },
    // Firing first, then newest.
    orderBy: [{ status: 'asc' }, { firedAt: 'desc' }],
    take: query.limit,
  });
  return rows.map((a) => ({
    id: a.id,
    rule: a.rule,
    monitor: a.monitor,
    incident: a.incident,
    severity: a.severity,
    status: a.status,
    value: a.value,
    threshold: a.threshold,
    message: a.message,
    firedAt: a.firedAt.toISOString(),
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
  }));
}
