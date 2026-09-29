import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { hasPermission, projectNameSchema } from '@tracelayer/shared';
import { ErrorAlert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { TextAreaField } from '@/components/TextAreaField';
import { TextField } from '@/components/TextField';
import { useProject } from '@/hooks/useProject';
import { deleteProject, updateProject } from '@/services/project.service';
import { useCurrentWorkspace } from '@/stores/workspace.store';
import { fieldErrors, toApiError } from '@/utils/api-error';

const formSchema = z.object({
  name: projectNameSchema,
  description: z.string().trim().max(500, 'Description is too long'),
});
type FormValues = z.infer<typeof formSchema>;

export function ProjectSettingsPage() {
  const { project, setProject } = useProject();
  const workspace = useCurrentWorkspace();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const canManage = hasPermission(workspace.role, 'projects.manage');

  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting, isDirty, isSubmitSuccessful },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    values: { name: project.name, description: project.description ?? '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const updated = await updateProject(project.id, values);
      setProject(updated);
      reset({ name: updated.name, description: updated.description ?? '' });
    } catch (err) {
      const apiError = toApiError(err);
      const fields = fieldErrors(apiError);
      if (fields.name) setError('name', { message: fields.name });
      else setError('root', { message: apiError.message });
    }
  });

  if (!canManage) {
    return (
      <SettingsSection title="Project settings">
        <p className="text-sm text-fg-muted">
          Only owners and admins of {workspace.name} can change or delete this project.
        </p>
      </SettingsSection>
    );
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <SettingsSection title="General">
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          {errors.root?.message && <ErrorAlert>{errors.root.message}</ErrorAlert>}
          <TextField label="Project name" error={errors.name?.message} {...register('name')} />
          <TextAreaField
            label="Description"
            error={errors.description?.message}
            {...register('description')}
          />
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
      </SettingsSection>

      <SettingsSection title="Danger zone" tone="danger">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Delete project</p>
            <p className="text-sm text-fg-muted">
              Permanently deletes the project, its environments and variables.
            </p>
          </div>
          <Button variant="danger" onClick={() => setDeleting(true)}>
            Delete project
          </Button>
        </div>
      </SettingsSection>

      {deleting && (
        <ConfirmDialog
          title={`Delete ${project.name}?`}
          confirmLabel="Delete project"
          destructive
          confirmationText={project.name}
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await deleteProject(project.id);
            navigate('/projects', { replace: true });
          }}
        >
          This permanently deletes the project and everything in it. It cannot be undone.
        </ConfirmDialog>
      )}
    </div>
  );
}
