import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { environmentNameSchema, type EnvironmentView } from '@tracelayer/shared';
import { ErrorAlert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { TextField } from '@/components/TextField';
import { createEnvironment, updateEnvironment } from '@/services/project.service';
import { fieldErrors, toApiError } from '@/utils/api-error';

// The server normalises and fully validates the URL; this catches obvious slips early.
const formSchema = z.object({
  name: environmentNameSchema,
  baseUrl: z
    .string()
    .trim()
    .max(2048, 'URL is too long')
    .refine((v) => v === '' || /^https?:\/\//i.test(v), 'Start with http:// or https://'),
});
type FormValues = z.infer<typeof formSchema>;

interface EnvironmentFormDialogProps {
  projectId: string;
  /** Edit this environment; omit to create a new one. */
  environment?: EnvironmentView;
  onSaved: (environment: EnvironmentView) => void;
  onClose: () => void;
}

export function EnvironmentFormDialog({
  projectId,
  environment,
  onSaved,
  onClose,
}: EnvironmentFormDialogProps) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: environment?.name ?? '', baseUrl: environment?.baseUrl ?? '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      onSaved(
        environment
          ? await updateEnvironment(projectId, environment.id, values)
          : await createEnvironment(projectId, values),
      );
    } catch (err) {
      const apiError = toApiError(err);
      const fields = fieldErrors(apiError);
      if (fields.name) setError('name', { message: fields.name });
      if (fields.baseUrl) setError('baseUrl', { message: fields.baseUrl });
      if (!fields.name && !fields.baseUrl) setError('root', { message: apiError.message });
    }
  });

  return (
    <Modal title={environment ? `Edit ${environment.name}` : 'New environment'} onClose={onClose}>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {errors.root?.message && <ErrorAlert>{errors.root.message}</ErrorAlert>}
        <TextField
          label="Name"
          placeholder="e.g. QA"
          autoComplete="off"
          error={errors.name?.message}
          {...register('name')}
        />
        <TextField
          label="Base URL"
          placeholder="https://api.example.com"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          hint="Endpoint paths are appended to this. Leave empty to set it later."
          error={errors.baseUrl?.message}
          {...register('baseUrl')}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" loading={isSubmitting}>
            {environment ? 'Save' : 'Create environment'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
