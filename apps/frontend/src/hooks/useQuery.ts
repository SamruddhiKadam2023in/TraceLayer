import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toApiError, type ApiError } from '@/utils/api-error';

interface QueryResult<T> {
  /** Data for the current key. Kept while reloading, cleared when the key changes. */
  data: T | null;
  error: ApiError | null;
  /** True while a request for the current key (or a reload) is in flight. */
  loading: boolean;
  reload: () => void;
  /** Local update after a mutation, without refetching. */
  setData: (update: (current: T) => T) => void;
}

interface Settled<T> {
  requestId: string | null;
  key: string | null;
  data: T | null;
  error: ApiError | null;
}

/**
 * Fetches data for `key` and refetches whenever the key changes. Pass `null` to skip.
 * Results of superseded requests are ignored, so fast navigation never shows stale data.
 */
export function useQuery<T>(key: string | null, fetcher: () => Promise<T>): QueryResult<T> {
  const fetcherRef = useRef(fetcher);
  useLayoutEffect(() => {
    fetcherRef.current = fetcher;
  });

  const [reloadCount, setReloadCount] = useState(0);
  const requestId = key === null ? null : `${key}#${reloadCount}`;
  const [settled, setSettled] = useState<Settled<T>>({
    requestId: null,
    key: null,
    data: null,
    error: null,
  });

  useEffect(() => {
    if (requestId === null) return;
    let cancelled = false;
    fetcherRef.current().then(
      (data) => {
        if (!cancelled) setSettled({ requestId, key, data, error: null });
      },
      (err: unknown) => {
        if (cancelled) return;
        setSettled((s) => ({
          requestId,
          key,
          data: s.key === key ? s.data : null,
          error: toApiError(err),
        }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [requestId, key]);

  const reload = useCallback(() => setReloadCount((n) => n + 1), []);
  const setData = useCallback(
    (update: (current: T) => T) =>
      setSettled((s) => (s.data === null ? s : { ...s, data: update(s.data) })),
    [],
  );

  const current = settled.key === key;
  return {
    data: current ? settled.data : null,
    error: current ? settled.error : null,
    loading: requestId !== null && settled.requestId !== requestId,
    reload,
    setData,
  };
}
