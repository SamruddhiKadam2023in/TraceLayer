import type { HttpMethod } from '@tracelayer/shared';

// Colour is a secondary cue only: the method name is always written out.
const TONES: Record<HttpMethod, string> = {
  GET: 'text-ok',
  POST: 'text-accent',
  PUT: 'text-warn',
  PATCH: 'text-warn',
  DELETE: 'text-fail',
  HEAD: 'text-fg-muted',
  OPTIONS: 'text-fg-muted',
};

/** `aligned` gives every method the same width, so names line up in lists. */
export function MethodBadge({ method, aligned = true }: { method: HttpMethod; aligned?: boolean }) {
  return (
    <span
      className={`inline-block font-mono text-xs font-semibold ${aligned ? 'w-16' : ''} ${TONES[method]}`}
    >
      {method}
    </span>
  );
}
