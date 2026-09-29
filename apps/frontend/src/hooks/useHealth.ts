import { useCallback, useEffect, useState } from 'react';
import type { HealthReport } from '@tracelayer/shared';
import { fetchHealth } from '@/services/health.service';

export const HEALTH_POLL_INTERVAL_MS = 10_000;

interface HealthState {
  report: HealthReport | null;
  /** Round-trip time of the last successful health request, as seen by the browser. */
  roundTripMs: number | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
}

export function useHealth(pollMs = HEALTH_POLL_INTERVAL_MS): HealthState {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [roundTripMs, setRoundTripMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumping this restarts the polling effect, which fetches immediately.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      const start = performance.now();
      fetchHealth()
        .then((data) => {
          if (cancelled) return;
          setReport(data);
          setRoundTripMs(Math.round(performance.now() - start));
          setError(null);
        })
        .catch(() => {
          if (cancelled) return;
          setError('Cannot reach the TraceLayer API. Check that the backend is running.');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    load();
    const timer = window.setInterval(load, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pollMs, refreshKey]);

  const refetch = useCallback(() => {
    setLoading(true);
    setRefreshKey((k) => k + 1);
  }, []);

  return { report, roundTripMs, error, loading, refetch };
}
