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

export function MethodBadge({ method }: { method: HttpMethod }) {
  return (
    <span className={`inline-block w-16 font-mono text-xs font-semibold ${TONES[method]}`}>
      {method}
    </span>
  );
}
