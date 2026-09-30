import type { HealthStatus } from '@tracelayer/shared';
import { StatusBadge } from '@/components/StatusBadge';

/**
 * A monitor's health (see computeHealth): Healthy ✓, Degraded !, Failing ×. Shape and text carry
 * the meaning; colour only reinforces it.
 */
export function HealthBadge({
  health,
  paused = false,
}: {
  health: HealthStatus;
  paused?: boolean;
}) {
  // A paused monitor keeps the health of its last checks; say both.
  if (paused) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Health health={health} />
        <span className="inline-flex items-center rounded border border-line px-1.5 py-0.5 text-xs font-medium text-fg-muted">
          Paused
        </span>
      </span>
    );
  }
  return <Health health={health} />;
}

function Health({ health }: { health: HealthStatus }) {
  switch (health) {
    case 'HEALTHY':
      return <StatusBadge tone="healthy" label="Healthy" />;
    case 'DEGRADED':
      return <StatusBadge tone="degraded" label="Degraded" />;
    case 'FAILING':
      return <StatusBadge tone="failing" label="Failing" />;
    case 'NO_DATA':
      return (
        <span className="inline-flex items-center rounded border border-dashed border-line px-1.5 py-0.5 text-xs text-fg-subtle">
          No data yet
        </span>
      );
  }
}
