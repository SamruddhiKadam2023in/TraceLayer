import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { LoadError } from '@/components/EmptyState';
import { useQuery } from '@/hooks/useQuery';
import { fetchIncidents } from '@/services/incident.service';
import { IncidentList } from './IncidentList';

const SHOWN = 5;

/** Dashboard panel (spec: "Active Incidents"): what is broken right now across the workspace. */
export function ActiveIncidentsPanel({ workspaceId }: { workspaceId: string }) {
  const [now] = useState(Date.now);
  const { data, error, reload } = useQuery(`active-incidents:${workspaceId}`, () =>
    fetchIncidents({ workspaceId, status: 'ACTIVE', pageSize: SHOWN }),
  );

  return (
    <section aria-labelledby="active-incidents" className="flex flex-col gap-2">
      <h2 id="active-incidents" className="text-sm font-semibold">
        Active incidents
        {data && data.total > 0 && (
          <span className="ml-2 rounded bg-fail-soft px-1.5 py-0.5 text-xs text-fail">
            {data.total}
          </span>
        )}
      </h2>
      {error && !data ? (
        <LoadError message={error.message} onRetry={reload} />
      ) : !data ? (
        <div
          aria-hidden="true"
          className="h-16 animate-pulse rounded-lg border border-line bg-surface"
        />
      ) : data.items.length === 0 ? (
        <p className="flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-fg-muted">
          <ShieldCheck className="size-4 text-ok" aria-hidden="true" />
          No active incidents. Everything monitored is behaving.
        </p>
      ) : (
        <>
          <IncidentList incidents={data.items} showProject now={now} />
          {data.total > SHOWN && (
            <p className="text-xs text-fg-subtle">
              Showing the {SHOWN} most recent of {data.total}. Each project&apos;s Incidents tab
              lists them all.
            </p>
          )}
        </>
      )}
    </section>
  );
}
