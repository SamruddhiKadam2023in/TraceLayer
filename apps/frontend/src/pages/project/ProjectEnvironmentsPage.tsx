import { useState, type ReactNode } from 'react';
import { Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  hasPermission,
  MAX_ENVIRONMENTS_PER_PROJECT,
  MAX_VARIABLES_PER_ENVIRONMENT,
  type EnvironmentVariableView,
  type EnvironmentView,
} from '@tracelayer/shared';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LoadError } from '@/components/EmptyState';
import { EnvironmentFormDialog } from '@/components/projects/EnvironmentFormDialog';
import { VariableFormDialog } from '@/components/projects/VariableFormDialog';
import { useQuery } from '@/hooks/useQuery';
import { useProject } from '@/hooks/useProject';
import { deleteEnvironment, deleteVariable, fetchEnvironments } from '@/services/project.service';
import { useCurrentWorkspace } from '@/stores/workspace.store';

type Dialog =
  | { kind: 'environment'; environment?: EnvironmentView }
  | { kind: 'delete-environment'; environment: EnvironmentView }
  | { kind: 'variable'; environment: EnvironmentView; variable?: EnvironmentVariableView }
  | { kind: 'delete-variable'; environment: EnvironmentView; variable: EnvironmentVariableView };

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-2 hover:text-fg"
    >
      {children}
    </button>
  );
}

export function ProjectEnvironmentsPage() {
  const { project } = useProject();
  const workspace = useCurrentWorkspace();
  const canManage = hasPermission(workspace.role, 'projects.manage');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const {
    data: environments,
    error,
    reload,
    setData,
  } = useQuery(`environments:${project.id}`, () => fetchEnvironments(project.id));

  const replaceEnvironment = (updated: EnvironmentView) =>
    setData((list) =>
      list.some((e) => e.id === updated.id)
        ? list.map((e) => (e.id === updated.id ? updated : e))
        : [...list, updated],
    );
  const updateVariables = (
    environmentId: string,
    update: (variables: EnvironmentVariableView[]) => EnvironmentVariableView[],
  ) =>
    setData((list) =>
      list.map((e) => (e.id === environmentId ? { ...e, variables: update(e.variables) } : e)),
    );
  const close = () => setDialog(null);

  if (error && !environments) return <LoadError message={error.message} onRetry={reload} />;
  if (!environments) {
    return (
      <div
        aria-hidden="true"
        className="h-48 animate-pulse rounded-lg border border-line bg-surface"
      />
    );
  }

  const atLimit = environments.length >= MAX_ENVIRONMENTS_PER_PROJECT;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">
          Each environment has its own base URL and variables. Secret values are encrypted and never
          shown again.
        </p>
        {canManage && (
          <Button
            variant="secondary"
            onClick={() => setDialog({ kind: 'environment' })}
            disabled={atLimit}
            title={
              atLimit
                ? `A project can have at most ${MAX_ENVIRONMENTS_PER_PROJECT} environments`
                : undefined
            }
          >
            <Plus className="size-4" aria-hidden="true" />
            New environment
          </Button>
        )}
      </div>

      {environments.map((env) => (
        <section
          key={env.id}
          aria-labelledby={`env-${env.id}`}
          className="overflow-hidden rounded-lg border border-line bg-surface"
        >
          <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3">
            <h2 id={`env-${env.id}`} className="text-sm font-semibold">
              {env.name}
            </h2>
            <p className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">
              {env.baseUrl ?? <span className="font-sans text-fg-subtle">No base URL</span>}
            </p>
            {canManage && (
              <div className="flex items-center">
                <IconButton
                  label={`Edit ${env.name}`}
                  onClick={() => setDialog({ kind: 'environment', environment: env })}
                >
                  <Pencil className="size-3.5" aria-hidden="true" />
                </IconButton>
                <IconButton
                  label={`Delete ${env.name}`}
                  onClick={() => setDialog({ kind: 'delete-environment', environment: env })}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </IconButton>
              </div>
            )}
          </header>

          {env.variables.length === 0 ? (
            <p className="px-4 py-4 text-sm text-fg-subtle">No variables.</p>
          ) : (
            <table className="w-full text-sm">
              <caption className="sr-only">Variables in {env.name}</caption>
              <thead className="sr-only">
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Value</th>
                  {canManage && <th scope="col">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {env.variables.map((variable) => (
                  <tr key={variable.id} data-testid={`variable-${env.name}-${variable.key}`}>
                    <th
                      scope="row"
                      className="w-1/3 px-4 py-2 text-left font-mono text-xs font-medium"
                    >
                      {variable.key}
                    </th>
                    <td className="max-w-0 px-4 py-2 font-mono text-xs">
                      {variable.isSecret ? (
                        <span className="inline-flex items-center gap-1.5 text-fg-subtle">
                          <span aria-hidden="true">••••••••</span>
                          <span className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 font-sans text-[11px] font-medium">
                            <Lock className="size-3" aria-hidden="true" />
                            Secret
                          </span>
                        </span>
                      ) : (
                        <span className="block truncate" title={variable.value ?? ''}>
                          {variable.value || <span className="text-fg-subtle">(empty)</span>}
                        </span>
                      )}
                    </td>
                    {canManage && (
                      <td className="w-20 px-2 py-1 text-right whitespace-nowrap">
                        <IconButton
                          label={`Edit ${variable.key}`}
                          onClick={() =>
                            setDialog({ kind: 'variable', environment: env, variable })
                          }
                        >
                          <Pencil className="size-3.5" aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label={`Delete ${variable.key}`}
                          onClick={() =>
                            setDialog({ kind: 'delete-variable', environment: env, variable })
                          }
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </IconButton>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {canManage && (
            <div className="border-t border-line px-2 py-1.5">
              <Button
                variant="ghost"
                onClick={() => setDialog({ kind: 'variable', environment: env })}
                disabled={env.variables.length >= MAX_VARIABLES_PER_ENVIRONMENT}
                aria-label={`Add variable to ${env.name}`}
                className="text-xs"
              >
                <Plus className="size-3.5" aria-hidden="true" />
                Add variable
              </Button>
            </div>
          )}
        </section>
      ))}

      {dialog?.kind === 'environment' && (
        <EnvironmentFormDialog
          projectId={project.id}
          environment={dialog.environment}
          onClose={close}
          onSaved={(saved) => {
            replaceEnvironment(saved);
            close();
          }}
        />
      )}
      {dialog?.kind === 'delete-environment' && (
        <ConfirmDialog
          title={`Delete ${dialog.environment.name}?`}
          confirmLabel="Delete environment"
          destructive
          onClose={close}
          onConfirm={async () => {
            await deleteEnvironment(project.id, dialog.environment.id);
            setData((list) => list.filter((e) => e.id !== dialog.environment.id));
            close();
          }}
        >
          Its base URL and {dialog.environment.variables.length} variable(s) will be deleted.
        </ConfirmDialog>
      )}
      {dialog?.kind === 'variable' && (
        <VariableFormDialog
          projectId={project.id}
          environmentId={dialog.environment.id}
          environmentName={dialog.environment.name}
          variable={dialog.variable}
          onClose={close}
          onSaved={(saved) => {
            updateVariables(dialog.environment.id, (vars) =>
              [...vars.filter((v) => v.id !== saved.id), saved].sort((a, b) =>
                a.key.localeCompare(b.key),
              ),
            );
            close();
          }}
        />
      )}
      {dialog?.kind === 'delete-variable' && (
        <ConfirmDialog
          title={`Delete ${dialog.variable.key}?`}
          confirmLabel="Delete variable"
          destructive
          onClose={close}
          onConfirm={async () => {
            await deleteVariable(project.id, dialog.environment.id, dialog.variable.id);
            updateVariables(dialog.environment.id, (vars) =>
              vars.filter((v) => v.id !== dialog.variable.id),
            );
            close();
          }}
        >
          The variable will be removed from {dialog.environment.name}.
        </ConfirmDialog>
      )}
    </div>
  );
}
