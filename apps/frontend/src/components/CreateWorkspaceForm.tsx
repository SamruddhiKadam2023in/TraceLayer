import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createWorkspaceSchema, type WorkspaceSummary } from '@tracelayer/shared';
import { createWorkspace } from '@/services/workspace.service';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { fieldErrors, toApiError } from '@/utils/api-error';
import { ErrorAlert } from './Alert';
import { Button } from './Button';
import { TextField } from './TextField';

interface CreateWorkspaceFormProps {
  onCreated?: (workspace: WorkspaceSummary) => void;
  onCancel?: () => void;
  submitLabel?: string;
}

/** Creates a workspace, adds it to the store and switches to it. */
export function CreateWorkspaceForm({
  onCreated,
  onCancel,
  submitLabel = 'Create workspace',
}: CreateWorkspaceFormProps) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(createWorkspaceSchema), defaultValues: { name: '' } });

  const onSubmit = handleSubmit(async ({ name }) => {
    try {
      const workspace = await createWorkspace(name);
      const store = useWorkspaceStore.getState();
      store.upsert(workspace);
      store.select(workspace.id);
      onCreated?.(workspace);
    } catch (err) {
      const apiError = toApiError(err);
      const fields = fieldErrors(apiError);
      if (fields.name) setError('name', { message: fields.name });
      else setError('root', { message: apiError.message });
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      {errors.root?.message && <ErrorAlert>{errors.root.message}</ErrorAlert>}
      <TextField
        label="Workspace name"
        placeholder="e.g. Acme Engineering"
        autoComplete="off"
        error={errors.name?.message}
        {...register('name')}
      />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
        )}
        <Button type="submit" loading={isSubmitting} className={onCancel ? '' : 'w-full'}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
