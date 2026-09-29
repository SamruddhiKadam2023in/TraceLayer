import type { AlertRuleState, Severity } from '@tracelayer/shared';
import { StatusBadge } from '@/components/StatusBadge';

const SEVERITY_STYLE: Record<Severity, string> = {
  LOW: 'border-line text-fg-muted',
  MEDIUM: 'border-warn/40 text-warn',
  HIGH: 'border-fail/40 text-fail',
  CRITICAL: 'border-fail bg-fail-soft text-fail',
};

/** Severity is spelled out; colour only reinforces it. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-semibold tracking-wide ${SEVERITY_STYLE[severity]}`}
    >
      {severity}
    </span>
  );
}

export function RuleStateBadge({ state, enabled }: { state: AlertRuleState; enabled: boolean }) {
  if (!enabled) {
    return (
      <span className="inline-flex items-center rounded border border-line px-1.5 py-0.5 text-xs text-fg-muted">
        Disabled
      </span>
    );
  }
  if (state === 'FIRING') return <StatusBadge tone="failing" label="Firing" />;
  if (state === 'PENDING') return <StatusBadge tone="degraded" label="Pending" />;
  return <StatusBadge tone="healthy" label="OK" />;
}
