import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ChevronLeft, Pause, Pencil, Play, SearchX, Trash2, Zap } from 'lucide-react';
import {
  hasPermission,
  MONITOR_TYPE_INFO,
  type MonitorRunView,
  type MonitorView,
} from '@tracelayer/shared';
import { ErrorAlert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState, LoadError } from '@/components/EmptyState';
import { MethodBadge } from '@/components/endpoints/MethodBadge';
import { MonitorForm } from '@/components/monitors/MonitorForm';
import { toFormValues } from '@/components/monitors/monitor-form-schema';
import { HealthBadge } from '@/components/monitors/HealthBadge';
import { AlertRulesSection } from '@/components/alerts/AlertRulesSection';
import { LazyAnalyticsView as AnalyticsView } from '@/components/analytics/LazyAnalyticsView';
import { formatBytes } from '@/components/requests/status';
import { StatusBadge } from '@/components/StatusBadge';
import { useProject } from '@/hooks/useProject';
import { useQuery } from '@/hooks/useQuery';
import { fetchEndpoints } from '@/services/endpoint.service';
import {
  createMonitor,
  deleteMonitor,
  fetchMonitor,
  fetchMonitorRuns,
  runMonitorNow,
  updateMonitor,
} from '@/services/monitor.service';
import { fetchEnvironments } from '@/services/project.service';
import { useCurrentWorkspace } from '@/stores/workspace.store';
import { toApiError } from '@/utils/api-error';
import { formatInterval, formatLatency, formatRelative } from '@/utils/format';

/** Runs refresh on their own while the page is open (live updates arrive in Phase 12). */
export const RUNS_REFRESH_MS = 15_000;
/** After "Run now", poll quickly until the new run shows up, for at most this long. */
const RUN_NOW_POLL_MS = 2_000;
const RUN_NOW_WAIT_MS = 45_000;

function BackLink() {
  return (
    <Link
      to=".."
      relative="path"
      className="mb-4 inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
    >
      <ChevronLeft className="size-3.5" aria-hidden="true" />
      All monitors
    </Link>
  );
}

function useFormData(projectId: string) {
  const endpoints = useQuery(`endpoints:${projectId}`, () => fetchEndpoints(projectId));
  const environments = useQuery(`environments:${projectId}`, () => fetchEnvironments(projectId));
  const error = endpoints.error ?? environments.error;
  return { endpoints: endpoints.data, environments: environments.data, error };
}

export function MonitorCreatePage() {
  const { project } = useProject();
  const navigate = useNavigate();
  const { endpoints, environments, error } = useFormData(project.id);

  if (error && (!endpoints || !environments))
    return <LoadError message={error.message} onRetry={() => navigate(0)} />;
  if (!endpoints || !environments) return null;
  if (endpoints.length === 0) {
    return (
      <EmptyState
        icon={Zap}
        title="Add an endpoint first"
        action={
          <Link
            to="../../endpoints/new"
            relative="path"
            className="text-sm font-medium text-accent hover:underline"
          >
            New endpoint
          </Link>
        }
      >
        A monitor checks one of the project’s endpoints on a schedule.
      </EmptyState>
    );
  }

  const production =
    environments.find((e) => e.name.toLowerCase() === 'production') ?? environments[0];
  return (
    <div>
      <BackLink />
      <h2 className="mb-4 text-base font-semibold">New monitor</h2>
      <MonitorForm
        initialValues={toFormValues({
          name: '',
          endpointId: '',
          environmentId: production?.id ?? '',
          type: 'AVAILABILITY',
          intervalSeconds: 300,
          timeoutMs: 10_000,
          expectedStatus: null,
          latencyThresholdMs: null,
          assertions: [],
          enabled: true,
        })}
        endpoints={endpoints}
        environments={environments}
        submitLabel="Create monitor"
        onSubmit={async (config) => {
          const created = await createMonitor(project.id, config);
          navigate(`../${created.id}`, { relative: 'path', replace: true });
        }}
      />
    </div>
  );
}

function RunsTable({ runs }: { runs: MonitorRunView[] }) {
  if (runs.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-fg-subtle">
        No runs yet. The first check runs as soon as the monitor is scheduled, or press Run now.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full min-w-xl text-sm">
        <caption className="sr-only">Recent runs</caption>
        <thead className="border-b border-line text-left text-xs text-fg-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              When
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Result
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Status
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Duration
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Size
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Details
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {runs.map((run) => (
            <tr key={run.id} data-testid="monitor-run">
              <td
                className="px-3 py-2 font-mono text-xs whitespace-nowrap text-fg-muted"
                title={run.startedAt}
              >
                {formatRelative(run.startedAt)}
              </td>
              <td className="px-3 py-2">
                <StatusBadge
                  tone={run.success ? 'healthy' : 'failing'}
                  label={run.success ? 'Pass' : 'Fail'}
                />
              </td>
              <td className="px-3 py-2 font-mono text-xs">{run.statusCode ?? '—'}</td>
              <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                {run.durationMs === null ? '—' : formatLatency(run.durationMs)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-fg-muted">
                {run.sizeBytes === null ? '—' : formatBytes(run.sizeBytes)}
              </td>
              <td className="max-w-0 px-3 py-2 text-xs text-fg-muted">
                {run.failureReason && (
                  <p className="truncate" title={run.failureMessage ?? undefined}>
                    <span className="font-mono">{run.failureReason}</span>
                    {run.failureMessage && ` · ${run.failureMessage}`}
                  </p>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Summary({ monitor }: { monitor: MonitorView }) {
  const rows: [string, ReactNode][] = [
    ['Type', MONITOR_TYPE_INFO[monitor.type].label],
    [
      'Endpoint',
      <span key="e" className="flex items-center gap-1">
        <MethodBadge method={monitor.endpoint.method} /> {monitor.endpoint.name}
      </span>,
    ],
    ['Environment', monitor.environment?.name ?? <span className="text-fail">None (deleted)</span>],
    ['Schedule', formatInterval(monitor.intervalSeconds)],
    ['Timeout', formatLatency(monitor.timeoutMs)],
  ];
  if (monitor.type !== 'AVAILABILITY')
    rows.push(['Expected status', monitor.expectedStatus ?? 'Endpoint’s, or any 2xx']);
  if (monitor.latencyThresholdMs !== null)
    rows.push(['Latency threshold', formatLatency(monitor.latencyThresholdMs)]);
  if (monitor.assertions.length > 0) {
    rows.push([
      'Checks',
      <ul key="a" className="font-mono text-xs">
        {monitor.assertions.map((a, i) => (
          <li key={i}>
            {a.path} {a.operator} {a.value === undefined ? '' : JSON.stringify(a.value)}
          </li>
        ))}
      </ul>,
    ]);
  }
  return (
    <dl className="grid gap-x-6 gap-y-3 rounded-lg border border-line bg-surface p-4 text-sm sm:grid-cols-3">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-fg-subtle">{label}</dt>
          <dd className="mt-0.5">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function MonitorDetailPage() {
  const { project } = useProject();
  const { monitorId = '' } = useParams();
  const navigate = useNavigate();
  const workspace = useCurrentWorkspace();
  const canManage = hasPermission(workspace.role, 'monitoring.manage');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);

  const monitor = useQuery(`monitor:${monitorId}`, () => fetchMonitor(monitorId));
  const runs = useQuery(`monitor-runs:${monitorId}`, () => fetchMonitorRuns(monitorId));
  const formData = useFormData(project.id);
  const reloadRuns = runs.reload;
  const reloadMonitor = monitor.reload;

  // After "Run now" we are waiting until a run at least as new as the click shows up.
  const latestRunAt = runs.data?.[0]?.startedAt;
  const waiting =
    waitingSince !== null &&
    !(latestRunAt !== undefined && Date.parse(latestRunAt) >= waitingSince - 1000);

  // Background refresh; faster while waiting, giving up on the wait after a limit.
  useEffect(() => {
    const timer = window.setInterval(
      () => {
        reloadRuns();
        reloadMonitor();
        if (waitingSince !== null && Date.now() - waitingSince > RUN_NOW_WAIT_MS) {
          setWaitingSince(null);
        }
      },
      waiting ? RUN_NOW_POLL_MS : RUNS_REFRESH_MS,
    );
    return () => window.clearInterval(timer);
  }, [waiting, waitingSince, reloadRuns, reloadMonitor]);

  if (monitor.error?.code === 'NOT_FOUND') {
    return (
      <EmptyState
        icon={SearchX}
        title="Monitor not found"
        action={
          <Link to=".." relative="path" className="text-sm font-medium text-accent hover:underline">
            Back to monitors
          </Link>
        }
      >
        It may have been deleted.
      </EmptyState>
    );
  }
  if (monitor.error && !monitor.data)
    return <LoadError message={monitor.error.message} onRetry={monitor.reload} />;
  if (!monitor.data) return null;
  const current = monitor.data;

  const act = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(toApiError(err).message);
    }
  };

  if (editing && formData.endpoints && formData.environments) {
    return (
      <div>
        <h2 className="mb-4 text-base font-semibold">Edit {current.name}</h2>
        <MonitorForm
          initialValues={toFormValues(current)}
          endpoints={formData.endpoints}
          environments={formData.environments}
          submitLabel="Save changes"
          onCancel={() => setEditing(false)}
          onSubmit={async (config) => {
            const updated = await updateMonitor(current.id, config);
            monitor.setData(() => updated);
            setEditing(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <BackLink />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="min-w-0 truncate text-base font-semibold">{current.name}</h2>
          <HealthBadge health={current.health} paused={!current.enabled} />
          {current.consecutiveFailures > 1 && (
            <span className="text-xs text-fail">
              {current.consecutiveFailures} failures in a row
            </span>
          )}
          {canManage && (
            <div className="ml-auto flex flex-wrap gap-2">
              <Button
                variant="secondary"
                loading={waiting}
                onClick={() =>
                  act(async () => {
                    await runMonitorNow(current.id);
                    setWaitingSince(Date.now());
                  })
                }
              >
                <Zap className="size-4" aria-hidden="true" />
                {waiting ? 'Running…' : 'Run now'}
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  act(async () => {
                    const updated = await updateMonitor(current.id, { enabled: !current.enabled });
                    monitor.setData(() => updated);
                  })
                }
              >
                {current.enabled ? (
                  <Pause className="size-4" aria-hidden="true" />
                ) : (
                  <Play className="size-4" aria-hidden="true" />
                )}
                {current.enabled ? 'Pause' : 'Resume'}
              </Button>
              <Button variant="secondary" onClick={() => setEditing(true)}>
                <Pencil className="size-4" aria-hidden="true" />
                Edit
              </Button>
              <Button variant="ghost" className="text-fail" onClick={() => setDeleting(true)}>
                <Trash2 className="size-4" aria-hidden="true" />
                Delete
              </Button>
            </div>
          )}
        </div>
      </div>

      {actionError && <ErrorAlert>{actionError}</ErrorAlert>}
      <Summary monitor={current} />
      <AlertRulesSection monitorId={current.id} workspaceId={workspace.id} canManage={canManage} />
      <AnalyticsView
        scope={{ projectId: project.id, monitorId: current.id }}
        showMonitors={false}
      />

      <section aria-labelledby="runs-heading" className="flex flex-col gap-2">
        <h3 id="runs-heading" className="text-sm font-semibold">
          Recent runs
        </h3>
        {runs.error && !runs.data ? (
          <LoadError message={runs.error.message} onRetry={runs.reload} />
        ) : runs.data ? (
          <RunsTable runs={runs.data} />
        ) : null}
      </section>

      {deleting && (
        <ConfirmDialog
          title={`Delete ${current.name}?`}
          confirmLabel="Delete monitor"
          destructive
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await deleteMonitor(current.id);
            navigate('..', { relative: 'path', replace: true });
          }}
        >
          The monitor stops running and its run history is deleted.
        </ConfirmDialog>
      )}
    </div>
  );
}
