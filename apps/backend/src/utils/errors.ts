import type { ErrorCode } from '@tracelayer/shared';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  TIMEOUT: 504,
  INTERNAL_ERROR: 500,
};

/** An error that is safe to show to API clients. Anything else is reported as INTERNAL_ERROR. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown[];

  constructor(code: ErrorCode, message: string, details?: unknown[]) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = details;
  }

  static notFound(resource = 'Resource'): AppError {
    return new AppError('NOT_FOUND', `${resource} not found`);
  }

  static unauthenticated(message = 'Authentication required'): AppError {
    return new AppError('UNAUTHENTICATED', message);
  }

  static forbidden(message = 'You do not have permission to perform this action'): AppError {
    return new AppError('FORBIDDEN', message);
  }
}
