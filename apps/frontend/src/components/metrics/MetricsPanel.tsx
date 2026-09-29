import { useState } from 'react';
import { RANGE_CONFIG, type MetricRange, type MetricsQuery } from '@tracelayer/shared';
import { LoadError } from '@/components/EmptyState';
import { useQuery } from '@/hooks/useQuery';
import { fetchMetricsSummary } from '@/services/metrics.service';
import { formatLatency, formatPercent } from '@/utils/format';
import { MetricCard } from './MetricCard';
import { RangePicker } from './RangePicker';
import { StatusDistributionBar } from './StatusDistributionBar';

function uptimeTone(uptime: number | null) {
  if (uptime === null) return 'default' as const;
  if (uptime >= 99) return 'good' as const;
  if (uptime >= 95) return 'warn' as const;
  return 'bad' as const;
}

interface MetricsPanelProps {
  /** Scope of the numbers: a project, optionally narrowed to a monitor, endpoint or environment. */
  scope: Omit<MetricsQuery, 'range'>;
  initialRange?: MetricRange;
}

export function MetricsPanel({ scope, initialRange = '24h' }: MetricsPanelProps) {
  const [range, setRange] = useState<MetricRange>(initialRange);
  const query = { ...scope, range };
  const { data, error, reload, loading } = useQuery(
    `metrics-summary:${JSON.stringify(query)}`,
    () => fetchMetricsSummary(query),
  );

  return (
    <section aria-labelledby="metrics-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="metrics-heading" className="text-sm font-semibold">
          Metrics{' '}
          <span className="font-normal text-fg-subtle">
            · {RANGE_CONFIG[range].label.toLowerCase()}
          </span>
        </h3>
        <RangePicker value={range} onChange={setRange} />
      </div>

      {error && !data ? (
        <LoadError message={error.message} onRetry={reload} />
      ) : !data ? (
        <div
          aria-hidden="true"
          className="h-24 animate-pulse rounded-lg border border-line bg-surface"
        />
      ) : (
        <div aria-busy={loading} className="flex flex-col gap-3">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            <MetricCard
              label="Uptime"
              value={formatPercent(data.totals.uptime)}
              tone={uptimeTone(data.totals.uptime)}
            />
            <MetricCard
              label="Checks"
              value={data.totals.total.toLocaleString()}
              detail={`${data.totals.failed} failed`}
            />
            <MetricCard
              label="Error rate"
              value={formatPercent(data.totals.errorRate)}
              tone={data.totals.errorRate ? 'bad' : 'default'}
            />
            <MetricCard label="Average" value={formatLatency(data.latency.avg)} />
            <MetricCard label="P50" value={formatLatency(data.latency.p50)} />
            <MetricCard label="P95" value={formatLatency(data.latency.p95)} />
            <MetricCard label="P99" value={formatLatency(data.latency.p99)} />
          </dl>
          <div className="rounded-lg border border-line bg-surface p-3">
            <p className="mb-2 text-xs text-fg-muted">Status codes</p>
            <StatusDistributionBar distribution={data.statusCodes} />
          </div>
          <p className="text-xs text-fg-subtle">
            Latency counts only checks that received a response; timeouts and connection errors
            count as failures.
          </p>
        </div>
      )}
    </section>
  );
}
