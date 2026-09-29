import { isAxiosError } from 'axios';
import type { ApiErrorBody } from '@tracelayer/shared';

export type ApiError = ApiErrorBody['error'];

export const NETWORK_ERROR_MESSAGE =
  'Cannot reach the TraceLayer API. Check your connection and try again.';

/** The structured error from a failed API call, or a synthetic one for network failures. */
export function toApiError(err: unknown): ApiError {
  if (isAxiosError<ApiErrorBody>(err)) {
    const body = err.response?.data;
    if (body && body.success === false && body.error) return body.error;
    if (!err.response) return { code: 'INTERNAL_ERROR', message: NETWORK_ERROR_MESSAGE };
  }
  return { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' };
}

/** Field errors from a VALIDATION_ERROR or CONFLICT response, keyed by field path. */
export function fieldErrors(error: ApiError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const detail of error.details ?? []) {
    if (
      typeof detail === 'object' &&
      detail !== null &&
      'path' in detail &&
      'message' in detail &&
      typeof detail.path === 'string' &&
      typeof detail.message === 'string'
    ) {
      result[detail.path] ??= detail.message;
    }
  }
  return result;
}
