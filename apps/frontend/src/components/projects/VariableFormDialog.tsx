import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  variableKeySchema,
  variableValueSchema,
  type EnvironmentVariableView,
  type UpdateVariableInput,
} from '@tracelayer/shared';
import { ErrorAlert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { CheckboxField } from '@/components/CheckboxField';
import { Modal } from '@/components/Modal';
import { TextField } from '@/components/TextField';
import { createVariable, updateVariable } from '@/services/project.service';
import { fieldErrors, toApiError } from '@/utils/api-error';

const formSchema = z.object({
  key: variableKeySchema,
  value: variableValueSchema,
  isSecret: z.boolean(),
});
type FormValues = z.infer<typeof formSchema>;

interface VariableFormDialogProps {
  projectId: string;
  environmentId: string;
  environmentName: string;
  /** Edit this variable; omit to add a new one. */
  variable?: EnvironmentVariableView;
  onSaved: (variable: EnvironmentVariableView) => void;
  onClose: () => void;
}

/** Only the fields that changed. A secret's value is sent only when a new one was typed. */
function changes(original: EnvironmentVariableView, values: FormValues): UpdateVariableInput {
  const patch: UpdateVariableInput = {};
  if (values.key !== original.key) patch.key = values.key;
  if (values.isSecret !== original.isSecret) patch.isSecret = values.isSecret;
  const valueChanged = original.isSecret ? values.value !== '' : values.value !== original.value;
  if (valueChanged) patch.value = values.value;
  return patch;
}

export function VariableFormDialog({
  projectId,
  environmentId,
  environmentName,
  variable,
  onSaved,
  onClose,
}: VariableFormDialogProps) {
  const editingSecret = variable?.isSecret ?? false;
  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      key: variable?.key ?? '',
      // Secret values are never sent to the browser, so there is nothing to prefill.
      value: variable && !variable.isSecret ? (variable.value ?? '') : '',
      isSecret: variable?.isSecret ?? false,
    },
  });
  const isSecret = useWatch({ control, name: 'isSecret' });

  const onSubmit = handleSubmit(async (values) => {
    if (editingSecret && !values.isSecret && values.value === '') {
      setError('value', { message: 'Enter a new value to make this variable plain' });
      return;
    }
    try {
      if (!variable) {
        onSaved(await createVariable(projectId, environmentId, values));
        return;
      }
      const patch = changes(variable, values);
      onSaved(
        Object.keys(patch).length === 0
          ? variable
          : await updateVariable(projectId, environmentId, variable.id, patch),
      );
    } catch (err) {
      const apiError = toApiError(err);
      const fields = fieldErrors(apiError);
      if (fields.key) setError('key', { message: fields.key });
      if (fields.value) setError('value', { message: fields.value });
      if (!fields.key && !fields.value) setError('root', { message: apiError.message });
    }
  });

  return (
    <Modal
      title={variable ? `Edit ${variable.key}` : 'Add variable'}
      description={`Environment: ${environmentName}`}
      onClose={onClose}
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {errors.root?.message && <ErrorAlert>{errors.root.message}</ErrorAlert>}
        <TextField
          label="Key"
          placeholder="API_KEY"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          error={errors.key?.message}
          {...register('key')}
        />
        <TextField
          label="Value"
          type={isSecret ? 'password' : 'text'}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          placeholder={editingSecret ? 'Leave empty to keep the current value' : undefined}
          hint={
            editingSecret
              ? 'The current value is hidden and cannot be shown. Enter a value to replace it.'
              : undefined
          }
          error={errors.value?.message}
          {...register('value')}
        />
        <CheckboxField
          label="Secret"
          description="Encrypted at rest and never shown again, not even to owners."
          {...register('isSecret')}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" loading={isSubmitting}>
            {variable ? 'Save' : 'Add variable'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
