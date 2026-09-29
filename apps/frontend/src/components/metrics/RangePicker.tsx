import { METRIC_RANGES, RANGE_CONFIG, type MetricRange } from '@tracelayer/shared';

/** Segmented control for the metrics time range (radio semantics for assistive tech). */
export function RangePicker({
  value,
  onChange,
}: {
  value: MetricRange;
  onChange: (range: MetricRange) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Time range"
      className="inline-flex rounded-md border border-line p-0.5"
    >
      {METRIC_RANGES.map((range) => (
        <button
          key={range}
          type="button"
          role="radio"
          aria-checked={value === range}
          title={RANGE_CONFIG[range].label}
          onClick={() => onChange(range)}
          className={`rounded px-2.5 py-1 font-mono text-xs ${
            value === range ? 'bg-surface-2 font-medium text-fg' : 'text-fg-subtle hover:text-fg'
          }`}
        >
          {range}
        </button>
      ))}
    </div>
  );
}
