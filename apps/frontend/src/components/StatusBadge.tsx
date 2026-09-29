import { AlertTriangle, Check, X } from 'lucide-react';

export type StatusTone = 'healthy' | 'degraded' | 'failing';

const TONES: Record<StatusTone, { className: string; Icon: typeof Check; defaultLabel: string }> = {
  healthy: { className: 'bg-ok-soft text-ok', Icon: Check, defaultLabel: 'Healthy' },
  degraded: { className: 'bg-warn-soft text-warn', Icon: AlertTriangle, defaultLabel: 'Degraded' },
  failing: { className: 'bg-fail-soft text-fail', Icon: X, defaultLabel: 'Failing' },
};

interface StatusBadgeProps {
  tone: StatusTone;
  label?: string;
}

/** Status is always conveyed by icon + text, never by color alone. */
export function StatusBadge({ tone, label }: StatusBadgeProps) {
  const { className, Icon, defaultLabel } = TONES[tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${className}`}
    >
      <Icon className="size-3" aria-hidden="true" strokeWidth={2.5} />
      {label ?? defaultLabel}
    </span>
  );
}
