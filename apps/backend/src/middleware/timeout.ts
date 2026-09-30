import type { Server } from 'node:http';
import type { RequestHandler } from 'express';
import { MAX_TIMEOUT_MS } from '@tracelayer/shared';
import { AppError } from '../utils/errors';

/**
 * Longest a request may take before the client gets 504. Above the longest executed request
 * (MAX_TIMEOUT_MS) so "Send" and "Run now" always finish or time out on their own terms first.
 */
export const RESPONSE_TIMEOUT_MS = MAX_TIMEOUT_MS + 15_000;

/**
 * Answers 504 if a handler has not responded in time (a stuck database call, a hung
 * dependency), so clients and the proxy never wait forever. The handler's late result is dropped.
 */
export function responseTimeout(ms = RESPONSE_TIMEOUT_MS): RequestHandler {
  return (_req, res, next) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) next(new AppError('TIMEOUT', 'The server took too long to respond'));
    }, ms);
    const clear = () => clearTimeout(timer);
    res.once('finish', clear);
    res.once('close', clear);
    next();
  };
}

/**
 * Socket-level limits (spec §40 "request timeouts"): slow clients cannot hold connections open
 * by trickling headers or a body (slowloris).
 */
export function applyServerTimeouts(server: Server): void {
  server.headersTimeout = 20_000;
  server.requestTimeout = RESPONSE_TIMEOUT_MS + 5_000;
  // Longer than the proxy's idle timeout, so the proxy (not Node) closes idle connections.
  server.keepAliveTimeout = 65_000;
}
