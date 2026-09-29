import type { Request, RequestHandler } from 'express';
import type { Permission } from '@tracelayer/shared';
import { authorizeWorkspace, parseId, type WorkspaceAccess } from '../services/access.service';
import { AppError } from '../utils/errors';
import { getAuthUserId } from './auth';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requireWorkspace` for routes under /workspaces/:workspaceId. */
      workspaceAccess?: WorkspaceAccess;
    }
  }
}

/** Requires the signed-in user to hold `permission` in the workspace named by `:workspaceId`. */
export function requireWorkspace(permission: Permission): RequestHandler {
  return async (req, _res, next) => {
    const workspaceId = parseId(req.params.workspaceId, 'Workspace');
    req.workspaceAccess = await authorizeWorkspace(getAuthUserId(req), workspaceId, permission);
    next();
  };
}

export function getWorkspaceAccess(req: Request): WorkspaceAccess {
  if (!req.workspaceAccess) throw AppError.forbidden();
  return req.workspaceAccess;
}
