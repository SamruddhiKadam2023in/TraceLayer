import type { CookieOptions, Request, Response } from 'express';
import {
  loginSchema,
  registerSchema,
  type ApiSuccessBody,
  type AuthSession,
  type AuthUser,
} from '@tracelayer/shared';
import { cookieSecure } from '../config/env';
import { getAuthUserId } from '../middleware/auth';
import * as authService from '../services/auth.service';
import type { ClientInfo } from '../services/token.service';

export const REFRESH_COOKIE = 'tl_refresh';

// httpOnly: unreadable by page scripts. SameSite=Strict: never sent on cross-site requests,
// which is the CSRF defence for the cookie-authenticated refresh/logout endpoints.
// Path: the cookie only travels to the auth routes, not with every API call.
const refreshCookieBase: CookieOptions = {
  httpOnly: true,
  secure: cookieSecure,
  sameSite: 'strict',
  path: '/api/auth',
};

function clientInfo(req: Request): ClientInfo {
  return { userAgent: req.get('user-agent'), ipAddress: req.ip };
}

function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sendSession(res: Response, result: authService.SessionResult, status = 200): void {
  res.cookie(REFRESH_COOKIE, result.refreshToken.token, {
    ...refreshCookieBase,
    expires: result.refreshToken.expiresAt,
  });
  const body: ApiSuccessBody<AuthSession> = { success: true, data: result.session };
  res.status(status).json(body);
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, refreshCookieBase);
}

export async function register(req: Request, res: Response): Promise<void> {
  const { confirmPassword: _confirmed, ...input } = registerSchema.parse(req.body);
  sendSession(res, await authService.register(input, clientInfo(req)), 201);
}

export async function login(req: Request, res: Response): Promise<void> {
  const input = loginSchema.parse(req.body);
  sendSession(res, await authService.login(input, clientInfo(req)));
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const token = readRefreshCookie(req);
  try {
    if (!token) throw authService.missingSessionError();
    sendSession(res, await authService.refresh(token, clientInfo(req)));
  } catch (err) {
    // A refresh that fails for any reason leaves the browser with no usable session.
    clearRefreshCookie(res);
    throw err;
  }
}

export async function logout(req: Request, res: Response): Promise<void> {
  await authService.logout(readRefreshCookie(req));
  clearRefreshCookie(res);
  res.status(204).end();
}

export async function me(req: Request, res: Response): Promise<void> {
  const body: ApiSuccessBody<AuthUser> = {
    success: true,
    data: await authService.getCurrentUser(getAuthUserId(req)),
  };
  res.json(body);
}
