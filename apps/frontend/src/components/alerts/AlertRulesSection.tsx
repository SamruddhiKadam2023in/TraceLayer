import { useState } from 'react';
import { BellPlus, Pencil, Trash2 } from 'lucide-react';
import { ALERT_METRIC_INFO, type AlertRuleView } from '@tracelayer/shared';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LoadError } from '@/components/EmptyState';
import { useQuery } from '@/hooks/useQuery';
import {
  createRule,
  deleteRule,
  fetchChannels,
  fetchMonitorRules,
  updateRule,
} from '@/services/alert.service';
import { formatRelative } from '@/utils/format';
import { AlertRuleFormDialog } from './AlertRuleFormDialog';
import { RuleStateBadge, SeverityBadge } from './AlertBadges';

interface AlertRulesSectionProps {
  monitorId: string;
  workspaceId: string;
  canManage: boolean;
}

function formatObserved(rule: AlertRuleView): string | null {
  if (rule.lastValue === null) return null;
  const unit = ALERT_METRIC_INFO[rule.metric].unit;
  const value = Math.round(rule.lastValue * 100) / 100;
  return unit === '%' ? `${value}%` : unit ? `${value} ${unit}` : String(value);
}

/** A monitor's alert rules: state, thresholds, channels, and editing for managers. */
export function AlertRulesSection({ monitorId, workspaceId, canManage }: AlertRulesSectionProps) {
  const rules = useQuery(`rules:${monitorId}`, () => fetchMonitorRules(monitorId));
  const channels = useQuery(`channels:${workspaceId}`, () => fetchChannels(workspaceId));
  const [editing, setEditing] = useState<AlertRuleView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AlertRuleView | null>(null);

  const replace = (updated: AlertRuleView) =>
    rules.setData((list) =>
      list.some((r) => r.id === updated.id)
        ? list.map((r) => (r.id === updated.id ? updated : r))
        : [...list, updated],
    );

  return (
    <section aria-labelledby="alert-rules-heading" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 id="alert-rules-heading" className="text-sm font-semibold">
          Alert rules
        </h3>
        {canManage && (
          <Button variant="secondary" onClick={() => setEditing('new')} disabled={!channels.data}>
            <BellPlus className="size-4" aria-hidden="true" />
            New rule
          </Button>
        )}
      </div>

      {rules.error && !rules.data ? (
        <LoadError message={rules.error.message} onRetry={rules.reload} />
      ) : !rules.data ? (
        <div
          aria-hidden="true"
          className="h-16 animate-pulse rounded-lg border border-line bg-surface"
        />
      ) : rules.data.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-fg-subtle">
          No alert rules. {canManage && 'Add one to be notified when this monitor misbehaves.'}
        </p>
      ) : (
        <ul
          aria-label="Alert rules"
          className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface"
        >
          {rules.data.map((rule) => (
            <li
              key={rule.id}
              data-testid={`rule-${rule.name}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {rule.name}
                  <SeverityBadge severity={rule.severity} />
                </p>
                <p className="text-xs text-fg-muted">
                  {rule.description}
                  {rule.channelIds.length > 0 &&
                    ` · notifies ${rule.channelIds.length} channel${rule.channelIds.length > 1 ? 's' : ''}`}
                </p>
              </div>
              <p className="text-xs text-fg-subtle">
                {formatObserved(rule) && (
                  <>
                    Last: <span className="font-mono">{formatObserved(rule)}</span> ·{' '}
                  </>
                )}
                {rule.lastEvaluatedAt
                  ? `checked ${formatRelative(rule.lastEvaluatedAt)}`
                  : 'not evaluated yet'}
              </p>
              <RuleStateBadge state={rule.state} enabled={rule.enabled} />
              {canManage && (
                <div className="flex">
                  <button
                    type="button"
                    aria-label={`Edit ${rule.name}`}
                    onClick={() => setEditing(rule)}
                    className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-2 hover:text-fg"
                  >
                    <Pencil className="size-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${rule.name}`}
                    onClick={() => setDeleting(rule)}
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

      {editing && channels.data && (
        <AlertRuleFormDialog
          monitorId={monitorId}
          channels={channels.data}
          rule={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSubmit={async (config) => {
            const saved =
              editing === 'new'
                ? await createRule(config)
                : await updateRule(editing.id, {
                    name: config.name,
                    metric: config.metric,
                    threshold: config.threshold,
                    durationMinutes: config.durationMinutes,
                    severity: config.severity,
                    enabled: config.enabled,
                    channelIds: config.channelIds,
                  });
            replace(saved);
            setEditing(null);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          confirmLabel="Delete rule"
          destructive
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await deleteRule(deleting.id);
            rules.setData((list) => list.filter((r) => r.id !== deleting.id));
            setDeleting(null);
          }}
        >
          The rule stops being evaluated. Its past alerts stay in the alert history.
        </ConfirmDialog>
      )}
    </section>
  );
}
