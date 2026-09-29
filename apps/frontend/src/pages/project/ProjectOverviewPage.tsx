import { Link } from 'react-router';
import { AlertTriangle, Lock } from 'lucide-react';
import { hasPermission } from '@tracelayer/shared';
import { LoadError } from '@/components/EmptyState';
import { useQuery } from '@/hooks/useQuery';
import { useProject } from '@/hooks/useProject';
import { fetchEnvironments } from '@/services/project.service';
import { useCurrentWorkspace } from '@/stores/workspace.store';
import { formatDate, pluralize } from '@/utils/format';

/** The project dashboard: what exists today, from real data only. */
export function ProjectOverviewPage() {
  const { project } = useProject();
  const workspace = useCurrentWorkspace();
  const {
    data: environments,
    error,
    reload,
  } = useQuery(`environments:${project.id}`, () => fetchEnvironments(project.id));
  const canManage = hasPermission(workspace.role, 'projects.manage');
  const missingBaseUrl = environments?.filter((e) => !e.baseUrl) ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_16rem]">
      <section aria-labelledby="environments-heading" className="min-w-0">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="environments-heading" className="text-sm font-semibold">
            Environments
          </h2>
          <Link to="environments" className="text-xs font-medium text-accent hover:underline">
            {canManage ? 'Manage' : 'View all'}
          </Link>
        </div>

        {canManage && missingBaseUrl.length > 0 && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-warn">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>
              {pluralize(missingBaseUrl.length, 'environment')}{' '}
              {missingBaseUrl.length === 1 ? 'has' : 'have'} no base URL yet.{' '}
              <Link to="environments" className="font-medium underline">
                Set base URLs
              </Link>{' '}
              so requests know where to go.
            </p>
          </div>
        )}

        {error && !environments ? (
          <LoadError message={error.message} onRetry={reload} />
        ) : !environments ? (
          <div
            aria-hidden="true"
            className="h-40 animate-pulse rounded-lg border border-line bg-surface"
          />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {environments.map((env) => {
              const secrets = env.variables.filter((v) => v.isSecret).length;
              return (
                <li key={env.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                  <p className="w-32 shrink-0 text-sm font-medium">{env.name}</p>
                  <p className="min-w-0 flex-1 truncate font-mono text-xs">
                    {env.baseUrl ?? <span className="font-sans text-fg-subtle">No base URL</span>}
                  </p>
                  <p className="flex items-center gap-1 text-xs text-fg-subtle">
                    {pluralize(env.variables.length, 'variable')}
                    {secrets > 0 && (
                      <>
                        {' · '}
                        <Lock className="size-3" aria-hidden="true" />
                        {secrets} secret
                      </>
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="details-heading">
        <h2 id="details-heading" className="mb-3 text-sm font-semibold">
          Details
        </h2>
        <dl className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 text-sm">
          <div>
            <dt className="text-xs text-fg-subtle">Created</dt>
            <dd>
              {formatDate(project.createdAt)}
              {project.createdBy && (
                <span className="text-fg-muted"> by {project.createdBy.name}</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-fg-subtle">Last updated</dt>
            <dd>{formatDate(project.updatedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-subtle">Project ID</dt>
            <dd className="truncate font-mono text-xs" title={project.id}>
              {project.id}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
