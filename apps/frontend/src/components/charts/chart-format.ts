import type { MetricRange } from '@tracelayer/shared';

const SHORT_RANGES: MetricRange[] = ['1h', '6h', '24h'];

/** Axis labels: clock time for short ranges, day (and hour) for long ones. */
export function formatTick(iso: string, range: MetricRange): string {
  const date = new Date(iso);
  if (SHORT_RANGES.includes(range)) {
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Tooltip heading: always precise. */
export function formatTooltipTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}
