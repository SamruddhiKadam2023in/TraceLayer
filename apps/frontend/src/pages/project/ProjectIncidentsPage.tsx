import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { ShieldCheck } from 'lucide-react';
import {
  INCIDENT_STATUS_FILTERS,
  INCIDENT_STATUS_LABELS,
  SEVERITIES,
  type IncidentListQuery,
  type IncidentStatus,
  type Severity,
} from '@tracelayer/shared';
import { Button } from '@/components/Button';
import { CheckboxField } from '@/components/CheckboxField';
import { EmptyState, LoadError } from '@/components/EmptyState';
import { IncidentList } from '@/components/incidents/IncidentList';
import { SelectField } from '@/components/SelectField';
import { useProject } from '@/hooks/useProject';
import { useRealtimeRefresh } from '@/hooks/useRealtime';
import { useQuery } from '@/hooks/useQuery';
import { fetchIncidents } from '@/services/incident.service';
import { useAuthStore } from '@/stores/auth.store';

const PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ALL', label: 'All statuses' },
  ...INCIDENT_STATUS_FILTERS.filter((s) => s !== 'ACTIVE').map((s) => ({
    value: s,
    label: INCIDENT_STATUS_LABELS[s as IncidentStatus],
  })),
];

/** Incidents of the project; filters live in the URL so a view can be shared. */
export function ProjectIncidentsPage() {
  const { project } = useProject();
  const userId = useAuthStore((s) => s.user?.id);
  const [params, setParams] = useSearchParams();
  const [now] = useState(Date.now);

  const status = params.get('status') ?? 'ACTIVE';
  const severity = params.get('severity') ?? '';
  const mine = params.get('assignee') === 'me';
  const page = Math.max(1, Number(params.get('page')) || 1);

  const query: IncidentListQuery = {
    projectId: project.id,
    page,
    pageSize: PAGE_SIZE,
    ...(status !== 'ALL' ? { status: status as IncidentListQuery['status'] } : {}),
    ...(severity ? { severity: severity as Severity } : {}),
    ...(mine && userId ? { assigneeId: userId } : {}),
  };
  const { data, error, reload } = useQuery(`incidents:${JSON.stringify(query)}`, () =>
    fetchIncidents(query),
  );
  useRealtimeRefresh(
    (m) =>
      (m.event === 'incident.created' || m.event === 'incident.updated') &&
      m.payload.projectId === project.id,
    reload,
  );

  const update = (changes: Record<string, string>, keepPage = false) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      if (!keepPage) next.delete('page');
      return next;
    });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filtered = status !== 'ACTIVE' || severity !== '' || mine;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44">
          <SelectField
            label="Status"
            value={status}
            options={STATUS_OPTIONS}
            onChange={(e) => update({ status: e.target.value === 'ACTIVE' ? '' : e.target.value })}
          />
        </div>
        <div className="w-40">
          <SelectField
            label="Severity"
            value={severity}
            options={[
              { value: '', label: 'Any severity' },
              ...SEVERITIES.map((s) => ({
                value: s,
                label: s.charAt(0) + s.slice(1).toLowerCase(),
              })),
            ]}
            onChange={(e) => update({ severity: e.target.value })}
          />
        </div>
        <div className="pb-2">
          <CheckboxField
            label="Assigned to me"
            checked={mine}
            onChange={(e) => update({ assignee: e.target.checked ? 'me' : '' })}
          />
        </div>
      </div>

      {error && !data ? (
        <LoadError message={error.message} onRetry={reload} />
      ) : !data ? (
        <div
          aria-hidden="true"
          className="h-40 animate-pulse rounded-lg border border-line bg-surface"
        />
      ) : data.items.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title={filtered ? 'No matching incidents' : 'No active incidents'}
        >
          {filtered
            ? 'Try other filters.'
            : 'Incidents open automatically when an alert rule fires, and resolve when the monitor recovers.'}
        </EmptyState>
      ) : (
        <>
          <IncidentList incidents={data.items} now={now} />
          {totalPages > 1 && (
            <nav
              aria-label="Pagination"
              className="flex items-center justify-between gap-3 text-sm"
            >
              <p className="text-fg-muted">
                {data.total} incidents · page {data.page} of {totalPages}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={page <= 1}
                  onClick={() => update({ page: String(page - 1) }, true)}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={page >= totalPages}
                  onClick={() => update({ page: String(page + 1) }, true)}
                >
                  Next
                </Button>
              </div>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
