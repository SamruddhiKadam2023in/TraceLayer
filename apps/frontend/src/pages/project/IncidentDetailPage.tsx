import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Bot, CheckCircle2, Eye, RotateCcw } from 'lucide-react';
import {
  describeIncidentEvent,
  hasPermission,
  INCIDENT_STATUSES,
  INCIDENT_STATUS_LABELS,
  MAX_COMMENT_LENGTH,
  SEVERITIES,
  type IncidentDetail,
  type IncidentEventView,
  type IncidentStatus,
  type Severity,
  type UpdateIncidentInput,
} from '@tracelayer/shared';
import { ErrorAlert } from '@/components/Alert';
import { SeverityBadge } from '@/components/alerts/AlertBadges';
import { Button } from '@/components/Button';
import { LoadError } from '@/components/EmptyState';
import { IncidentStatusBadge } from '@/components/incidents/IncidentStatusBadge';
import { SelectField } from '@/components/SelectField';
import { StatusBadge } from '@/components/StatusBadge';
import { TextAreaField } from '@/components/TextAreaField';
import { useRealtimeRefresh } from '@/hooks/useRealtime';
import { useQuery } from '@/hooks/useQuery';
import { addIncidentComment, fetchIncident, updateIncident } from '@/services/incident.service';
import { fetchMembers } from '@/services/workspace.service';
import { useCurrentWorkspace } from '@/stores/workspace.store';
import { toApiError } from '@/utils/api-error';
import { formatDate, formatDuration, formatTime } from '@/utils/format';

const title = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
const when = (iso: string) => `${formatDate(iso)} ${formatTime(iso)}`;

function TimelineEntry({ event }: { event: IncidentEventView }) {
  const isComment = event.type === 'COMMENT';
  return (
    <li className="relative pb-5 pl-6 last:pb-0" data-testid="timeline-event">
      <span
        aria-hidden="true"
        className={`absolute top-1.5 -left-[5px] size-2.5 rounded-full ${event.actor ? 'bg-accent' : 'bg-fg-subtle'}`}
      />
      <p className="text-xs text-fg-subtle">
        <time dateTime={event.createdAt}>{when(event.createdAt)}</time> ·{' '}
        {event.actor ? (
          <span className="font-medium text-fg-muted">{event.actor.name}</span>
        ) : (
          <span className="inline-flex items-center gap-1">
            <Bot className="size-3" aria-hidden="true" />
            TraceLayer
          </span>
        )}
      </p>
      {isComment ? (
        <p className="mt-1 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap">
          {event.message}
        </p>
      ) : (
        <p className="mt-0.5 text-sm">{describeIncidentEvent(event)}</p>
      )}
    </li>
  );
}

function CommentForm({ onAdd }: { onAdd: (message: string) => Promise<void> }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!message.trim()) {
      setError('Write a comment');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onAdd(message);
      setMessage('');
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-2">
      <TextAreaField
        label="Add a comment"
        rows={3}
        maxLength={MAX_COMMENT_LENGTH}
        placeholder="What did you find? What did you change?"
        value={message}
        error={error ?? undefined}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div>
        <Button type="submit" variant="secondary" loading={saving}>
          Comment
        </Button>
      </div>
    </form>
  );
}

/** One incident (spec §26–27): what happened, who is on it, and everything done so far. */
export function IncidentDetailPage() {
  const { incidentId = '' } = useParams();
  const workspace = useCurrentWorkspace();
  const canManage = hasPermission(workspace.role, 'incidents.manage');
  const incident = useQuery(`incident:${incidentId}`, () => fetchIncident(incidentId));
  // Someone else acknowledged, commented, or the monitor recovered: show it without a reload.
  useRealtimeRefresh(
    (m) =>
      (m.event === 'incident.created' || m.event === 'incident.updated') &&
      m.payload.incident.id === incidentId,
    incident.reload,
    1000,
  );
  const members = useQuery(canManage ? `members:${workspace.id}` : null, () =>
    fetchMembers(workspace.id),
  );
  const [now] = useState(Date.now);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (incident.error && !incident.data) {
    return <LoadError message={incident.error.message} onRetry={incident.reload} />;
  }
  if (!incident.data) {
    return (
      <div
        aria-hidden="true"
        className="h-64 animate-pulse rounded-lg border border-line bg-surface"
      />
    );
  }
  const data: IncidentDetail = incident.data;

  const change = async (changes: UpdateIncidentInput) => {
    setSaving(true);
    setActionError(null);
    try {
      const updated = await updateIncident(data.id, changes);
      incident.setData(() => updated);
    } catch (err) {
      setActionError(toApiError(err).message);
    } finally {
      setSaving(false);
    }
  };

  const end = data.resolvedAt ? Date.parse(data.resolvedAt) : now;
  const duration = formatDuration(
    Math.max(0, Math.round((end - Date.parse(data.detectedAt)) / 1000)),
  );
  const assignable = (members.data ?? []).filter((m) => m.role !== 'VIEWER');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          to=".."
          relative="path"
          className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          All incidents
        </Link>
        <h2 className="mt-2 text-lg font-semibold tracking-tight">
          <span className="font-mono text-fg-subtle">#{data.number}</span> {data.title}
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          <IncidentStatusBadge status={data.status} />
          <SeverityBadge severity={data.severity} />
          <span>
            Detected <time dateTime={data.detectedAt}>{when(data.detectedAt)}</time> ·{' '}
            {data.resolvedAt ? `lasted ${duration}` : `open for ${duration}`}
          </span>
        </div>
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="text-fg-subtle">Monitor</dt>
            <dd>
              {data.monitor ? (
                <Link
                  to={`../../monitors/${data.monitor.id}`}
                  relative="path"
                  className="text-accent hover:underline"
                >
                  {data.monitor.name}
                </Link>
              ) : (
                'Deleted monitor'
              )}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-fg-subtle">Assignee</dt>
            <dd>{data.assignee?.name ?? 'Unassigned'}</dd>
          </div>
          {data.acknowledgedAt && (
            <div className="flex gap-2">
              <dt className="text-fg-subtle">Acknowledged</dt>
              <dd>{when(data.acknowledgedAt)}</dd>
            </div>
          )}
          {data.resolvedAt && (
            <div className="flex gap-2">
              <dt className="text-fg-subtle">Resolved</dt>
              <dd>
                {when(data.resolvedAt)}{' '}
                {data.resolvedBy
                  ? `by ${data.resolvedBy.name}`
                  : 'automatically (monitor recovered)'}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {canManage && (
        <section
          aria-label="Actions"
          className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
        >
          {actionError && <ErrorAlert>{actionError}</ErrorAlert>}
          <div className="flex flex-wrap gap-2">
            {data.status === 'OPEN' && (
              <Button onClick={() => change({ status: 'ACKNOWLEDGED' })} disabled={saving}>
                <Eye className="size-4" aria-hidden="true" />
                Acknowledge
              </Button>
            )}
            {data.status === 'RESOLVED' ? (
              <Button
                variant="secondary"
                onClick={() => change({ status: 'OPEN' })}
                disabled={saving}
              >
                <RotateCcw className="size-4" aria-hidden="true" />
                Reopen
              </Button>
            ) : (
              <Button
                variant="secondary"
                onClick={() => change({ status: 'RESOLVED' })}
                disabled={saving}
              >
                <CheckCircle2 className="size-4" aria-hidden="true" />
                Resolve
              </Button>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <SelectField
              label="Status"
              value={data.status}
              disabled={saving}
              options={INCIDENT_STATUSES.map((s) => ({
                value: s,
                label: INCIDENT_STATUS_LABELS[s],
              }))}
              onChange={(e) => change({ status: e.target.value as IncidentStatus })}
            />
            <SelectField
              label="Severity"
              value={data.severity}
              disabled={saving}
              options={SEVERITIES.map((s) => ({ value: s, label: title(s) }))}
              onChange={(e) => change({ severity: e.target.value as Severity })}
            />
            <SelectField
              label="Assignee"
              value={data.assignee?.id ?? ''}
              disabled={saving || !members.data}
              options={[
                { value: '', label: 'Unassigned' },
                ...assignable.map((m) => ({ value: m.userId, label: m.name })),
                // Keep a current assignee visible even if their role changed since.
                ...(data.assignee && !assignable.some((m) => m.userId === data.assignee?.id)
                  ? [{ value: data.assignee.id, label: data.assignee.name }]
                  : []),
              ]}
              onChange={(e) => change({ assigneeId: e.target.value || null })}
            />
          </div>
        </section>
      )}

      <section aria-labelledby="incident-alerts" className="flex flex-col gap-2">
        <h3 id="incident-alerts" className="text-sm font-semibold">
          Alerts
        </h3>
        {data.alerts.length === 0 ? (
          <p className="text-sm text-fg-subtle">No alerts are linked to this incident any more.</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {data.alerts.map((alert) => (
              <li
                key={alert.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
              >
                {alert.status === 'FIRING' ? (
                  <StatusBadge tone="failing" label="Firing" />
                ) : (
                  <StatusBadge tone="healthy" label="Resolved" />
                )}
                <SeverityBadge severity={alert.severity} />
                <p className="min-w-0 flex-1 truncate text-sm">
                  {alert.rule ? `${alert.rule.name}: ` : ''}
                  {alert.message}
                </p>
                <time className="text-xs text-fg-subtle" dateTime={alert.firedAt}>
                  {when(alert.firedAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="incident-timeline" className="flex flex-col gap-3">
        <h3 id="incident-timeline" className="text-sm font-semibold">
          Timeline
        </h3>
        <ol aria-label="Timeline" className="mb-2 border-l border-line pl-0">
          {data.events.map((event) => (
            <TimelineEntry key={event.id} event={event} />
          ))}
        </ol>
        {canManage && (
          <CommentForm
            onAdd={async (message) => {
              const event = await addIncidentComment(data.id, message);
              incident.setData((current) => ({ ...current, events: [...current.events, event] }));
            }}
          />
        )}
      </section>
    </div>
  );
}
