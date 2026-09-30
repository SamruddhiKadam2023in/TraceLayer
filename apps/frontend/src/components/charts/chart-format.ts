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

/** Axis ticks: compact, so labels never wrap in the narrow axis ("500ms", "1.2s"). */
export function formatMsTick(value: number): string {
  if (value < 1000) return `${Math.round(value)}ms`;
  const seconds = value / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}
