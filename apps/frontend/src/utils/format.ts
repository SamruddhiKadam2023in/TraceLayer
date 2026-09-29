export function formatLatency(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatDuration(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86_400);
  const h = Math.floor((totalSeconds % 86_400) / 3_600);
  const m = Math.floor((totalSeconds % 3_600) / 60);
  const s = totalSeconds % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour12: false });
}
