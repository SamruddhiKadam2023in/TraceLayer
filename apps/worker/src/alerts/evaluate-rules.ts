import type { Prisma, PrismaClient } from '@tracelayer/db';
import {
  checkCondition,
  describeBreach,
  nextRuleState,
  type AlertMetric,
  type RuleObservation,
} from '@tracelayer/shared';

export interface RuleEvaluationResult {
  ruleId: string;
  transition: 'fired' | 'resolved' | null;
  alertId: string | null;
}

interface WindowRow {
  total: number;
  successful: number;
  p95: number | null;
}

const WINDOW_METRICS: AlertMetric[] = ['LATENCY_P95', 'ERROR_RATE', 'UPTIME'];

/** Aggregates of the monitor's runs in the last `minutes` (latency over responses only). */
async function windowStats(
  tx: Prisma.TransactionClient,
  monitorId: string,
  minutes: number,
  now: Date,
): Promise<RuleObservation['window']> {
  const from = new Date(now.getTime() - minutes * 60_000);
  const [row] = await tx.$queryRaw<WindowRow[]>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE success)::int AS successful,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
             FILTER (WHERE status_code IS NOT NULL) AS p95
    FROM monitor_runs
    WHERE monitor_id = ${monitorId}::uuid AND started_at > ${from} AND started_at <= ${now}`;
  if (!row || row.total === 0) return null;
  const errorRate = ((row.total - row.successful) / row.total) * 100;
  return {
    total: row.total,
    p95: row.p95,
    errorRate: Math.round(errorRate * 100) / 100,
    uptime: Math.round((100 - errorRate) * 100) / 100,
  };
}

/**
 * Spec §19 step 13: evaluates every enabled rule of the monitor after a run, moves each rule
 * through OK → PENDING → FIRING, and opens or resolves alerts. The rules are locked for the
 * duration, so two runs finishing together cannot fire the same alert twice.
 */
export async function evaluateMonitorRules(
  prisma: PrismaClient,
  monitorId: string,
  now = new Date(),
): Promise<RuleEvaluationResult[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM alert_rules WHERE monitor_id = ${monitorId}::uuid AND enabled FOR UPDATE`;
    const rules = await tx.alertRule.findMany({ where: { monitorId, enabled: true } });
    if (rules.length === 0) return [];

    const monitor = await tx.monitor.findUniqueOrThrow({
      where: { id: monitorId },
      select: { projectId: true, consecutiveFailures: true },
    });
    const latest = await tx.monitorRun.findFirst({
      where: { monitorId },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { statusCode: true, durationMs: true },
    });

    // One aggregate query per distinct window, shared by the rules that use it.
    const windows = new Map<number, RuleObservation['window']>();
    for (const rule of rules) {
      if (WINDOW_METRICS.includes(rule.metric) && !windows.has(rule.durationMinutes)) {
        windows.set(
          rule.durationMinutes,
          await windowStats(tx, monitorId, rule.durationMinutes, now),
        );
      }
    }

    const results: RuleEvaluationResult[] = [];
    for (const rule of rules) {
      const observation: RuleObservation = {
        latestRun: latest,
        consecutiveFailures: monitor.consecutiveFailures,
        window: windows.get(rule.durationMinutes) ?? null,
      };
      const { breached, value } = checkCondition(rule, observation);
      const next = nextRuleState(
        rule,
        { state: rule.state, pendingSince: rule.pendingSince },
        breached,
        now,
      );

      await tx.alertRule.update({
        where: { id: rule.id },
        data: {
          state: next.state,
          pendingSince: next.pendingSince,
          lastEvaluatedAt: now,
          ...(breached !== null ? { lastValue: value } : {}),
        },
      });

      let alertId: string | null = null;
      if (next.transition === 'fired') {
        const alert = await tx.alert.create({
          data: {
            ruleId: rule.id,
            monitorId,
            projectId: monitor.projectId,
            severity: rule.severity,
            value,
            threshold: rule.threshold,
            message: describeBreach(rule, value).slice(0, 500),
            firedAt: now,
          },
          select: { id: true },
        });
        alertId = alert.id;
      } else if (next.transition === 'resolved') {
        const open = await tx.alert.findFirst({
          where: { ruleId: rule.id, status: 'FIRING' },
          orderBy: { firedAt: 'desc' },
          select: { id: true },
        });
        if (open) {
          await tx.alert.update({
            where: { id: open.id },
            data: { status: 'RESOLVED', resolvedAt: now },
          });
          alertId = open.id;
        }
      }
      results.push({ ruleId: rule.id, transition: next.transition, alertId });
    }
    return results;
  });
}

/** Queues one notification per enabled channel of the rule, recording each in the delivery log. */
export async function createAlertNotifications(
  prisma: PrismaClient,
  result: RuleEvaluationResult,
): Promise<string[]> {
  if (!result.transition || !result.alertId) return [];
  const rule = await prisma.alertRule.findUnique({
    where: { id: result.ruleId },
    include: {
      channels: { include: { channel: true } },
      project: { select: { workspaceId: true } },
    },
  });
  if (!rule) return [];
  const channels = rule.channels.map((c) => c.channel).filter((c) => c.enabled);
  const ids: string[] = [];
  for (const channel of channels) {
    const notification = await prisma.notification.create({
      data: {
        workspaceId: rule.project.workspaceId,
        channelId: channel.id,
        alertId: result.alertId,
        event: result.transition === 'fired' ? 'ALERT_FIRED' : 'ALERT_RESOLVED',
      },
      select: { id: true },
    });
    ids.push(notification.id);
  }
  return ids;
}
