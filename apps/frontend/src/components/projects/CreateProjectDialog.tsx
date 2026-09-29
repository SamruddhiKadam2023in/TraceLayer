import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { createProjectSchema, type ProjectView } from '@tracelayer/shared';
import { ErrorAlert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { TextAreaField } from '@/components/TextAreaField';
import { TextField } from '@/components/TextField';
import { createProject } from '@/services/project.service';
import { fieldErrors, toApiError } from '@/utils/api-error';

// The workspace comes from the current selection, not from the form.
const formSchema = createProjectSchema.omit({ workspaceId: true });
type FormValues = z.input<typeof formSchema>;

interface CreateProjectDialogProps {
  workspaceId: string;
  onCreated: (project: ProjectView) => void;
  onClose: () => void;
}

export function CreateProjectDialog({ workspaceId, onCreated, onClose }: CreateProjectDialogProps) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, z.output<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: '', description: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      onCreated(await createProject({ workspaceId, ...values }));
    } catch (err) {
      const apiError = toApiError(err);
      const fields = fieldErrors(apiError);
      if (fields.name) setError('name', { message: fields.name });
      else setError('root', { message: apiError.message });
    }
  });

  return (
    <Modal
      title="New project"
      description="A project groups the endpoints and monitors of one API or service."
      onClose={onClose}
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {errors.root?.message && <ErrorAlert>{errors.root.message}</ErrorAlert>}
        <TextField
          label="Project name"
          placeholder="e.g. Payments API"
          autoComplete="off"
          error={errors.name?.message}
          {...register('name')}
        />
        <TextAreaField
          label="Description"
          hint="Optional. What does this API do?"
          error={errors.description?.message}
          {...register('description')}
        />
        <p className="text-xs text-fg-subtle">
          Development, Staging and Production environments are created for you.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" loading={isSubmitting}>
            Create project
          </Button>
        </div>
      </form>
    </Modal>
  );
}
