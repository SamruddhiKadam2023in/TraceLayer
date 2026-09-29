import { lazy, Suspense, type ComponentProps } from 'react';

// The charting library is the largest dependency in the app. Loading it only where charts are
// shown keeps it out of the bundle every visitor downloads first (the sign-in page included).
const AnalyticsView = lazy(() =>
  import('./AnalyticsView').then((module) => ({ default: module.AnalyticsView })),
);

function Loading() {
  return (
    <div role="status" className="flex flex-col gap-4">
      <span className="sr-only">Loading analytics</span>
      <div
        aria-hidden="true"
        className="h-20 animate-pulse rounded-lg border border-line bg-surface"
      />
      <div aria-hidden="true" className="grid gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-60 animate-pulse rounded-lg border border-line bg-surface" />
        ))}
      </div>
    </div>
  );
}

export function LazyAnalyticsView(props: ComponentProps<typeof AnalyticsView>) {
  return (
    <Suspense fallback={<Loading />}>
      <AnalyticsView {...props} />
    </Suspense>
  );
}
