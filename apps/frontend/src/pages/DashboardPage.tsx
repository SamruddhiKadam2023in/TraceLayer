import { LazyAnalyticsView as AnalyticsView } from '@/components/analytics/LazyAnalyticsView';
import { ActiveIncidentsPanel } from '@/components/incidents/ActiveIncidentsPanel';
import { useCurrentWorkspace } from '@/stores/workspace.store';

/** The home page: uptime, latency, errors and monitor health across the whole workspace. */
export function DashboardPage() {
  const workspace = useCurrentWorkspace();
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:py-10">
      <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
      <p className="mt-1 mb-6 text-sm text-fg-muted">
        Reliability of every monitored API in {workspace.name}.
      </p>
      <div className="mb-8">
        <ActiveIncidentsPanel key={workspace.id} workspaceId={workspace.id} />
      </div>
      <AnalyticsView
        // Keyed by workspace so switching workspaces starts from a clean slate.
        key={workspace.id}
        scope={{ workspaceId: workspace.id }}
        createMonitorHref="/projects"
      />
    </div>
  );
}
