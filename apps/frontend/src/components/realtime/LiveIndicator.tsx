import { useRealtimeStore, type RealtimeStatus } from '@/services/realtime';

const STATES: Record<RealtimeStatus, { label: string; dot: string; title: string }> = {
  live: {
    label: 'Live',
    dot: 'bg-ok',
    title: 'Monitors and incidents update as they happen.',
  },
  connecting: {
    label: 'Connecting…',
    dot: 'bg-warn animate-pulse',
    title: 'Reconnecting for live updates.',
  },
  offline: {
    label: 'Offline',
    dot: 'bg-fg-subtle',
    title: 'Live updates are unavailable; pages refresh on their own schedule.',
  },
};

/** Connection state for live updates, as text plus a dot (never colour alone). */
export function LiveIndicator() {
  const status = useRealtimeStore((s) => s.status);
  const { label, dot, title } = STATES[status];
  return (
    <span
      role="status"
      title={title}
      className="hidden items-center gap-1.5 rounded-md px-2 py-1 text-xs text-fg-muted sm:inline-flex"
    >
      <span className={`size-2 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}
