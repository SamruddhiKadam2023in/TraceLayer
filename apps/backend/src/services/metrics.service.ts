import { Prisma } from '@tracelayer/db';
import {
  computeHealth,
  HEALTH_STATUSES,
  HEALTH_WINDOW,
  RANGE_CONFIG,
  type ErrorPoint,
  type HealthStatus,
  type LatencyPoint,
  type LatencyStats,
  type MetricRange,
  type MetricsOverview,
  type MetricsQueryParsed,
  type MetricsSummary,
  type MetricsTotals,
  type MetricsWindow,
  type StatusDistribution,
  type TimeSeries,
} from '@tracelayer/shared';
import { prisma } from '../lib/prisma';
import { AppError } from '../utils/errors';
import type { ProjectAccess } from './access.service';

/**
 * Metrics are computed in PostgreSQL from `monitor_runs`, never from cached numbers:
 * - latency statistics only use runs that got a response (a timeout's duration is just the
 *   timeout, and would distort percentiles); timeouts still count as failures;
 * - percentiles use percentile_cont (linear interpolation between the closest ranks);
 * - time series use fixed buckets (date_bin) with empty buckets filled in (generate_series),
 *   so charts show gaps instead of joining points across them.
 */

type Filters = Omit<MetricsQueryParsed, 'projectId' | 'range'>;

interface Window {
  from: Date;
  to: Date;
  range: MetricRange;
}

function windowFor(range: MetricRange, now = new Date()): Window {
  return { range, from: new Date(now.getTime() - RANGE_CONFIG[range].durationMs), to: now };
}

function describeWindow(w: Window): MetricsWindow {
  return { range: w.range, from: w.from.toISOString(), to: w.to.toISOString() };
}

/** WHERE conditions for runs of the project in the window, plus optional filters. */
function runConditions(projectId: string, w: Window, filters: Filters, alias = ''): Prisma.Sql {
  const col = (name: string) => Prisma.raw(alias ? `${alias}.${name}` : name);
  const parts = [
    Prisma.sql`${col('project_id')} = ${projectId}::uuid`,
    Prisma.sql`${col('started_at')} >= ${w.from}`,
    Prisma.sql`${col('started_at')} < ${w.to}`,
  ];
  if (filters.monitorId) parts.push(Prisma.sql`${col('monitor_id')} = ${filters.monitorId}::uuid`);
  if (filters.endpointId)
    parts.push(Prisma.sql`${col('endpoint_id')} = ${filters.endpointId}::uuid`);
  if (filters.environmentId) {
    parts.push(Prisma.sql`${col('environment_id')} = ${filters.environmentId}::uuid`);
  }
  return Prisma.join(parts, ' AND ');
}

const round = (value: number | null, digits = 0): number | null => {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function totalsFrom(total: number, successful: number): MetricsTotals {
  const failed = total - successful;
  return {
    total,
    successful,
    failed,
    uptime: total === 0 ? null : round((successful / total) * 100, 2),
    errorRate: total === 0 ? null : round((failed / total) * 100, 2),
  };
}

async function assertMonitorInProject(projectId: string, monitorId?: string): Promise<void> {
  if (!monitorId) return;
  const monitor = await prisma.monitor.findFirst({
    where: { id: monitorId, projectId },
    select: { id: true },
  });
  if (!monitor) throw AppError.notFound('Monitor');
}

// ─── Summary ─────────────────────────────────────────────────────────────────

interface SummaryRow {
  total: number;
  successful: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  no_response: number;
}

export async function getSummary(
  access: ProjectAccess,
  range: MetricRange,
  filters: Filters,
  now?: Date,
): Promise<MetricsSummary> {
  await assertMonitorInProject(access.projectId, filters.monitorId);
  const w = windowFor(range, now);
  const responded = Prisma.sql`status_code IS NOT NULL`;
  const [row] = await prisma.$queryRaw<SummaryRow[]>`
    SELECT
      count(*)::int                                            AS total,
      count(*) FILTER (WHERE success)::int                     AS successful,
      avg(duration_ms) FILTER (WHERE ${responded})::float8     AS avg,
      min(duration_ms) FILTER (WHERE ${responded})::float8     AS min,
      max(duration_ms) FILTER (WHERE ${responded})::float8     AS max,
      percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE ${responded}) AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE ${responded}) AS p95,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE ${responded}) AS p99,
      count(*) FILTER (WHERE status_code BETWEEN 200 AND 299)::int AS s2xx,
      count(*) FILTER (WHERE status_code BETWEEN 300 AND 399)::int AS s3xx,
      count(*) FILTER (WHERE status_code BETWEEN 400 AND 499)::int AS s4xx,
      count(*) FILTER (WHERE status_code >= 500)::int              AS s5xx,
      count(*) FILTER (WHERE status_code IS NULL)::int             AS no_response
    FROM monitor_runs
    WHERE ${runConditions(access.projectId, w, filters)}`;

  const r = row!;
  const latency: LatencyStats = {
    avg: round(r.avg),
    min: r.min,
    max: r.max,
    p50: round(r.p50),
    p95: round(r.p95),
    p99: round(r.p99),
  };
  const statusCodes: StatusDistribution = {
    '2xx': r.s2xx,
    '3xx': r.s3xx,
    '4xx': r.s4xx,
    '5xx': r.s5xx,
    noResponse: r.no_response,
  };
  return { ...describeWindow(w), totals: totalsFrom(r.total, r.successful), latency, statusCodes };
}

// ─── Time series ─────────────────────────────────────────────────────────────

interface BucketRow {
  t: Date;
  total: number;
  failed: number;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/** One row per bucket across the whole window, including empty buckets. */
async function buckets(access: ProjectAccess, w: Window, filters: Filters): Promise<BucketRow[]> {
  const step = Prisma.sql`${`${RANGE_CONFIG[w.range].bucketMs} milliseconds`}::interval`;
  const origin = new Date('2000-01-01T00:00:00Z');
  return prisma.$queryRaw<BucketRow[]>`
    WITH series AS (
      SELECT generate_series(date_bin(${step}, ${w.from}::timestamptz, ${origin}::timestamptz),
                             ${w.to}::timestamptz, ${step}) AS t
    ),
    runs AS (
      SELECT date_bin(${step}, started_at, ${origin}::timestamptz) AS t, success, status_code, duration_ms
      FROM monitor_runs
      WHERE ${runConditions(access.projectId, w, filters)}
    )
    SELECT
      s.t,
      count(r.t)::int                                    AS total,
      count(r.t) FILTER (WHERE NOT r.success)::int        AS failed,
      avg(r.duration_ms) FILTER (WHERE r.status_code IS NOT NULL)::float8 AS avg,
      percentile_cont(0.50) WITHIN GROUP (ORDER BY r.duration_ms) FILTER (WHERE r.status_code IS NOT NULL) AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duration_ms) FILTER (WHERE r.status_code IS NOT NULL) AS p95,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY r.duration_ms) FILTER (WHERE r.status_code IS NOT NULL) AS p99
    FROM series s
    LEFT JOIN runs r ON r.t = s.t
    GROUP BY s.t
    ORDER BY s.t`;
}

export async function getLatencySeries(
  access: ProjectAccess,
  range: MetricRange,
  filters: Filters,
  now?: Date,
): Promise<TimeSeries<LatencyPoint>> {
  await assertMonitorInProject(access.projectId, filters.monitorId);
  const w = windowFor(range, now);
  const rows = await buckets(access, w, filters);
  return {
    ...describeWindow(w),
    bucketMs: RANGE_CONFIG[range].bucketMs,
    points: rows.map((r) => ({
      t: r.t.toISOString(),
      avg: round(r.avg),
      p50: round(r.p50),
      p95: round(r.p95),
      p99: round(r.p99),
    })),
  };
}

export async function getErrorSeries(
  access: ProjectAccess,
  range: MetricRange,
  filters: Filters,
  now?: Date,
): Promise<TimeSeries<ErrorPoint>> {
  await assertMonitorInProject(access.projectId, filters.monitorId);
  const w = windowFor(range, now);
  const rows = await buckets(access, w, filters);
  return {
    ...describeWindow(w),
    bucketMs: RANGE_CONFIG[range].bucketMs,
    points: rows.map((r) => ({
      t: r.t.toISOString(),
      total: r.total,
      failed: r.failed,
      errorRate: r.total === 0 ? null : round((r.failed / r.total) * 100, 2),
    })),
  };
}

// ─── Health ──────────────────────────────────────────────────────────────────

/** Health of each monitor from its latest runs, in one query (window function). */
export async function healthByMonitor(monitorIds: string[]): Promise<Map<string, HealthStatus>> {
  const health = new Map<string, HealthStatus>(monitorIds.map((id) => [id, 'NO_DATA']));
  if (monitorIds.length === 0) return health;
  const rows = await prisma.$queryRaw<{ monitor_id: string; success: boolean }[]>`
    SELECT monitor_id::text AS monitor_id, success
    FROM (
      SELECT monitor_id, success,
             row_number() OVER (PARTITION BY monitor_id ORDER BY started_at DESC, id DESC) AS rn
      FROM monitor_runs
      WHERE monitor_id IN (${Prisma.join(monitorIds.map((id) => Prisma.sql`${id}::uuid`))})
    ) latest
    WHERE rn <= ${HEALTH_WINDOW}
    ORDER BY monitor_id, rn`;

  const runsByMonitor = new Map<string, { success: boolean }[]>();
  for (const row of rows) {
    const list = runsByMonitor.get(row.monitor_id) ?? [];
    list.push({ success: row.success });
    runsByMonitor.set(row.monitor_id, list);
  }
  for (const [id, runs] of runsByMonitor) health.set(id, computeHealth(runs));
  return health;
}

// ─── Per-monitor overview ────────────────────────────────────────────────────

interface MonitorRow {
  monitor_id: string;
  total: number;
  successful: number;
  avg: number | null;
  p95: number | null;
}

export async function getOverview(
  access: ProjectAccess,
  range: MetricRange,
  filters: Filters,
  now?: Date,
): Promise<MetricsOverview> {
  const w = windowFor(range, now);
  const monitors = await prisma.monitor.findMany({
    where: {
      projectId: access.projectId,
      ...(filters.monitorId ? { id: filters.monitorId } : {}),
      ...(filters.endpointId ? { endpointId: filters.endpointId } : {}),
      ...(filters.environmentId ? { environmentId: filters.environmentId } : {}),
    },
    include: {
      endpoint: { select: { id: true, name: true, method: true } },
      environment: { select: { id: true, name: true } },
    },
    orderBy: { name: 'asc' },
  });

  const rows =
    monitors.length === 0
      ? []
      : await prisma.$queryRaw<MonitorRow[]>`
          SELECT monitor_id::text AS monitor_id,
                 count(*)::int AS total,
                 count(*) FILTER (WHERE success)::int AS successful,
                 avg(duration_ms) FILTER (WHERE status_code IS NOT NULL)::float8 AS avg,
                 percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE status_code IS NOT NULL) AS p95
          FROM monitor_runs
          WHERE ${runConditions(access.projectId, w, filters)}
          GROUP BY monitor_id`;
  const stats = new Map(rows.map((r) => [r.monitor_id, r]));
  const health = await healthByMonitor(monitors.map((m) => m.id));

  const counts = Object.fromEntries(HEALTH_STATUSES.map((s) => [s, 0])) as Record<
    HealthStatus,
    number
  >;
  const items = monitors.map((m) => {
    const s = stats.get(m.id);
    const status = health.get(m.id) ?? 'NO_DATA';
    counts[status]++;
    return {
      monitor: { id: m.id, name: m.name, enabled: m.enabled },
      endpoint: m.endpoint,
      environment: m.environment,
      health: status,
      totals: totalsFrom(s?.total ?? 0, s?.successful ?? 0),
      latency: { avg: round(s?.avg ?? null), p95: round(s?.p95 ?? null) },
    };
  });

  return { ...describeWindow(w), monitors: items, health: counts };
}
