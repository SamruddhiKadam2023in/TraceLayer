import type { Request, RequestHandler } from 'express';
import type { Permission } from '@tracelayer/shared';
import { authorizeProject, parseId, type ProjectAccess } from '../services/access.service';
import { AppError } from '../utils/errors';
import { getAuthUserId } from './auth';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requireProject` for routes under /projects/:projectId. */
      projectAccess?: ProjectAccess;
    }
  }
}

/** Requires `permission` in the workspace owning the project named by `:projectId`. */
export function requireProject(permission: Permission): RequestHandler {
  return async (req, _res, next) => {
    const projectId = parseId(req.params.projectId, 'Project');
    req.projectAccess = await authorizeProject(getAuthUserId(req), projectId, permission);
    next();
  };
}

export function getProjectAccess(req: Request): ProjectAccess {
  if (!req.projectAccess) throw AppError.forbidden();
  return req.projectAccess;
}
