import { useForm, useWatch, type FieldPath } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ALERT_METRIC_INFO,
  ALERT_METRICS,
  alertRuleSchema,
  describeRule,
  SEVERITIES,
  type AlertRuleConfig,
  type AlertRuleConfigInput,
  type AlertRuleView,
  type NotificationChannelView,
} from '@tracelayer/shared';
import { ErrorAlert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { CheckboxField } from '@/components/CheckboxField';
import { Modal } from '@/components/Modal';
import { SelectField } from '@/components/SelectField';
import { TextField } from '@/components/TextField';
import { fieldErrors, toApiError } from '@/utils/api-error';

interface AlertRuleFormDialogProps {
  monitorId: string;
  channels: NotificationChannelView[];
  /** Edit this rule; omit to create one. */
  rule?: AlertRuleView;
  onSubmit: (config: AlertRuleConfig) => Promise<void>;
  onClose: () => void;
}

const durationLabel = {
  window: 'Over the last (minutes)',
  sustained: 'For at least (minutes)',
  count: '',
} as const;

export function AlertRuleFormDialog({
  monitorId,
  channels,
  rule,
  onSubmit,
  onClose,
}: AlertRuleFormDialogProps) {
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<AlertRuleConfigInput, unknown, AlertRuleConfig>({
    resolver: zodResolver(alertRuleSchema),
    defaultValues: rule
      ? {
          monitorId,
          name: rule.name,
          metric: rule.metric,
          threshold: rule.threshold,
          durationMinutes: rule.durationMinutes,
          severity: rule.severity,
          enabled: rule.enabled,
          channelIds: rule.channelIds,
        }
      : {
          monitorId,
          name: '',
          metric: 'ERROR_RATE',
          threshold: 5,
          durationMinutes: 5,
          severity: 'HIGH',
          enabled: true,
          channelIds: channels.filter((c) => c.enabled).map((c) => c.id),
        },
  });
  const [metric, threshold, durationMinutes] = useWatch({
    control,
    name: ['metric', 'threshold', 'durationMinutes'],
  });
  const info = ALERT_METRIC_INFO[metric];
  const preview =
    Number.isFinite(threshold) && Number.isFinite(durationMinutes)
      ? describeRule({
          metric,
          threshold,
          durationMinutes: info.kind === 'count' ? 0 : durationMinutes,
        })
      : null;

  const submit = handleSubmit(async (config) => {
    try {
      await onSubmit({
        ...config,
        durationMinutes: info.kind === 'count' ? 0 : config.durationMinutes,
      });
    } catch (err) {
      const apiError = toApiError(err);
      const fields = Object.entries(fieldErrors(apiError));
      for (const [path, message] of fields)
        setError(path as FieldPath<AlertRuleConfigInput>, { message });
      if (fields.length === 0) setError('root', { message: apiError.message });
    }
  });

  return (
    <Modal title={rule ? `Edit ${rule.name}` : 'New alert rule'} onClose={onClose}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {errors.root?.message && <ErrorAlert>{errors.root.message}</ErrorAlert>}
        <TextField
          label="Name"
          placeholder="High error rate"
          autoComplete="off"
          error={errors.name?.message}
          {...register('name')}
        />
        <SelectField
          label="When"
          options={ALERT_METRICS.map((m) => {
            const i = ALERT_METRIC_INFO[m];
            return {
              value: m,
              label: `${i.label} ${i.comparator === '<' ? 'drops below' : i.comparator === '=' ? 'is' : 'exceeds'}`,
            };
          })}
          error={errors.metric?.message}
          {...register('metric')}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label={`Threshold${info.unit ? ` (${info.unit})` : ''}`}
            type="number"
            step={info.integer ? 1 : 0.1}
            min={info.min}
            max={info.max}
            error={errors.threshold?.message}
            {...register('threshold', { valueAsNumber: true })}
          />
          {info.kind !== 'count' && (
            <TextField
              label={durationLabel[info.kind]}
              type="number"
              min={info.kind === 'window' ? 1 : 0}
              max={1440}
              hint={info.kind === 'sustained' ? '0 fires on the first bad check.' : undefined}
              error={errors.durationMinutes?.message}
              {...register('durationMinutes', { valueAsNumber: true })}
            />
          )}
        </div>
        {preview && (
          <p className="rounded-md bg-surface-2 px-3 py-2 text-sm">
            Fires when <span className="font-medium">{preview}</span>.
          </p>
        )}
        <SelectField
          label="Severity"
          options={SEVERITIES.map((s) => ({
            value: s,
            label: s.charAt(0) + s.slice(1).toLowerCase(),
          }))}
          {...register('severity')}
        />
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Notify</legend>
          {channels.length === 0 ? (
            <p className="text-xs text-fg-subtle">
              No notification channels yet. Owners and admins add them in Settings → Notifications.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {channels.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    value={c.id}
                    className="size-4 accent-accent"
                    {...register('channelIds')}
                  />
                  {c.name}
                  <span className="truncate text-xs text-fg-subtle">
                    {c.config.recipients.join(', ')}
                  </span>
                  {!c.enabled && <span className="text-xs text-fg-subtle">(disabled)</span>}
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <CheckboxField label="Enabled" {...register('enabled')} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" loading={isSubmitting}>
            {rule ? 'Save' : 'Create rule'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
