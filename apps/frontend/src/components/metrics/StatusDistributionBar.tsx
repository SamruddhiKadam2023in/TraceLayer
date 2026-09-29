import type { StatusDistribution } from '@tracelayer/shared';

const SEGMENTS: { key: keyof StatusDistribution; label: string; className: string }[] = [
  { key: '2xx', label: '2xx', className: 'bg-ok' },
  { key: '3xx', label: '3xx', className: 'bg-accent' },
  { key: '4xx', label: '4xx', className: 'bg-warn' },
  { key: '5xx', label: '5xx', className: 'bg-fail' },
  { key: 'noResponse', label: 'No response', className: 'bg-fg-subtle' },
];

/** Share of runs per status class. The legend carries the numbers; colour is secondary. */
export function StatusDistributionBar({ distribution }: { distribution: StatusDistribution }) {
  const total = SEGMENTS.reduce((sum, s) => sum + distribution[s.key], 0);
  if (total === 0) return <p className="text-sm text-fg-subtle">No runs in this period.</p>;

  return (
    <div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        {SEGMENTS.map((s) =>
          distribution[s.key] > 0 ? (
            <div
              key={s.key}
              className={s.className}
              style={{ width: `${(distribution[s.key] / total) * 100}%` }}
            />
          ) : null,
        )}
      </div>
      <ul
        aria-label="Status code distribution"
        className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs"
      >
        {SEGMENTS.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${s.className}`} aria-hidden="true" />
            <span className="text-fg-muted">{s.label}</span>
            <span className="font-mono tabular-nums">{distribution[s.key]}</span>
            <span className="text-fg-subtle">
              ({Math.round((distribution[s.key] / total) * 100)}%)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
