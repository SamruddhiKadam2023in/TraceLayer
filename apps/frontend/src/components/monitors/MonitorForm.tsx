import { useFieldArray, useForm, useWatch, type FieldPath } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, X } from 'lucide-react';
import {
  ASSERTION_OPERATORS,
  MAX_ASSERTIONS,
  MONITOR_INTERVALS,
  MONITOR_TYPE_INFO,
  MONITOR_TYPES,
  type EndpointView,
  type EnvironmentView,
  type MonitorConfig,
} from '@tracelayer/shared';
import { ErrorAlert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { CheckboxField } from '@/components/CheckboxField';
import { SelectField } from '@/components/SelectField';
import { TextField } from '@/components/TextField';
import { fieldErrors, toApiError } from '@/utils/api-error';
import { formatInterval } from '@/utils/format';
import {
  monitorFormSchema,
  toMonitorConfig,
  type MonitorFormOutput,
  type MonitorFormValues,
} from './monitor-form-schema';

const OPERATOR_LABELS: Record<(typeof ASSERTION_OPERATORS)[number], string> = {
  equals: 'equals',
  notEquals: 'does not equal',
  exists: 'exists',
  notExists: 'does not exist',
  contains: 'contains',
};

interface MonitorFormProps {
  initialValues: MonitorFormValues;
  endpoints: EndpointView[];
  environments: EnvironmentView[];
  submitLabel: string;
  onSubmit: (config: MonitorConfig) => Promise<void>;
  onCancel?: () => void;
}

export function MonitorForm({
  initialValues,
  endpoints,
  environments,
  submitLabel,
  onSubmit,
  onCancel,
}: MonitorFormProps) {
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getFieldState,
    formState: { errors, isSubmitting },
  } = useForm<MonitorFormValues, unknown, MonitorFormOutput>({
    resolver: zodResolver(monitorFormSchema),
    defaultValues: initialValues,
  });
  const assertions = useFieldArray({ control, name: 'assertions' });
  const type = useWatch({ control, name: 'type' });
  const assertionOps = useWatch({ control, name: 'assertions' });

  const submit = handleSubmit(async (values) => {
    try {
      await onSubmit(toMonitorConfig(values));
    } catch (err) {
      const apiError = toApiError(err);
      const fields = Object.entries(fieldErrors(apiError));
      for (const [path, message] of fields)
        setError(path as FieldPath<MonitorFormValues>, { message });
      if (fields.length === 0) setError('root', { message: apiError.message });
    }
  });

  const numberOrNull = { setValueAs: (v: string) => (v === '' || v === null ? null : Number(v)) };

  return (
    <form onSubmit={submit} noValidate className="flex max-w-3xl flex-col gap-6">
      {errors.root?.message && <ErrorAlert>{errors.root.message}</ErrorAlert>}

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Name"
          placeholder="Production orders"
          autoComplete="off"
          error={errors.name?.message}
          {...register('name')}
        />
        <SelectField
          label="Check every"
          options={MONITOR_INTERVALS.map((s) => ({ value: String(s), label: formatInterval(s) }))}
          error={errors.intervalSeconds?.message}
          {...register('intervalSeconds', { valueAsNumber: true })}
        />
        <SelectField
          label="Endpoint"
          error={errors.endpointId?.message}
          options={[
            { value: '', label: 'Choose an endpoint' },
            ...endpoints.map((e) => ({ value: e.id, label: `${e.method} ${e.name}` })),
          ]}
          {...register('endpointId', {
            onChange: (e: { target: { value: string } }) => {
              // Start from the endpoint's own timeout unless the user already chose one.
              const endpoint = endpoints.find((x) => x.id === e.target.value);
              if (endpoint && !getFieldState('timeoutMs').isDirty) {
                setValue('timeoutMs', endpoint.timeoutMs);
              }
            },
          })}
        />
        <SelectField
          label="Environment"
          error={errors.environmentId?.message}
          options={[
            { value: '', label: 'Choose an environment' },
            ...environments.map((e) => ({ value: e.id, label: e.name })),
          ]}
          {...register('environmentId')}
        />
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-medium">Type</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {MONITOR_TYPES.map((t) => (
            <label
              key={t}
              className={`flex cursor-pointer gap-2.5 rounded-lg border p-3 ${
                type === t ? 'border-accent bg-surface-2' : 'border-line bg-surface'
              }`}
            >
              <input
                type="radio"
                value={t}
                className="mt-0.5 accent-accent"
                {...register('type')}
              />
              <span>
                <span className="block text-sm font-medium">{MONITOR_TYPE_INFO[t].label}</span>
                <span className="block text-xs text-fg-muted">
                  {MONITOR_TYPE_INFO[t].description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          label="Timeout (ms)"
          type="number"
          min={1000}
          max={30000}
          step={500}
          error={errors.timeoutMs?.message}
          {...register('timeoutMs', { valueAsNumber: true })}
        />
        {type !== 'AVAILABILITY' && (
          <TextField
            label="Expected status"
            type="number"
            placeholder="Endpoint's, or any 2xx"
            error={errors.expectedStatus?.message}
            {...register('expectedStatus', numberOrNull)}
          />
        )}
        {type === 'PERFORMANCE' && (
          <TextField
            label="Latency threshold (ms)"
            type="number"
            min={50}
            placeholder="e.g. 1000"
            error={errors.latencyThresholdMs?.message}
            {...register('latencyThresholdMs', numberOrNull)}
          />
        )}
      </div>

      {type === 'RESPONSE_VALIDATION' && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Response checks</legend>
          <p className="text-xs text-fg-subtle">
            Paths are dot-separated, e.g. <code className="font-mono">data.items.0.id</code>. Values
            are read as JSON: <code className="font-mono">200</code>,{' '}
            <code className="font-mono">true</code>, <code className="font-mono">null</code>, or
            plain text.
          </p>
          {assertions.fields.map((field, index) => {
            const op = assertionOps?.[index]?.operator;
            const rowErrors = errors.assertions?.[index];
            const needsValue = op !== 'exists' && op !== 'notExists';
            return (
              <div key={field.id} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    aria-label={`Check ${index + 1} path`}
                    placeholder="status"
                    className="w-44 rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-xs"
                    {...register(`assertions.${index}.path`)}
                  />
                  <select
                    aria-label={`Check ${index + 1} operator`}
                    className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs"
                    {...register(`assertions.${index}.operator`)}
                  >
                    {ASSERTION_OPERATORS.map((o) => (
                      <option key={o} value={o}>
                        {OPERATOR_LABELS[o]}
                      </option>
                    ))}
                  </select>
                  {needsValue && (
                    <input
                      aria-label={`Check ${index + 1} value`}
                      placeholder="healthy"
                      className="min-w-32 flex-1 rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-xs"
                      {...register(`assertions.${index}.value`)}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => assertions.remove(index)}
                    aria-label={`Remove check ${index + 1}`}
                    className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-2 hover:text-fg"
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
                {(rowErrors?.path?.message ?? rowErrors?.value?.message) && (
                  <p className="text-xs text-fail">
                    {rowErrors?.path?.message ?? rowErrors?.value?.message}
                  </p>
                )}
              </div>
            );
          })}
          {errors.assertions?.message && (
            <p className="text-xs text-fail">{errors.assertions.message}</p>
          )}
          <div>
            <button
              type="button"
              onClick={() => assertions.append({ path: '', operator: 'equals', value: '' })}
              disabled={assertions.fields.length >= MAX_ASSERTIONS}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              Add check
            </button>
          </div>
        </fieldset>
      )}

      <CheckboxField
        label="Enabled"
        description="Paused monitors keep their history but do not run."
        {...register('enabled')}
      />

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
        )}
        <Button type="submit" loading={isSubmitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
