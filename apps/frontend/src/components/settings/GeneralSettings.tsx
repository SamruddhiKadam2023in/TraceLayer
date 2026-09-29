import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  hasPermission,
  ROLE_LABELS,
  updateWorkspaceSchema,
  type WorkspaceSummary,
} from '@tracelayer/shared';
import { ErrorAlert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { TextField } from '@/components/TextField';
import { renameWorkspace } from '@/services/workspace.service';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { fieldErrors, toApiError } from '@/utils/api-error';
import { SettingsSection } from './SettingsSection';

export function GeneralSettings({ workspace }: { workspace: WorkspaceSummary }) {
  const canRename = hasPermission(workspace.role, 'workspace.update');
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting, isDirty, isSubmitSuccessful },
  } = useForm({
    resolver: zodResolver(updateWorkspaceSchema),
    values: { name: workspace.name },
  });

  const onSubmit = handleSubmit(async ({ name }) => {
    try {
      const updated = await renameWorkspace(workspace.id, name);
      useWorkspaceStore.getState().upsert(updated);
      reset({ name: updated.name });
    } catch (err) {
      const apiError = toApiError(err);
      const fields = fieldErrors(apiError);
      if (fields.name) setError('name', { message: fields.name });
      else setError('root', { message: apiError.message });
    }
  });

  return (
    <SettingsSection title="General" description="The workspace's name is visible to all members.">
      {canRename ? (
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
          {errors.root?.message && <ErrorAlert>{errors.root.message}</ErrorAlert>}
          <TextField label="Workspace name" error={errors.name?.message} {...register('name')} />
          <div className="flex items-center justify-end gap-3">
            {isSubmitSuccessful && !isDirty && (
              <p role="status" className="text-xs text-ok">
                Saved
              </p>
            )}
            <Button type="submit" loading={isSubmitting} disabled={!isDirty}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <dl className="text-sm">
          <dt className="font-medium">Workspace name</dt>
          <dd className="mt-1 text-fg-muted">{workspace.name}</dd>
          <dd className="mt-3 text-xs text-fg-subtle">
            Only owners can rename the workspace. Your role: {ROLE_LABELS[workspace.role]}.
          </dd>
        </dl>
      )}
    </SettingsSection>
  );
}
