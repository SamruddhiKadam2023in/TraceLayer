import { CheckCircle2, CircleDot, Eye, Search, Target } from 'lucide-react';
import { INCIDENT_STATUS_LABELS, type IncidentStatus } from '@tracelayer/shared';

const STYLE: Record<IncidentStatus, { className: string; Icon: typeof CircleDot }> = {
  OPEN: { className: 'bg-fail-soft text-fail', Icon: CircleDot },
  ACKNOWLEDGED: { className: 'bg-warn-soft text-warn', Icon: Eye },
  INVESTIGATING: { className: 'bg-warn-soft text-warn', Icon: Search },
  IDENTIFIED: { className: 'bg-warn-soft text-warn', Icon: Target },
  RESOLVED: { className: 'bg-ok-soft text-ok', Icon: CheckCircle2 },
};

/** Icon + text, so the status never depends on colour alone. */
export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  const { className, Icon } = STYLE[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${className}`}
    >
      <Icon className="size-3" aria-hidden="true" strokeWidth={2.5} />
      {INCIDENT_STATUS_LABELS[status]}
    </span>
  );
}
