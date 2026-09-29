import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Plus, Search, Waypoints } from 'lucide-react';
import {
  hasPermission,
  HTTP_METHODS,
  MAX_ENDPOINTS_PER_PROJECT,
  type EndpointView,
} from '@tracelayer/shared';
import { EmptyState, LoadError } from '@/components/EmptyState';
import { MethodBadge } from '@/components/endpoints/MethodBadge';
import { SelectField } from '@/components/SelectField';
import { useProject } from '@/hooks/useProject';
import { useQuery } from '@/hooks/useQuery';
import { fetchEndpoints } from '@/services/endpoint.service';
import { fetchEnvironments } from '@/services/project.service';
import { useCurrentWorkspace } from '@/stores/workspace.store';

function matches(endpoint: EndpointView, search: string, method: string, tag: string): boolean {
  const text = search.trim().toLowerCase();
  return (
    (!method || endpoint.method === method) &&
    (!tag || endpoint.tags.includes(tag)) &&
    (!text ||
      endpoint.name.toLowerCase().includes(text) ||
      endpoint.url.toLowerCase().includes(text))
  );
}

export function ProjectEndpointsPage() {
  const { project } = useProject();
  const workspace = useCurrentWorkspace();
  const canManage = hasPermission(workspace.role, 'monitoring.manage');
  const [search, setSearch] = useState('');
  const [method, setMethod] = useState('');
  const [tag, setTag] = useState('');

  const {
    data: endpoints,
    error,
    reload,
  } = useQuery(`endpoints:${project.id}`, () => fetchEndpoints(project.id));
  const { data: environments } = useQuery(`environments:${project.id}`, () =>
    fetchEnvironments(project.id),
  );
  const environmentNames = new Map(environments?.map((e) => [e.id, e.name]));
  const allTags = useMemo(
    () => [...new Set(endpoints?.flatMap((e) => e.tags))].sort(),
    [endpoints],
  );
  const visible = endpoints?.filter((e) => matches(e, search, method, tag)) ?? [];
  const atLimit = (endpoints?.length ?? 0) >= MAX_ENDPOINTS_PER_PROJECT;

  const newButton = canManage && !atLimit && (
    <Link
      to="new"
      className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:opacity-90"
    >
      <Plus className="size-4" aria-hidden="true" />
      New endpoint
    </Link>
  );

  if (error && !endpoints) return <LoadError message={error.message} onRetry={reload} />;
  if (!endpoints) {
    return (
      <div
        aria-hidden="true"
        className="h-48 animate-pulse rounded-lg border border-line bg-surface"
      />
    );
  }
  if (endpoints.length === 0) {
    return (
      <EmptyState icon={Waypoints} title="No endpoints yet" action={newButton}>
        {canManage
          ? 'Save the API requests you want to test and monitor, with their headers, body and authentication.'
          : 'Endpoints added by your team will appear here.'}
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-48 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden="true"
          />
          <label htmlFor="endpoint-search" className="sr-only">
            Search endpoints
          </label>
          <input
            id="endpoint-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or URL"
            className="w-full rounded-md border border-line bg-surface py-2 pr-3 pl-8 text-sm"
          />
        </div>
        <SelectField
          label="Method"
          hideLabel
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          options={[
            { value: '', label: 'All methods' },
            ...HTTP_METHODS.map((m) => ({ value: m, label: m })),
          ]}
        />
        {allTags.length > 0 && (
          <SelectField
            label="Tag"
            hideLabel
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            options={[
              { value: '', label: 'All tags' },
              ...allTags.map((t) => ({ value: t, label: t })),
            ]}
          />
        )}
        {newButton}
      </div>
      {atLimit && canManage && (
        <p className="text-sm text-fg-muted">
          This project has reached the limit of {MAX_ENDPOINTS_PER_PROJECT} endpoints.
        </p>
      )}

      {visible.length === 0 ? (
        <p
          role="status"
          className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-fg-muted"
        >
          No endpoints match these filters.
        </p>
      ) : (
        <ul
          aria-label="Endpoints"
          className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface"
        >
          {visible.map((endpoint) => (
            <li key={endpoint.id}>
              <Link
                to={endpoint.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-2"
              >
                <MethodBadge method={endpoint.method} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{endpoint.name}</p>
                  <p className="truncate font-mono text-xs text-fg-muted">{endpoint.url}</p>
                </div>
                {endpoint.tags.length > 0 && (
                  <ul aria-label="Tags" className="flex flex-wrap gap-1">
                    {endpoint.tags.map((t) => (
                      <li
                        key={t}
                        className="rounded border border-line px-1.5 py-0.5 text-[11px] text-fg-muted"
                      >
                        {t}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="w-28 truncate text-right text-xs text-fg-subtle">
                  {endpoint.environmentId
                    ? environmentNames.get(endpoint.environmentId)
                    : 'No environment'}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
