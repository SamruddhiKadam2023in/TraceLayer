import { Loader2 } from 'lucide-react';

export function FullPageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex min-h-dvh items-center justify-center">
      <Loader2 className="size-5 animate-spin text-fg-subtle" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </div>
  );
}
