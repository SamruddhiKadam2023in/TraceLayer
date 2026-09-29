import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, children, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-line px-6 py-14 text-center">
      <Icon className="size-6 text-fg-subtle" aria-hidden="true" />
      <h2 className="mt-3 text-sm font-semibold">{title}</h2>
      {children && <div className="mt-1 max-w-sm text-sm text-fg-muted">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Error panel for a failed load, with a retry. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-lg border border-line px-6 py-12 text-center"
    >
      <p className="text-sm text-fg-muted">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg"
      >
        Retry
      </button>
    </div>
  );
}
