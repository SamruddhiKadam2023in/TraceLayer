import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@tracelayer/shared';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError('NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError(
      'VALIDATION_ERROR',
      'Request validation failed',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  const bodyErr = err as BodyParserError;
  if (bodyErr?.type === 'entity.too.large') {
    return new AppError('PAYLOAD_TOO_LARGE', 'Request body is too large');
  }
  if (bodyErr?.type === 'entity.parse.failed') {
    return new AppError('VALIDATION_ERROR', 'Malformed JSON body');
  }
  return null;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // A response already went out (e.g. a handler failed after a timeout answered): just record it.
  if (res.headersSent) {
    logger.warn({ err, method: req.method, path: req.path }, 'Error after the response was sent');
    return;
  }
  const appError = toAppError(err);
  const requestId = typeof req.id === 'string' ? req.id : undefined;

  if (!appError) {
    // Full detail stays server-side; clients get a generic message with no stack trace.
    logger.error({ err, requestId, method: req.method, path: req.path }, 'Unhandled error');
  }

  const error = appError ?? new AppError('INTERNAL_ERROR', 'An unexpected error occurred');
  const body: ApiErrorBody = {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      ...(requestId ? { requestId } : {}),
    },
  };
  res.status(error.statusCode).json(body);
};
