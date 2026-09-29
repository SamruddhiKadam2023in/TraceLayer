import { Link } from 'react-router';
import { Plus, Radar } from 'lucide-react';
import { hasPermission, MAX_MONITORS_PER_PROJECT, MONITOR_TYPE_INFO } from '@tracelayer/shared';
import { EmptyState, LoadError } from '@/components/EmptyState';
import { MethodBadge } from '@/components/endpoints/MethodBadge';
import { HealthBadge } from '@/components/monitors/HealthBadge';
import { useProject } from '@/hooks/useProject';
import { useQuery } from '@/hooks/useQuery';
import { fetchMonitors } from '@/services/monitor.service';
import { useCurrentWorkspace } from '@/stores/workspace.store';
import { formatInterval, formatRelative } from '@/utils/format';

export function ProjectMonitorsPage() {
  const { project } = useProject();
  const workspace = useCurrentWorkspace();
  const canManage = hasPermission(workspace.role, 'monitoring.manage');
  const {
    data: monitors,
    error,
    reload,
  } = useQuery(`monitors:${project.id}`, () => fetchMonitors(project.id));
  const atLimit = (monitors?.length ?? 0) >= MAX_MONITORS_PER_PROJECT;

  const newButton = canManage && !atLimit && (
    <Link
      to="new"
      className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:opacity-90"
    >
      <Plus className="size-4" aria-hidden="true" />
      New monitor
    </Link>
  );

  if (error && !monitors) return <LoadError message={error.message} onRetry={reload} />;
  if (!monitors) {
    return (
      <div
        aria-hidden="true"
        className="h-48 animate-pulse rounded-lg border border-line bg-surface"
      />
    );
  }
  if (monitors.length === 0) {
    return (
      <EmptyState icon={Radar} title="No monitors yet" action={newButton}>
        {canManage
          ? 'A monitor runs an endpoint on a schedule and records whether it was up, fast and correct.'
          : 'Monitors set up by your team will appear here.'}
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">
          {monitors.filter((m) => m.enabled).length} of {monitors.length} running
        </p>
        {newButton}
      </div>
      <ul
        aria-label="Monitors"
        className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface"
      >
        {monitors.map((monitor) => (
          <li key={monitor.id}>
            <Link
              to={monitor.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-surface-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{monitor.name}</p>
                <p className="flex min-w-0 items-center gap-1 text-xs text-fg-muted">
                  <MethodBadge method={monitor.endpoint.method} />
                  <span className="truncate">
                    {monitor.endpoint.name} · {monitor.environment?.name ?? 'no environment'}
                  </span>
                </p>
              </div>
              <p className="w-40 text-xs text-fg-subtle">
                {MONITOR_TYPE_INFO[monitor.type].label} · {formatInterval(monitor.intervalSeconds)}
              </p>
              <p className="w-24 text-right text-xs text-fg-subtle">
                {monitor.lastRunAt ? formatRelative(monitor.lastRunAt) : '—'}
              </p>
              <div className="w-24 text-right">
                <HealthBadge health={monitor.health} paused={!monitor.enabled} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
