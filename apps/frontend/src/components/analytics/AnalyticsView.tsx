import { useState } from 'react';
import { Link } from 'react-router';
import { Radar } from 'lucide-react';
import {
  HEALTH_STATUSES,
  RANGE_CONFIG,
  type HealthStatus,
  type MetricRange,
  type MetricsQuery,
} from '@tracelayer/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { formatMs } from '@/components/charts/chart-format';
import {
  ErrorRateChart,
  LatencyChart,
  StatusCodesChart,
  VolumeChart,
} from '@/components/charts/Charts';
import { EmptyState, LoadError } from '@/components/EmptyState';
import { MetricCard } from '@/components/metrics/MetricCard';
import { RangePicker } from '@/components/metrics/RangePicker';
import { HealthBadge } from '@/components/monitors/HealthBadge';
import { useRealtimeRefresh } from '@/hooks/useRealtime';
import { useQuery } from '@/hooks/useQuery';
import {
  fetchErrorSeries,
  fetchLatencySeries,
  fetchMetricsOverview,
  fetchMetricsSummary,
} from '@/services/metrics.service';
import { formatLatency, formatPercent } from '@/utils/format';

type Scope = Omit<MetricsQuery, 'range'>;

interface AnalyticsViewProps {
  scope: Scope;
  /** The per-monitor health table (hidden when the view is already about one monitor). */
  showMonitors?: boolean;
  /** Where "create your first monitor" should lead when there are none. */
  createMonitorHref?: string;
  initialRange?: MetricRange;
}

const HEALTH_LABEL: Record<HealthStatus, string> = {
  HEALTHY: 'Healthy',
  DEGRADED: 'Degraded',
  FAILING: 'Failing',
  NO_DATA: 'No data',
};

function uptimeTone(uptime: number | null) {
  if (uptime === null) return 'default' as const;
  if (uptime >= 99) return 'good' as const;
  return uptime >= 95 ? ('warn' as const) : ('bad' as const);
}

/**
 * Metric cards, the four standard charts, and monitor health for any scope: a workspace
 * (the dashboard), a project, an endpoint or a single monitor. Everything is real data from
 * the metrics API; every panel has loading, empty and error states.
 */
export function AnalyticsView({
  scope,
  showMonitors = true,
  createMonitorHref,
  initialRange = '24h',
}: AnalyticsViewProps) {
  const [range, setRange] = useState<MetricRange>(initialRange);
  const query: MetricsQuery = { ...scope, range };
  const key = JSON.stringify(query);
  const summary = useQuery(`summary:${key}`, () => fetchMetricsSummary(query));
  const latency = useQuery(`latency:${key}`, () => fetchLatencySeries(query));
  const errors = useQuery(`errors:${key}`, () => fetchErrorSeries(query));
  // Per-monitor numbers are only needed for the monitor table and card.
  const overview = useQuery(showMonitors ? `overview:${key}` : null, () =>
    fetchMetricsOverview(query),
  );
  // New checks change every number here; refetch at most every 15 s while checks stream in.
  useRealtimeRefresh(
    (m) =>
      m.event === 'monitor.checked' &&
      (scope.monitorId
        ? m.payload.monitor.id === scope.monitorId
        : scope.projectId
          ? m.payload.projectId === scope.projectId
          : m.payload.workspaceId === scope.workspaceId),
    () => {
      summary.reload();
      latency.reload();
      errors.reload();
      overview.reload();
    },
    15_000,
  );

  const label = RANGE_CONFIG[range].label.toLowerCase();
  const s = summary.data;
  const monitors = overview.data?.monitors ?? [];
  const isWorkspace = 'workspaceId' in scope && scope.workspaceId !== undefined;

  if (showMonitors && overview.data && monitors.length === 0) {
    return (
      <EmptyState
        icon={Radar}
        title="No monitors configured yet"
        action={
          createMonitorHref && (
            <Link
              to={createMonitorHref}
              className="text-sm font-medium text-accent hover:underline"
            >
              Create your first monitor →
            </Link>
          )
        }
      >
        Analytics come from monitor runs. Once a monitor checks an endpoint, its uptime, latency and
        errors appear here.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">{RANGE_CONFIG[range].label}</p>
        <RangePicker value={range} onChange={setRange} />
      </div>

      <section aria-label="Key metrics">
        {summary.error && !s ? (
          <LoadError message={summary.error.message} onRetry={summary.reload} />
        ) : !s ? (
          <div
            aria-hidden="true"
            className="h-20 animate-pulse rounded-lg border border-line bg-surface"
          />
        ) : (
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
            <MetricCard
              label="Uptime"
              value={formatPercent(s.totals.uptime)}
              tone={uptimeTone(s.totals.uptime)}
            />
            <MetricCard
              label="Checks"
              value={s.totals.total.toLocaleString()}
              detail={`${s.totals.failed.toLocaleString()} failed`}
            />
            <MetricCard
              label="Error rate"
              value={formatPercent(s.totals.errorRate)}
              tone={s.totals.errorRate ? 'bad' : 'default'}
            />
            <MetricCard label="Average" value={formatLatency(s.latency.avg)} />
            <MetricCard label="P95" value={formatLatency(s.latency.p95)} />
            <MetricCard label="P99" value={formatLatency(s.latency.p99)} />
            {showMonitors ? (
              <MetricCard
                label="Monitors"
                value={monitors.length}
                detail={overview.data ? `${overview.data.health.FAILING} failing` : undefined}
                tone={overview.data?.health.FAILING ? 'bad' : 'default'}
              />
            ) : (
              <MetricCard label="P50" value={formatLatency(s.latency.p50)} />
            )}
          </dl>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Latency"
          summary={
            s
              ? `Latency ${label}: average ${formatMs(s.latency.avg)}, P95 ${formatMs(s.latency.p95)}, P99 ${formatMs(s.latency.p99)}.`
              : 'Latency'
          }
          loading={!latency.data && !latency.error}
          error={latency.data ? null : (latency.error?.message ?? null)}
          onRetry={latency.reload}
          empty={!latency.data?.points.some((p) => p.avg !== null)}
          emptyMessage="No responses in this period."
        >
          {latency.data && <LatencyChart points={latency.data.points} range={range} />}
        </ChartCard>
        <ChartCard
          title="Error rate"
          summary={
            s
              ? `Error rate ${label}: ${formatPercent(s.totals.errorRate)} (${s.totals.failed} of ${s.totals.total} checks failed).`
              : 'Error rate'
          }
          loading={!errors.data && !errors.error}
          error={errors.data ? null : (errors.error?.message ?? null)}
          onRetry={errors.reload}
          empty={!errors.data?.points.some((p) => p.total > 0)}
        >
          {errors.data && <ErrorRateChart points={errors.data.points} range={range} />}
        </ChartCard>
        <ChartCard
          title="Request volume"
          summary={
            s
              ? `${s.totals.total} checks ${label}: ${s.totals.successful} passed, ${s.totals.failed} failed.`
              : 'Request volume'
          }
          loading={!errors.data && !errors.error}
          error={errors.data ? null : (errors.error?.message ?? null)}
          onRetry={errors.reload}
          empty={!errors.data?.points.some((p) => p.total > 0)}
        >
          {errors.data && <VolumeChart points={errors.data.points} range={range} />}
        </ChartCard>
        <ChartCard
          title="Status codes"
          summary={
            s
              ? `Status codes ${label}: 2xx ${s.statusCodes['2xx']}, 3xx ${s.statusCodes['3xx']}, 4xx ${s.statusCodes['4xx']}, 5xx ${s.statusCodes['5xx']}, no response ${s.statusCodes.noResponse}.`
              : 'Status codes'
          }
          loading={!s && !summary.error}
          error={s ? null : (summary.error?.message ?? null)}
          onRetry={summary.reload}
          empty={!s || s.totals.total === 0}
        >
          {s && <StatusCodesChart distribution={s.statusCodes} />}
        </ChartCard>
      </div>

      {showMonitors && (
        <section
          aria-labelledby="monitor-health-heading"
          className="rounded-lg border border-line bg-surface"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h3 id="monitor-health-heading" className="text-sm font-semibold">
              Monitor health
            </h3>
            {overview.data && (
              <ul aria-label="Monitors by health" className="flex flex-wrap gap-3 text-xs">
                {HEALTH_STATUSES.map((h) => (
                  <li key={h} className="flex items-center gap-1.5">
                    <HealthBadge health={h} />
                    <span
                      className="font-mono tabular-nums"
                      aria-label={`${HEALTH_LABEL[h]}: ${overview.data!.health[h]}`}
                    >
                      {overview.data!.health[h]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {overview.error && !overview.data ? (
            <div className="p-4">
              <LoadError message={overview.error.message} onRetry={overview.reload} />
            </div>
          ) : !overview.data ? (
            <div aria-hidden="true" className="m-4 h-24 animate-pulse rounded-md bg-surface-2" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-2xl text-sm">
                <caption className="sr-only">
                  Monitors with uptime, error rate and latency {label}
                </caption>
                <thead className="border-b border-line text-left text-xs text-fg-muted">
                  <tr>
                    <th scope="col" className="w-[32%] px-4 py-2 font-medium">
                      Monitor
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Health
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Uptime
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Error rate
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Average
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      P95
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Checks
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {monitors.map((m) => (
                    <tr key={m.monitor.id} data-testid="monitor-health-row">
                      <td className="max-w-0 px-4 py-2">
                        <Link
                          to={`/projects/${m.project.id}/monitors/${m.monitor.id}`}
                          className="block truncate font-medium hover:underline"
                        >
                          {m.monitor.name}
                        </Link>
                        <p className="truncate text-xs text-fg-subtle">
                          {isWorkspace && `${m.project.name} · `}
                          <span className="font-mono">{m.endpoint.method}</span> {m.endpoint.name}
                          {m.environment && ` · ${m.environment.name}`}
                        </p>
                      </td>
                      <td className="px-3 py-2">
                        <HealthBadge health={m.health} paused={!m.monitor.enabled} />
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                        {formatPercent(m.totals.uptime)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                        {formatPercent(m.totals.errorRate)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                        {formatLatency(m.latency.avg)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                        {formatLatency(m.latency.p95)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-fg-muted">
                        {m.totals.total}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
