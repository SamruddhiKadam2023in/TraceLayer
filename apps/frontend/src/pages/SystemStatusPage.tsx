import { RefreshCw, ServerCrash } from 'lucide-react';
import type { DependencyHealth, HealthReport } from '@tracelayer/shared';
import { StatusBadge } from '@/components/StatusBadge';
import { useHealth } from '@/hooks/useHealth';
import { formatDuration, formatLatency, formatTime } from '@/utils/format';

interface ServiceRow {
  key: string;
  name: string;
  description: string;
  health: DependencyHealth;
  detail: string | null;
}

function buildRows(report: HealthReport, roundTripMs: number | null): ServiceRow[] {
  const { database, redis, worker } = report.dependencies;
  return [
    {
      key: 'api',
      name: 'API server',
      description: 'Express REST API',
      health: { status: 'up', latencyMs: roundTripMs },
      detail: `v${report.version} · up ${formatDuration(report.uptimeSeconds)}`,
    },
    {
      key: 'database',
      name: 'PostgreSQL',
      description: 'Primary datastore',
      health: database,
      detail: database.error ?? null,
    },
    {
      key: 'redis',
      name: 'Redis',
      description: 'Queue backend and cache',
      health: redis,
      detail: redis.error ?? null,
    },
    {
      key: 'worker',
      name: 'Monitor worker',
      description: 'BullMQ job processor',
      health: worker,
      detail: worker.lastHeartbeatAt
        ? `last heartbeat ${formatTime(worker.lastHeartbeatAt)}`
        : (worker.error ?? null),
    },
  ];
}

function LoadingRows() {
  return (
    <ul aria-hidden="true" className="divide-y divide-line">
      {Array.from({ length: 4 }, (_, i) => (
        <li key={i} className="flex items-center gap-4 px-4 py-3.5">
          <div className="h-4 w-32 animate-pulse rounded bg-surface-2" />
          <div className="ml-auto h-4 w-20 animate-pulse rounded bg-surface-2" />
        </li>
      ))}
    </ul>
  );
}

export function SystemStatusPage() {
  const { report, roundTripMs, error, loading, refetch } = useHealth();
  const rows = report ? buildRows(report, roundTripMs) : [];
  const down = rows.filter((r) => r.health.status === 'down');

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">System status</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Live health of TraceLayer platform services. Refreshes every 10 seconds.
          </p>
        </div>
        <button
          type="button"
          onClick={refetch}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-fg-muted hover:text-fg disabled:opacity-60"
        >
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          Refresh
        </button>
      </div>

      <section
        aria-labelledby="services-heading"
        aria-busy={loading && !report}
        className="overflow-hidden rounded-lg border border-line bg-surface"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 id="services-heading" className="text-sm font-medium">
            Services
          </h2>
          {report && !error && (
            <StatusBadge
              tone={down.length === 0 ? 'healthy' : 'degraded'}
              label={
                down.length === 0
                  ? 'All systems operational'
                  : `${down.length} service${down.length > 1 ? 's' : ''} down`
              }
            />
          )}
        </div>

        {error ? (
          <div role="alert" className="flex flex-col items-center gap-3 px-4 py-12 text-center">
            <ServerCrash className="size-6 text-fail" aria-hidden="true" />
            <p className="text-sm text-fg-muted">{error}</p>
            <button
              type="button"
              onClick={refetch}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg"
            >
              Retry
            </button>
          </div>
        ) : !report ? (
          <LoadingRows />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((row) => (
              <li
                key={row.key}
                data-testid={`service-${row.key}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3"
              >
                <div className="min-w-40 flex-1">
                  <p className="text-sm font-medium">{row.name}</p>
                  <p className="text-xs text-fg-subtle">{row.description}</p>
                </div>
                {row.detail && (
                  <p className="order-last w-full truncate font-mono text-xs text-fg-subtle sm:order-none sm:w-auto sm:max-w-64">
                    {row.detail}
                  </p>
                )}
                <span className="w-14 text-right font-mono text-xs tabular-nums text-fg-muted">
                  {formatLatency(row.health.latencyMs)}
                </span>
                <StatusBadge
                  tone={row.health.status === 'up' ? 'healthy' : 'failing'}
                  label={row.health.status === 'up' ? 'Operational' : 'Down'}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {report && (
        <p className="mt-3 font-mono text-xs text-fg-subtle">
          checked at {formatTime(report.timestamp)}
        </p>
      )}
    </div>
  );
}
