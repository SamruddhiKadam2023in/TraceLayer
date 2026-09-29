import { useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router';
import { ChevronRight, SearchX } from 'lucide-react';
import { EmptyState, LoadError } from '@/components/EmptyState';
import { FullPageLoader } from '@/components/FullPageLoader';
import type { ProjectContext } from '@/hooks/useProject';
import { useQuery } from '@/hooks/useQuery';
import { fetchProject } from '@/services/project.service';
import { useWorkspaceStore } from '@/stores/workspace.store';

// Tabs appear as their features are built: endpoints, monitors, analytics, incidents and
// dependencies join in their own phases.
const TABS = [
  { to: '', label: 'Overview', end: true },
  { to: 'environments', label: 'Environments', end: false },
  { to: 'settings', label: 'Settings', end: false },
];

export function ProjectLayout() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentId);
  const {
    data: project,
    error,
    reload,
    setData,
  } = useQuery(`project:${projectId}`, () => fetchProject(projectId));

  // Opening a project from another of the user's workspaces switches to that workspace.
  // Switching workspace while viewing a project leaves it for the new workspace's list.
  const syncedProjectId = useRef<string | null>(null);
  useEffect(() => {
    if (!project) return;
    if (syncedProjectId.current !== project.id) {
      syncedProjectId.current = project.id;
      if (project.workspaceId !== currentWorkspaceId) {
        useWorkspaceStore.getState().select(project.workspaceId);
      }
      return;
    }
    if (currentWorkspaceId !== project.workspaceId) navigate('/projects', { replace: true });
  }, [project, currentWorkspaceId, navigate]);

  if (error && !project) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-12">
        {error.code === 'NOT_FOUND' ? (
          <EmptyState
            icon={SearchX}
            title="Project not found"
            action={
              <Link to="/projects" className="text-sm font-medium text-accent hover:underline">
                Back to projects
              </Link>
            }
          >
            It may have been deleted, or you may not have access to it.
          </EmptyState>
        ) : (
          <LoadError message={error.message} onRetry={reload} />
        )}
      </div>
    );
  }
  if (!project) return <FullPageLoader label="Loading project" />;

  const context: ProjectContext = { project, setProject: (updated) => setData(() => updated) };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:py-10">
      <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1 text-xs text-fg-subtle">
        <Link to="/projects" className="hover:text-fg">
          Projects
        </Link>
        <ChevronRight className="size-3" aria-hidden="true" />
        <span className="truncate text-fg-muted" aria-current="page">
          {project.name}
        </span>
      </nav>
      <h1 className="truncate text-xl font-semibold tracking-tight">{project.name}</h1>
      {project.description && (
        <p className="mt-1 max-w-2xl text-sm text-fg-muted">{project.description}</p>
      )}

      <nav aria-label="Project" className="mt-6 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((tab) => (
          <NavLink
            key={tab.label}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              `-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors ${
                isActive
                  ? 'border-accent font-medium text-fg'
                  : 'border-transparent text-fg-muted hover:text-fg'
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <div className="pt-6">
        <Outlet context={context} />
      </div>
    </div>
  );
}
