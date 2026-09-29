import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { FolderKanban, Plus } from 'lucide-react';
import { hasPermission, MAX_PROJECTS_PER_WORKSPACE, type ProjectView } from '@tracelayer/shared';
import { Button } from '@/components/Button';
import { EmptyState, LoadError } from '@/components/EmptyState';
import { CreateProjectDialog } from '@/components/projects/CreateProjectDialog';
import { useQuery } from '@/hooks/useQuery';
import { fetchProjects } from '@/services/project.service';
import { useCurrentWorkspace } from '@/stores/workspace.store';
import { formatDate, pluralize } from '@/utils/format';

function ProjectCard({ project }: { project: ProjectView }) {
  return (
    <li>
      <Link
        to={`/projects/${project.id}`}
        className="flex h-full flex-col rounded-lg border border-line bg-surface p-4 transition-colors hover:border-fg-subtle"
      >
        <h2 className="truncate text-sm font-semibold">{project.name}</h2>
        <p className="mt-1 line-clamp-2 min-h-10 text-sm text-fg-muted">
          {project.description ?? <span className="text-fg-subtle">No description</span>}
        </p>
        <p className="mt-4 text-xs text-fg-subtle">
          {pluralize(project.environmentCount, 'environment')} · created{' '}
          {formatDate(project.createdAt)}
          {project.createdBy && ` by ${project.createdBy.name}`}
        </p>
      </Link>
    </li>
  );
}

function LoadingGrid() {
  return (
    <ul aria-hidden="true" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }, (_, i) => (
        <li key={i} className="h-32 animate-pulse rounded-lg border border-line bg-surface" />
      ))}
    </ul>
  );
}

export function ProjectsPage() {
  const workspace = useCurrentWorkspace();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const {
    data: projects,
    error,
    loading,
    reload,
  } = useQuery(`projects:${workspace.id}`, () => fetchProjects(workspace.id));
  const canManage = hasPermission(workspace.role, 'projects.manage');
  const atLimit = (projects?.length ?? 0) >= MAX_PROJECTS_PER_WORKSPACE;

  const newProjectButton = canManage && (
    <Button onClick={() => setCreating(true)} disabled={atLimit}>
      <Plus className="size-4" aria-hidden="true" />
      New project
    </Button>
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:py-12">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-fg-muted">
            APIs and services monitored in {workspace.name}.
          </p>
        </div>
        {projects && projects.length > 0 && newProjectButton}
      </div>

      {atLimit && canManage && (
        <p className="mb-4 text-sm text-fg-muted">
          This workspace has reached the limit of {MAX_PROJECTS_PER_WORKSPACE} projects.
        </p>
      )}

      {error && !projects ? (
        <LoadError message={error.message} onRetry={reload} />
      ) : loading && !projects ? (
        <LoadingGrid />
      ) : projects && projects.length === 0 ? (
        <EmptyState icon={FolderKanban} title="No projects yet" action={newProjectButton}>
          {canManage
            ? 'Create a project for each API you want to monitor.'
            : 'Owners and admins of this workspace can create projects.'}
        </EmptyState>
      ) : (
        <ul aria-label="Projects" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects?.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </ul>
      )}

      {creating && (
        <CreateProjectDialog
          workspaceId={workspace.id}
          onClose={() => setCreating(false)}
          onCreated={(project) => navigate(`/projects/${project.id}`)}
        />
      )}
    </div>
  );
}
