import { Activity } from 'lucide-react';

export function Logo() {
  return (
    <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
      <Activity className="size-4 text-accent" aria-hidden="true" />
      TraceLayer
    </span>
  );
}
