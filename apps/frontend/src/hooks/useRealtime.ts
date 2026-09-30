import { useEffect, useLayoutEffect, useRef } from 'react';
import { onRealtime, type RealtimeMessage } from '@/services/realtime';

/** Calls `handler` for every real-time message. The latest handler is always used. */
export function useRealtimeListener(handler: (message: RealtimeMessage) => void): void {
  const ref = useRef(handler);
  useLayoutEffect(() => {
    ref.current = handler;
  });
  useEffect(() => onRealtime((message) => ref.current(message)), []);
}

/**
 * Reloads data when a matching event arrives (and after a reconnect), at most once per
 * `minIntervalMs`: a burst of checks becomes one refetch, and the last event of a burst is
 * never lost.
 */
export function useRealtimeRefresh(
  matches: (message: RealtimeMessage) => boolean,
  reload: () => void,
  minIntervalMs = 3000,
): void {
  const last = useRef(0);
  const pending = useRef<number | null>(null);
  const reloadRef = useRef(reload);
  useLayoutEffect(() => {
    reloadRef.current = reload;
  });
  useEffect(
    () => () => {
      if (pending.current !== null) window.clearTimeout(pending.current);
    },
    [],
  );

  useRealtimeListener((message) => {
    if (message.event !== 'resync' && !matches(message)) return;
    if (pending.current !== null) return;
    const wait = Math.max(0, last.current + minIntervalMs - Date.now());
    pending.current = window.setTimeout(() => {
      pending.current = null;
      last.current = Date.now();
      reloadRef.current();
    }, wait);
  });
}
