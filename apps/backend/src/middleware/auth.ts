import type { Request, RequestHandler } from 'express';
import { verifyAccessToken } from '../services/token.service';
import { AppError } from '../utils/errors';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requireAuth` once the bearer token has been verified. */
      auth?: { userId: string };
    }
  }
}

/** Rejects the request with 401 unless it carries a valid `Authorization: Bearer` access token. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  const match = header?.match(/^Bearer ([^\s]+)$/i);
  if (!match?.[1]) throw AppError.unauthenticated();
  req.auth = { userId: verifyAccessToken(match[1]) };
  next();
};

/** The authenticated user's id. Only valid in handlers mounted behind `requireAuth`. */
export function getAuthUserId(req: Request): string {
  if (!req.auth) throw AppError.unauthenticated();
  return req.auth.userId;
}
