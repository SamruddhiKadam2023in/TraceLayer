import { StatusBadge } from '@/components/StatusBadge';

/** A monitor's latest outcome. "No data" until the first run; text, not just colour. */
export function RunStatus({
  success,
  paused = false,
}: {
  success: boolean | null;
  paused?: boolean;
}) {
  if (paused) {
    return (
      <span className="inline-flex items-center rounded border border-line px-1.5 py-0.5 text-xs font-medium text-fg-muted">
        Paused
      </span>
    );
  }
  if (success === null) {
    return (
      <span className="inline-flex items-center rounded border border-dashed border-line px-1.5 py-0.5 text-xs text-fg-subtle">
        No data yet
      </span>
    );
  }
  return <StatusBadge tone={success ? 'healthy' : 'failing'} label={success ? 'Up' : 'Down'} />;
}
