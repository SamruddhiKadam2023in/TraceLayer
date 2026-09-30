import { Link } from 'react-router';
import { UserRound } from 'lucide-react';
import type { IncidentSummary } from '@tracelayer/shared';
import { SeverityBadge } from '@/components/alerts/AlertBadges';
import { formatDuration, formatRelative } from '@/utils/format';
import { IncidentStatusBadge } from './IncidentStatusBadge';

interface IncidentListProps {
  incidents: IncidentSummary[];
  /** Show the project on each row (workspace-wide lists). */
  showProject?: boolean;
  /** For durations of incidents still open; captured once by the page. */
  now: number;
}

function incidentHref(incident: Pick<IncidentSummary, 'id' | 'projectId'>): string {
  return `/projects/${incident.projectId}/incidents/${incident.id}`;
}

export function IncidentList({ incidents, showProject = false, now }: IncidentListProps) {
  return (
    <ul
      aria-label="Incidents"
      className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface"
    >
      {incidents.map((incident) => {
        const end = incident.resolvedAt ? Date.parse(incident.resolvedAt) : now;
        const seconds = Math.max(0, Math.round((end - Date.parse(incident.detectedAt)) / 1000));
        return (
          <li key={incident.id} data-testid="incident-row">
            <Link
              to={incidentHref(incident)}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-2"
            >
              <span className="font-mono text-xs text-fg-subtle">#{incident.number}</span>
              <IncidentStatusBadge status={incident.status} />
              <SeverityBadge severity={incident.severity} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{incident.title}</p>
                <p className="text-xs text-fg-subtle">
                  {showProject && `${incident.project.name} · `}
                  {incident.monitor?.name ?? 'Deleted monitor'}
                  {incident.firingAlerts > 0 &&
                    ` · ${incident.firingAlerts} alert${incident.firingAlerts > 1 ? 's' : ''} firing`}
                </p>
              </div>
              <span className="flex items-center gap-1 text-xs text-fg-muted">
                <UserRound className="size-3.5" aria-hidden="true" />
                {incident.assignee?.name ?? 'Unassigned'}
              </span>
              <p className="text-right text-xs text-fg-subtle" title={incident.detectedAt}>
                detected {formatRelative(incident.detectedAt, now)}
                <br />
                {incident.resolvedAt
                  ? `lasted ${formatDuration(seconds)}`
                  : `open for ${formatDuration(seconds)}`}
              </p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
