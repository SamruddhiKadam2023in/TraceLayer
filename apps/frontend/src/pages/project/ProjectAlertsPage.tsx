import { useState } from 'react';
import { Link } from 'react-router';
import { BellOff } from 'lucide-react';
import { SeverityBadge } from '@/components/alerts/AlertBadges';
import { EmptyState, LoadError } from '@/components/EmptyState';
import { StatusBadge } from '@/components/StatusBadge';
import { useProject } from '@/hooks/useProject';
import { useQuery } from '@/hooks/useQuery';
import { fetchFiredAlerts } from '@/services/alert.service';
import { formatDuration, formatRelative } from '@/utils/format';

/** Fired alerts of the project: open ones first, then recent history. */
export function ProjectAlertsPage() {
  const { project } = useProject();
  // Durations of open alerts are measured against page load time.
  const [now] = useState(Date.now);
  const {
    data: alerts,
    error,
    reload,
  } = useQuery(`fired:${project.id}`, () => fetchFiredAlerts(project.id));

  if (error && !alerts) return <LoadError message={error.message} onRetry={reload} />;
  if (!alerts)
    return (
      <div
        aria-hidden="true"
        className="h-40 animate-pulse rounded-lg border border-line bg-surface"
      />
    );
  if (alerts.length === 0) {
    return (
      <EmptyState icon={BellOff} title="No alerts yet">
        Alerts appear here when a monitor&apos;s alert rule is breached. Add rules on a
        monitor&apos;s page.
      </EmptyState>
    );
  }

  const firing = alerts.filter((a) => a.status === 'FIRING').length;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-muted">
        {firing === 0
          ? 'Nothing is firing right now.'
          : `${firing} alert${firing > 1 ? 's' : ''} firing.`}
      </p>
      <ul
        aria-label="Alerts"
        className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface"
      >
        {alerts.map((alert) => {
          const end = alert.resolvedAt ? Date.parse(alert.resolvedAt) : now;
          const seconds = Math.max(0, Math.round((end - Date.parse(alert.firedAt)) / 1000));
          return (
            <li
              key={alert.id}
              data-testid="alert-row"
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
            >
              {alert.status === 'FIRING' ? (
                <StatusBadge tone="failing" label="Firing" />
              ) : (
                <StatusBadge tone="healthy" label="Resolved" />
              )}
              <SeverityBadge severity={alert.severity} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{alert.message}</p>
                <p className="text-xs text-fg-subtle">
                  <Link
                    to={`../monitors/${alert.monitor.id}`}
                    relative="path"
                    className="hover:underline"
                  >
                    {alert.monitor.name}
                  </Link>
                  {alert.rule ? ` · ${alert.rule.name}` : ' · deleted rule'}
                  {alert.incident && (
                    <>
                      {' · '}
                      <Link
                        to={`../incidents/${alert.incident.id}`}
                        relative="path"
                        className="hover:underline"
                      >
                        Incident #{alert.incident.number}
                      </Link>
                    </>
                  )}
                </p>
              </div>
              <p className="text-right text-xs text-fg-subtle" title={alert.firedAt}>
                fired {formatRelative(alert.firedAt)}
                <br />
                {alert.status === 'FIRING'
                  ? `for ${formatDuration(seconds)}`
                  : `lasted ${formatDuration(seconds)}`}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
