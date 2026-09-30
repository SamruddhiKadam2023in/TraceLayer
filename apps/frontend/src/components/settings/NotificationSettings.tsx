import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Mail, Pencil, Send, Trash2 } from 'lucide-react';
import {
  emailSchema,
  hasPermission,
  type NotificationChannelView,
  type WorkspaceSummary,
} from '@tracelayer/shared';
import { ErrorAlert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { CheckboxField } from '@/components/CheckboxField';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LoadError } from '@/components/EmptyState';
import { Modal } from '@/components/Modal';
import { StatusBadge } from '@/components/StatusBadge';
import { TextAreaField } from '@/components/TextAreaField';
import { TextField } from '@/components/TextField';
import { useQuery } from '@/hooks/useQuery';
import {
  createChannel,
  deleteChannel,
  fetchChannels,
  testChannel,
  updateChannel,
} from '@/services/alert.service';
import { fieldErrors, toApiError } from '@/utils/api-error';
import { formatRelative } from '@/utils/format';
import { SettingsSection } from './SettingsSection';

const splitRecipients = (text: string) =>
  text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const formSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100, 'Name is too long'),
  recipients: z
    .string()
    .transform(splitRecipients)
    .pipe(
      z
        .array(emailSchema)
        .min(1, 'Add at least one email address')
        .max(20, 'At most 20 recipients'),
    ),
  enabled: z.boolean(),
});
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

function ChannelDialog({
  channel,
  onSubmit,
  onClose,
}: {
  channel?: NotificationChannelView;
  onSubmit: (values: FormOutput) => Promise<void>;
  onClose: () => void;
}) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: channel?.name ?? '',
      recipients: channel?.config.recipients.join('\n') ?? '',
      enabled: channel?.enabled ?? true,
    },
  });
  const submit = handleSubmit(async (values) => {
    try {
      await onSubmit(values);
    } catch (err) {
      const apiError = toApiError(err);
      const fields = fieldErrors(apiError);
      if (fields.name) setError('name', { message: fields.name });
      else setError('root', { message: apiError.message });
    }
  });
  return (
    <Modal title={channel ? `Edit ${channel.name}` : 'New email channel'} onClose={onClose}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {errors.root?.message && <ErrorAlert>{errors.root.message}</ErrorAlert>}
        <TextField
          label="Name"
          placeholder="On-call team"
          error={errors.name?.message}
          {...register('name')}
        />
        <TextAreaField
          label="Recipients"
          placeholder={'oncall@company.com\nplatform@company.com'}
          hint="One email address per line (or separated by commas)."
          error={
            errors.recipients?.message ??
            (Array.isArray(errors.recipients) ? 'Check the email addresses' : undefined)
          }
          {...register('recipients')}
        />
        <CheckboxField label="Enabled" {...register('enabled')} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" loading={isSubmitting}>
            {channel ? 'Save' : 'Add channel'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Workspace notification channels (spec §28): email for now, sent by the worker. */
export function NotificationSettings({ workspace }: { workspace: WorkspaceSummary }) {
  const canManage = hasPermission(workspace.role, 'members.manage');
  const channels = useQuery(`channels:${workspace.id}`, () => fetchChannels(workspace.id));
  const [editing, setEditing] = useState<NotificationChannelView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<NotificationChannelView | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const replace = (updated: NotificationChannelView) =>
    channels.setData((list) =>
      list.some((c) => c.id === updated.id)
        ? list.map((c) => (c.id === updated.id ? updated : c))
        : [...list, updated],
    );

  return (
    <SettingsSection
      title="Notifications"
      description="Where alert emails go. Alert rules on monitors choose which of these channels to notify."
    >
      <div className="flex flex-col gap-3">
        {notice && (
          <p role="status" className={`text-sm ${notice.tone === 'ok' ? 'text-ok' : 'text-fail'}`}>
            {notice.text}
          </p>
        )}
        {channels.error && !channels.data ? (
          <LoadError message={channels.error.message} onRetry={channels.reload} />
        ) : !channels.data ? (
          <p role="status" className="text-sm text-fg-subtle">
            Loading channels…
          </p>
        ) : channels.data.length === 0 ? (
          <p className="text-sm text-fg-subtle">No channels yet.</p>
        ) : (
          <ul aria-label="Notification channels" className="divide-y divide-line">
            {channels.data.map((channel) => (
              <li
                key={channel.id}
                data-testid={`channel-${channel.name}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3"
              >
                <Mail className="size-4 text-fg-subtle" aria-hidden="true" />
                {/* A line of its own on phones; shares the row on wider screens. */}
                <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                  <p className="text-sm font-medium">
                    {channel.name}{' '}
                    {!channel.enabled && (
                      <span className="font-normal text-fg-subtle">(disabled)</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-fg-muted">
                    {channel.config.recipients.join(', ')}
                  </p>
                </div>
                {channel.lastDelivery && (
                  <span
                    className="text-xs text-fg-subtle"
                    title={channel.lastDelivery.error ?? undefined}
                  >
                    <StatusBadge
                      tone={
                        channel.lastDelivery.status === 'SENT'
                          ? 'healthy'
                          : channel.lastDelivery.status === 'FAILED'
                            ? 'failing'
                            : 'degraded'
                      }
                      label={
                        channel.lastDelivery.status === 'SENT'
                          ? 'Delivered'
                          : channel.lastDelivery.status === 'FAILED'
                            ? 'Failed'
                            : 'Sending'
                      }
                    />{' '}
                    {formatRelative(channel.lastDelivery.at)}
                  </span>
                )}
                {canManage && (
                  <div className="flex">
                    <button
                      type="button"
                      aria-label={`Send test to ${channel.name}`}
                      title="Send test"
                      onClick={async () => {
                        setNotice(null);
                        try {
                          await testChannel(channel.id);
                          setNotice({
                            tone: 'ok',
                            text: `Test notification queued for ${channel.name}.`,
                          });
                          channels.reload();
                        } catch (err) {
                          setNotice({ tone: 'error', text: toApiError(err).message });
                        }
                      }}
                      className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-2 hover:text-fg"
                    >
                      <Send className="size-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Edit ${channel.name}`}
                      onClick={() => setEditing(channel)}
                      className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-2 hover:text-fg"
                    >
                      <Pencil className="size-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${channel.name}`}
                      onClick={() => setDeleting(channel)}
                      className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-2 hover:text-fg"
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <div>
            <Button variant="secondary" onClick={() => setEditing('new')}>
              <Mail className="size-4" aria-hidden="true" />
              Add email channel
            </Button>
          </div>
        )}
      </div>

      {editing && (
        <ChannelDialog
          channel={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSubmit={async ({ name, recipients, enabled }) => {
            const saved =
              editing === 'new'
                ? await createChannel({ workspaceId: workspace.id, name, config: { recipients } })
                : await updateChannel(editing.id, { name, enabled, config: { recipients } });
            replace(saved);
            setEditing(null);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          confirmLabel="Delete channel"
          destructive
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await deleteChannel(deleting.id);
            channels.setData((list) => list.filter((c) => c.id !== deleting.id));
            setDeleting(null);
          }}
        >
          Alert rules stop notifying this channel.
        </ConfirmDialog>
      )}
    </SettingsSection>
  );
}
