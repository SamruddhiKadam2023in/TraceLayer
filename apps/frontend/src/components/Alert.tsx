import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';

/** An error message that screen readers announce as soon as it appears. */
export function ErrorAlert({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-fail/30 bg-fail-soft px-3 py-2 text-sm text-fail"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}
