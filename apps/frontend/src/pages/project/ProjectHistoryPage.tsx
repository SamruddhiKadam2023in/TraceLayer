import { useSearchParams } from 'react-router';
import { ArrowDown, ArrowUp, History } from 'lucide-react';
import {
  HISTORY_STATUS_FILTERS,
  HTTP_METHODS,
  type HistoryEntry,
  type HistoryQuery,
  type HttpMethod,
} from '@tracelayer/shared';
import { Button } from '@/components/Button';
import { EmptyState, LoadError } from '@/components/EmptyState';
import { MethodBadge } from '@/components/endpoints/MethodBadge';
import { ERROR_LABELS, formatBytes, statusTone } from '@/components/requests/status';
import { SelectField } from '@/components/SelectField';
import { StatusBadge } from '@/components/StatusBadge';
import { useProject } from '@/hooks/useProject';
import { useQuery } from '@/hooks/useQuery';
import { fetchEndpoints } from '@/services/endpoint.service';
import { fetchEnvironments } from '@/services/project.service';
import { fetchHistory } from '@/services/request.service';
import { formatLatency } from '@/utils/format';

const PAGE_SIZE = 25;
type SortField = 'createdAt' | 'durationMs' | 'status';

/** Filters live in the URL, so a filtered view survives reloads and can be shared. */
function useHistoryQuery(projectId: string) {
  const [params, setParams] = useSearchParams();
  const get = (key: string) => params.get(key) ?? '';
  const sort = (get('sort') || 'createdAt') as SortField;
  const order: 'asc' | 'desc' = get('order') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number(get('page')) || 1);

  const dateParam = (key: string, endOfDay: boolean) => {
    const day = get(key);
    return day
      ? new Date(`${day}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`).toISOString()
      : undefined;
  };

  const query: HistoryQuery = {
    projectId,
    page,
    pageSize: PAGE_SIZE,
    sort,
    order,
    ...(get('method') ? { method: get('method') as HttpMethod } : {}),
    ...(get('status') ? { status: get('status') as HistoryQuery['status'] } : {}),
    ...(get('endpointId') ? { endpointId: get('endpointId') } : {}),
    ...(get('environmentId') ? { environmentId: get('environmentId') } : {}),
    ...(get('search') ? { search: get('search') } : {}),
    ...(get('from') ? { from: dateParam('from', false) } : {}),
    ...(get('to') ? { to: dateParam('to', true) } : {}),
  };

  /** Any filter change goes back to page 1. */
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

  return {
    query,
    get,
    sort,
    order,
    page,
    update,
    hasFilters: [...params.keys()].some((k) => !['sort', 'order', 'page'].includes(k)),
  };
}

function SortHeader({
  field,
  label,
  sort,
  order,
  onSort,
  className = '',
}: {
  field: SortField;
  label: string;
  sort: SortField;
  order: 'asc' | 'desc';
  onSort: (field: SortField) => void;
  className?: string;
}) {
  const active = sort === field;
  return (
    <th
      scope="col"
      aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`px-3 py-2 font-medium ${className}`}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className="inline-flex items-center gap-1 hover:text-fg"
      >
        {label}
        {active &&
          (order === 'asc' ? (
            <ArrowUp className="size-3" aria-hidden="true" />
          ) : (
            <ArrowDown className="size-3" aria-hidden="true" />
          ))}
      </button>
    </th>
  );
}

function StatusCell({ entry }: { entry: HistoryEntry }) {
  if (entry.status !== null) {
    return <StatusBadge tone={statusTone(entry.status)} label={String(entry.status)} />;
  }
  return (
    <span title={entry.errorMessage ?? undefined}>
      <StatusBadge tone="failing" label={ERROR_LABELS[entry.errorCode ?? ''] ?? 'Error'} />
    </span>
  );
}

export function ProjectHistoryPage() {
  const { project } = useProject();
  const history = useHistoryQuery(project.id);
  const { data, error, loading, reload } = useQuery(
    `history:${JSON.stringify(history.query)}`,
    () => fetchHistory(history.query),
  );
  const { data: endpoints } = useQuery(`endpoints:${project.id}`, () => fetchEndpoints(project.id));
  const { data: environments } = useQuery(`environments:${project.id}`, () =>
    fetchEnvironments(project.id),
  );

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const onSort = (field: SortField) =>
    history.update({
      sort: field,
      order: history.sort === field && history.order === 'desc' ? 'asc' : 'desc',
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3" role="search" aria-label="Filter history">
        <div className="min-w-44 flex-1">
          <label htmlFor="history-search" className="sr-only">
            Search URL
          </label>
          <input
            id="history-search"
            type="search"
            placeholder="Search URL"
            defaultValue={history.get('search')}
            onChange={(e) => history.update({ search: e.target.value })}
            className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
          />
        </div>
        <SelectField
          label="Method"
          hideLabel
          value={history.get('method')}
          onChange={(e) => history.update({ method: e.target.value })}
          options={[
            { value: '', label: 'All methods' },
            ...HTTP_METHODS.map((m) => ({ value: m, label: m })),
          ]}
        />
        <SelectField
          label="Status"
          hideLabel
          value={history.get('status')}
          onChange={(e) => history.update({ status: e.target.value })}
          options={[
            { value: '', label: 'All statuses' },
            ...HISTORY_STATUS_FILTERS.map((s) => ({
              value: s,
              label: s === 'error' ? 'Failed' : s,
            })),
          ]}
        />
        <SelectField
          label="Endpoint"
          hideLabel
          value={history.get('endpointId')}
          onChange={(e) => history.update({ endpointId: e.target.value })}
          options={[
            { value: '', label: 'All endpoints' },
            ...(endpoints ?? []).map((e) => ({ value: e.id, label: e.name })),
          ]}
        />
        <SelectField
          label="Environment"
          hideLabel
          value={history.get('environmentId')}
          onChange={(e) => history.update({ environmentId: e.target.value })}
          options={[
            { value: '', label: 'All environments' },
            ...(environments ?? []).map((e) => ({ value: e.id, label: e.name })),
          ]}
        />
        <div className="flex items-center gap-1.5 text-sm">
          <label htmlFor="history-from" className="text-xs text-fg-muted">
            From
          </label>
          <input
            id="history-from"
            type="date"
            value={history.get('from')}
            onChange={(e) => history.update({ from: e.target.value })}
            className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs"
          />
          <label htmlFor="history-to" className="text-xs text-fg-muted">
            to
          </label>
          <input
            id="history-to"
            type="date"
            value={history.get('to')}
            onChange={(e) => history.update({ to: e.target.value })}
            className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs"
          />
        </div>
      </div>

      {error && !data ? (
        <LoadError message={error.message} onRetry={reload} />
      ) : !data ? (
        <div
          aria-hidden="true"
          className="h-64 animate-pulse rounded-lg border border-line bg-surface"
        />
      ) : data.total === 0 ? (
        <EmptyState
          icon={History}
          title={history.hasFilters ? 'No matching requests' : 'No requests yet'}
        >
          {history.hasFilters
            ? 'Try removing some filters.'
            : 'Requests sent from an endpoint appear here, with their status, timing and size.'}
        </EmptyState>
      ) : (
        <>
          <div
            className="overflow-x-auto rounded-lg border border-line bg-surface"
            aria-busy={loading}
          >
            <table className="w-full min-w-3xl text-sm">
              <caption className="sr-only">Request history</caption>
              <thead className="border-b border-line text-left text-xs text-fg-muted">
                <tr>
                  <SortHeader
                    field="createdAt"
                    label="Time"
                    sort={history.sort}
                    order={history.order}
                    onSort={onSort}
                  />
                  <th scope="col" className="px-3 py-2 font-medium">
                    Request
                  </th>
                  <SortHeader
                    field="status"
                    label="Status"
                    sort={history.sort}
                    order={history.order}
                    onSort={onSort}
                  />
                  <SortHeader
                    field="durationMs"
                    label="Duration"
                    sort={history.sort}
                    order={history.order}
                    onSort={onSort}
                    className="text-right"
                  />
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Size
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Environment
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    By
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.items.map((entry) => (
                  <tr key={entry.id} data-testid="history-row">
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap text-fg-muted">
                      {new Date(entry.createdAt).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </td>
                    <td className="max-w-0 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <MethodBadge method={entry.method} />
                        <div className="min-w-0">
                          {entry.endpoint && (
                            <p className="truncate text-xs font-medium">{entry.endpoint.name}</p>
                          )}
                          <p className="truncate font-mono text-xs text-fg-muted" title={entry.url}>
                            {entry.url}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <StatusCell entry={entry} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                      {formatLatency(entry.durationMs)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-fg-muted">
                      {entry.sizeBytes === null ? '—' : formatBytes(entry.sizeBytes)}
                    </td>
                    <td className="px-3 py-2 text-xs text-fg-muted">
                      {entry.environment?.name ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-fg-muted">{entry.user?.name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <nav aria-label="Pagination" className="flex items-center justify-between gap-3 text-sm">
            <p className="text-fg-muted">
              {data.total} {data.total === 1 ? 'request' : 'requests'} · page {data.page} of{' '}
              {totalPages}
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                disabled={history.page <= 1}
                onClick={() => history.update({ page: String(history.page - 1) }, true)}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                disabled={history.page >= totalPages}
                onClick={() => history.update({ page: String(history.page + 1) }, true)}
              >
                Next
              </Button>
            </div>
          </nav>
        </>
      )}
    </div>
  );
}
