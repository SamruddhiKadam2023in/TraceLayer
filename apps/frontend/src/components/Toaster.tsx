import { Link } from 'react-router';
import { CheckCircle2, Info, Siren, X } from 'lucide-react';
import { useToastStore, type ToastTone } from '@/stores/toast.store';

const TONE: Record<ToastTone, { Icon: typeof Info; className: string }> = {
  danger: { Icon: Siren, className: 'text-fail' },
  success: { Icon: CheckCircle2, className: 'text-ok' },
  info: { Icon: Info, className: 'text-accent' },
};

/** Transient notifications, announced politely to screen readers. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <section
      aria-label="Notifications"
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((toast) => {
        const { Icon, className } = TONE[toast.tone];
        return (
          <div
            key={toast.id}
            role="status"
            className="pointer-events-auto flex items-start gap-3 rounded-lg border border-line bg-surface p-3 shadow-lg"
          >
            <Icon className={`mt-0.5 size-4 shrink-0 ${className}`} aria-hidden="true" />
            <div className="min-w-0 flex-1 text-sm">
              {toast.href ? (
                <Link
                  to={toast.href}
                  onClick={() => dismiss(toast.id)}
                  className="font-medium hover:underline"
                >
                  {toast.title}
                </Link>
              ) : (
                <p className="font-medium">{toast.title}</p>
              )}
              {toast.body && <p className="mt-0.5 truncate text-fg-muted">{toast.body}</p>}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(toast.id)}
              className="rounded p-0.5 text-fg-subtle hover:bg-surface-2 hover:text-fg"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </section>
  );
}
