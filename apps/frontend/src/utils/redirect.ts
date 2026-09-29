/** Router state carried to /login so the user returns to the page they asked for. */
export interface RedirectState {
  from?: string;
}

/** Only same-app paths are accepted, so `from` cannot become an open redirect. */
export function safeRedirectTarget(state: unknown): string {
  const from = (state as RedirectState | null)?.from;
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/';
}
