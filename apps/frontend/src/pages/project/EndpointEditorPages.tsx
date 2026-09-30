import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ChevronLeft, SearchX, Trash2 } from 'lucide-react';
import { hasPermission, type EndpointRequest, type ExecutionResult } from '@tracelayer/shared';
import { ResponseViewer } from '@/components/requests/ResponseViewer';
import { LazyAnalyticsView as AnalyticsView } from '@/components/analytics/LazyAnalyticsView';
import { executeRequest } from '@/services/request.service';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState, LoadError } from '@/components/EmptyState';
import { EndpointForm } from '@/components/endpoints/EndpointForm';
import { EMPTY_ENDPOINT } from '@/components/endpoints/endpoint-form-values';
import { MethodBadge } from '@/components/endpoints/MethodBadge';
import { useProject } from '@/hooks/useProject';
import { useQuery } from '@/hooks/useQuery';
import {
  createEndpoint,
  deleteEndpoint,
  fetchEndpoint,
  updateEndpoint,
} from '@/services/endpoint.service';
import { fetchEnvironments } from '@/services/project.service';
import { useCurrentWorkspace } from '@/stores/workspace.store';
import { formatDate } from '@/utils/format';

function BackLink() {
  return (
    <Link
      to=".."
      relative="path"
      className="mb-4 inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
    >
      <ChevronLeft className="size-3.5" aria-hidden="true" />
      All endpoints
    </Link>
  );
}

function useEnvironments(projectId: string) {
  return useQuery(`environments:${projectId}`, () => fetchEnvironments(projectId));
}

/** Sends requests from the editor and keeps the latest result to show below it. */
function useRequestRunner(projectId: string, endpointId: string | null) {
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const send = async (request: EndpointRequest, environmentId: string | null) => {
    const { result: next } = await executeRequest({
      projectId,
      environmentId,
      endpointId,
      request,
    });
    setResult(next);
  };
  return { result, send };
}

function ResponsePanel({ result }: { result: ExecutionResult | null }) {
  return (
    <div className="mt-6">
      {result ? (
        <ResponseViewer result={result} />
      ) : (
        <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-fg-subtle">
          Send the request to see the response here.
        </p>
      )}
    </div>
  );
}

export function EndpointCreatePage() {
  const { project } = useProject();
  const navigate = useNavigate();
  const { data: environments, error, reload } = useEnvironments(project.id);
  const runner = useRequestRunner(project.id, null);

  if (error && !environments) return <LoadError message={error.message} onRetry={reload} />;
  if (!environments) return null;

  // Default to the project's production-like environment when there is one.
  const defaultEnvironment =
    environments.find((e) => e.name.toLowerCase() === 'production') ?? environments[0];

  return (
    <div>
      <BackLink />
      <h2 className="mb-4 text-base font-semibold">New endpoint</h2>
      <EndpointForm
        initialValues={{ ...EMPTY_ENDPOINT, environmentId: defaultEnvironment?.id ?? null }}
        environments={environments}
        submitLabel="Create endpoint"
        onSubmit={async (config) => {
          const created = await createEndpoint(project.id, config);
          navigate(`../${created.id}`, { relative: 'path', replace: true });
        }}
        onSend={runner.send}
      />
      <ResponsePanel result={runner.result} />
    </div>
  );
}

export function EndpointDetailPage() {
  const { project } = useProject();
  const { endpointId = '' } = useParams();
  const navigate = useNavigate();
  const workspace = useCurrentWorkspace();
  const canManage = hasPermission(workspace.role, 'monitoring.manage');
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState(false);

  const endpoint = useQuery(`endpoint:${endpointId}`, () => fetchEndpoint(endpointId));
  const environments = useEnvironments(project.id);
  const runner = useRequestRunner(project.id, endpointId);
  const error = endpoint.error ?? environments.error;

  if (endpoint.error?.code === 'NOT_FOUND') {
    return (
      <EmptyState
        icon={SearchX}
        title="Endpoint not found"
        action={
          <Link to=".." relative="path" className="text-sm font-medium text-accent hover:underline">
            Back to endpoints
          </Link>
        }
      >
        It may have been deleted.
      </EmptyState>
    );
  }
  if (error && (!endpoint.data || !environments.data)) {
    return (
      <LoadError
        message={error.message}
        onRetry={() => {
          endpoint.reload();
          environments.reload();
        }}
      />
    );
  }
  if (!endpoint.data || !environments.data) return null;
  const current = endpoint.data;

  return (
    <div>
      <BackLink />
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <MethodBadge method={current.method} aligned={false} />
        <h2 className="min-w-0 truncate text-base font-semibold">{current.name}</h2>
        <p className="text-xs text-fg-subtle">
          Updated {formatDate(current.updatedAt)}
          {current.createdBy && ` · created by ${current.createdBy.name}`}
        </p>
        {saved && (
          <p role="status" className="text-xs text-ok">
            Saved
          </p>
        )}
      </div>
      {!canManage && (
        <p className="mb-4 text-sm text-fg-muted">
          You can view this endpoint. Owners, admins and members can change it.
        </p>
      )}
      <EndpointForm
        // Remount after a save so the form's "unchanged" baseline is the saved version.
        key={current.updatedAt}
        initialValues={current}
        environments={environments.data}
        readOnly={!canManage}
        submitLabel="Save changes"
        onSubmit={async (config) => {
          const updated = await updateEndpoint(current.id, config);
          endpoint.setData(() => updated);
          setSaved(true);
        }}
        footer={
          <Button variant="ghost" onClick={() => setDeleting(true)} className="text-fail">
            <Trash2 className="size-4" aria-hidden="true" />
            Delete endpoint
          </Button>
        }
        // Running a request uses the environment's secrets: not for read-only viewers.
        onSend={canManage ? runner.send : undefined}
      />
      {canManage && <ResponsePanel result={runner.result} />}

      <section aria-labelledby="endpoint-analytics-heading" className="mt-10">
        <h2 id="endpoint-analytics-heading" className="mb-3 text-base font-semibold">
          Analytics
        </h2>
        <AnalyticsView
          scope={{ projectId: project.id, endpointId: current.id }}
          createMonitorHref="../../monitors/new"
        />
      </section>

      {deleting && (
        <ConfirmDialog
          title={`Delete ${current.name}?`}
          confirmLabel="Delete endpoint"
          destructive
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await deleteEndpoint(current.id);
            navigate('..', { relative: 'path', replace: true });
          }}
        >
          The endpoint and its saved request configuration will be deleted.
        </ConfirmDialog>
      )}
    </div>
  );
}
