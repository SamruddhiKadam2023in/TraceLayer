import { useId, type ReactNode } from 'react';

interface ChartCardProps {
  title: string;
  /** One sentence describing the data, read by screen readers in place of the picture. */
  summary: string;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** True when the data has nothing to show (renders `emptyMessage`). */
  empty: boolean;
  emptyMessage?: string;
  /** Shown top-right, e.g. a legend. */
  aside?: ReactNode;
  children: ReactNode;
}

/**
 * A chart panel with the four states every dashboard component needs (spec §43):
 * loading skeleton, error with retry, empty message, and the data.
 */
export function ChartCard({
  title,
  summary,
  loading,
  error,
  onRetry,
  empty,
  emptyMessage = 'No data in this period.',
  aside,
  children,
}: ChartCardProps) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="rounded-lg border border-line bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 id={titleId} className="text-sm font-semibold">
          {title}
        </h3>
        {aside}
      </div>
      {error ? (
        <div
          role="alert"
          className="flex h-48 flex-col items-center justify-center gap-2 text-center"
        >
          <p className="text-sm text-fg-muted">{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg"
          >
            Retry
          </button>
        </div>
      ) : loading ? (
        <div aria-hidden="true" className="h-48 animate-pulse rounded-md bg-surface-2" />
      ) : empty ? (
        <p className="flex h-48 items-center justify-center text-sm text-fg-subtle">
          {emptyMessage}
        </p>
      ) : (
        <figure role="img" aria-label={summary} className="h-48">
          {children}
        </figure>
      )}
    </section>
  );
}
