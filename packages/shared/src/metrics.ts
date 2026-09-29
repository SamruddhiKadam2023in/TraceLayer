import { z } from 'zod';

// ─── Time ranges ─────────────────────────────────────────────────────────────

export const METRIC_RANGES = ['1h', '6h', '24h', '7d', '30d'] as const;
export type MetricRange = (typeof METRIC_RANGES)[number];

const HOUR = 3_600_000;

/** Window length and chart bucket size per range: 60–168 points, fine enough to read. */
export const RANGE_CONFIG: Record<
  MetricRange,
  { label: string; durationMs: number; bucketMs: number }
> = {
  '1h': { label: 'Last 1 hour', durationMs: HOUR, bucketMs: 60_000 },
  '6h': { label: 'Last 6 hours', durationMs: 6 * HOUR, bucketMs: 5 * 60_000 },
  '24h': { label: 'Last 24 hours', durationMs: 24 * HOUR, bucketMs: 15 * 60_000 },
  '7d': { label: 'Last 7 days', durationMs: 7 * 24 * HOUR, bucketMs: HOUR },
  '30d': { label: 'Last 30 days', durationMs: 30 * 24 * HOUR, bucketMs: 6 * HOUR },
};

export const metricsQuerySchema = z.object({
  projectId: z.uuid('Invalid project'),
  range: z.enum(METRIC_RANGES).default('24h'),
  monitorId: z.uuid('Invalid monitor').optional(),
  endpointId: z.uuid('Invalid endpoint').optional(),
  environmentId: z.uuid('Invalid environment').optional(),
});
export type MetricsQuery = z.input<typeof metricsQuerySchema>;
export type MetricsQueryParsed = z.output<typeof metricsQuerySchema>;

// ─── Results ─────────────────────────────────────────────────────────────────

export interface LatencyStats {
  /** All in milliseconds, over runs that received a response; null when there were none. */
  avg: number | null;
  min: number | null;
  max: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface StatusDistribution {
  '2xx': number;
  '3xx': number;
  '4xx': number;
  '5xx': number;
  /** Runs with no HTTP response: timeouts, connection errors, blocked targets, config errors. */
  noResponse: number;
}

export interface MetricsTotals {
  total: number;
  successful: number;
  failed: number;
  /** Percentage of successful runs (0–100); null when there were no runs. */
  uptime: number | null;
  /** Percentage of failed runs (0–100); null when there were no runs. */
  errorRate: number | null;
}

export interface MetricsWindow {
  range: MetricRange;
  from: string;
  to: string;
}

export interface MetricsSummary extends MetricsWindow {
  totals: MetricsTotals;
  latency: LatencyStats;
  statusCodes: StatusDistribution;
}

export interface LatencyPoint {
  /** Start of the bucket. */
  t: string;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface ErrorPoint {
  t: string;
  /** Request volume in the bucket. */
  total: number;
  failed: number;
  errorRate: number | null;
}

export interface TimeSeries<Point> extends MetricsWindow {
  bucketMs: number;
  points: Point[];
}

// ─── Health (spec §24) ───────────────────────────────────────────────────────

export const HEALTH_STATUSES = ['HEALTHY', 'DEGRADED', 'FAILING', 'NO_DATA'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/** How many of a monitor's latest runs the health status looks at. */
export const HEALTH_WINDOW = 10;
/** Consecutive latest failures that make a monitor failing. */
export const FAILING_STREAK = 3;
/** Share of failures in the window that makes a monitor failing. */
export const FAILING_RATIO = 0.5;

/**
 * Deterministic health from a monitor's most recent runs (newest first):
 * - NO_DATA: no runs yet.
 * - FAILING: the last 3 runs all failed, or at least half of the last 10 failed.
 * - DEGRADED: any other failure in the last 10 (intermittent problems).
 * - HEALTHY: none of the last 10 failed.
 */
export function computeHealth(recentRuns: readonly { success: boolean }[]): HealthStatus {
  const runs = recentRuns.slice(0, HEALTH_WINDOW);
  if (runs.length === 0) return 'NO_DATA';
  const failures = runs.filter((r) => !r.success).length;
  const streak = runs.slice(0, FAILING_STREAK);
  if (streak.length === FAILING_STREAK && streak.every((r) => !r.success)) return 'FAILING';
  if (failures / runs.length >= FAILING_RATIO) return 'FAILING';
  if (failures > 0) return 'DEGRADED';
  return 'HEALTHY';
}

export interface MonitorMetrics {
  monitor: { id: string; name: string; enabled: boolean };
  endpoint: { id: string; name: string; method: string };
  environment: { id: string; name: string } | null;
  health: HealthStatus;
  totals: MetricsTotals;
  latency: Pick<LatencyStats, 'avg' | 'p95'>;
}

export interface MetricsOverview extends MetricsWindow {
  monitors: MonitorMetrics[];
  health: Record<HealthStatus, number>;
}
