import { FlaskConical } from 'lucide-react';

/** Marks demo data wherever a workspace is named (spec §52: never confuse it with real data). */
export function DemoBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded border border-dashed border-warn px-1 text-[11px] font-medium text-warn">
      <FlaskConical className="size-3" aria-hidden="true" />
      Demo
    </span>
  );
}

/** Explains, on every page of a demo workspace, that its data is generated. */
export function DemoBanner() {
  return (
    <div
      role="note"
      aria-label="Demo workspace"
      className="flex items-start gap-2 border-b border-warn/30 bg-warn-soft px-4 py-2 text-sm text-fg"
    >
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
      <p>
        <span className="font-medium">Demo workspace.</span> Its history, incidents and metrics are
        generated for exploring TraceLayer, not measured from real traffic. Monitors are paused so
        the history stays as generated; resume one, or send a request, to run real checks against
        the public demo APIs.
      </p>
    </div>
  );
}
