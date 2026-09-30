import { lazy, Suspense, useMemo, useState } from 'react';
import { hasPermission, type DependencyMapView } from '@tracelayer/shared';
import type { HostHealth } from '@/components/dependencies/DependencyMapEditor';
import { LoadError } from '@/components/EmptyState';
import { useProject } from '@/hooks/useProject';
import { useRealtimeRefresh } from '@/hooks/useRealtime';
import { useQuery } from '@/hooks/useQuery';
import { fetchDependencyMap } from '@/services/dependency.service';
import { useCurrentWorkspace } from '@/stores/workspace.store';

// React Flow is only needed on this page; loading it here keeps it out of the main bundle.
const DependencyMapEditor = lazy(() =>
  import('@/components/dependencies/DependencyMapEditor').then((m) => ({
    default: m.DependencyMapEditor,
  })),
);

function Loading() {
  return (
    <div role="status" className="h-[34rem] animate-pulse rounded-lg border border-line bg-surface">
      <span className="sr-only">Loading dependency map</span>
    </div>
  );
}

/** Health per host from the latest saved map; nodes get it live while being edited. */
function hostHealth(map: DependencyMapView | null): HostHealth {
  const hosts: HostHealth = new Map();
  for (const node of map?.nodes ?? []) {
    if (node.host && node.health) {
      hosts.set(node.host, { health: node.health, monitorCount: node.monitorCount });
    }
  }
  return hosts;
}

/** The project's API dependency map (spec §30). */
export function ProjectDependenciesPage() {
  const { project } = useProject();
  const workspace = useCurrentWorkspace();
  const canEdit = hasPermission(workspace.role, 'monitoring.manage');
  const loaded = useQuery(`dependencies:${project.id}`, () => fetchDependencyMap(project.id));
  // A new editing session starts after each save or reload; background refreshes only update
  // health, never the nodes someone is editing.
  const [session, setSession] = useState<{ map: DependencyMapView; n: number } | null>(null);
  useRealtimeRefresh(
    (m) => m.event === 'monitor.status_changed' && m.payload.projectId === project.id,
    loaded.reload,
    10_000,
  );
  const health = useMemo(() => hostHealth(loaded.data), [loaded.data]);

  if (loaded.error && !loaded.data) {
    return <LoadError message={loaded.error.message} onRetry={loaded.reload} />;
  }
  const map = session?.map ?? loaded.data;
  if (!map) return <Loading />;

  const restart = (next: DependencyMapView) => {
    loaded.setData(() => next);
    setSession((s) => ({ map: next, n: (s?.n ?? 0) + 1 }));
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-muted">
        How this project&apos;s services depend on each other. Arrows point from a caller to what it
        depends on. Nodes linked to a host show the health of the monitors calling it.
      </p>
      <Suspense fallback={<Loading />}>
        <DependencyMapEditor
          key={session?.n ?? 0}
          projectId={project.id}
          initial={map}
          health={health}
          canEdit={canEdit}
          onSaved={restart}
          onReload={async () => {
            try {
              restart(await fetchDependencyMap(project.id));
            } catch {
              loaded.reload();
            }
          }}
        />
      </Suspense>
    </div>
  );
}
