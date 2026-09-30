import { IncidentsBrowser } from '@/components/incidents/IncidentsBrowser';
import { useCurrentWorkspace } from '@/stores/workspace.store';

/** Every incident in the workspace, across projects (sidebar: Incidents). */
export function IncidentsPage() {
  const workspace = useCurrentWorkspace();
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:py-10">
      <h1 className="text-xl font-semibold tracking-tight">Incidents</h1>
      <p className="mt-1 mb-6 text-sm text-fg-muted">
        Incidents across every project in {workspace.name}. Open one to acknowledge, assign or
        resolve it.
      </p>
      {/* Keyed by workspace so switching workspaces starts from a clean slate. */}
      <IncidentsBrowser key={workspace.id} scope={{ workspaceId: workspace.id }} />
    </div>
  );
}
