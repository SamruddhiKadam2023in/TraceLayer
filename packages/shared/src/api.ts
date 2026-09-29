/** Error codes returned in the `error.code` field of every failed API response. */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'UPSTREAM_ERROR',
  'TIMEOUT',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown[];
    requestId?: string;
  };
}

export interface ApiSuccessBody<T> {
  success: true;
  data: T;
}

export type ApiResponse<T> = ApiSuccessBody<T> | ApiErrorBody;

export type DependencyStatus = 'up' | 'down';

export interface DependencyHealth {
  status: DependencyStatus;
  latencyMs: number | null;
  error?: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  dependencies: {
    database: DependencyHealth;
    redis: DependencyHealth;
    worker: DependencyHealth & { lastHeartbeatAt: string | null };
  };
}
