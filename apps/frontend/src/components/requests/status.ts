import type { StatusTone } from '@/components/StatusBadge';

/** Status tone by class: 2xx healthy, 3xx/4xx degraded, 5xx and network errors failing. */
export function statusTone(status: number | null): StatusTone {
  if (status === null || status >= 500) return 'failing';
  if (status >= 300) return 'degraded';
  return 'healthy';
}

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export function statusLabel(status: number): string {
  const reason = REASONS[status];
  return reason ? `${status} ${reason}` : String(status);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const ERROR_LABELS: Record<string, string> = {
  BLOCKED_TARGET: 'Blocked',
  TIMEOUT: 'Timed out',
  DNS_FAILURE: 'DNS failure',
  CONNECTION_REFUSED: 'Connection refused',
  CONNECTION_RESET: 'Connection reset',
  TLS_ERROR: 'TLS error',
  INVALID_RESPONSE: 'Invalid response',
  REQUEST_FAILED: 'Request failed',
};
