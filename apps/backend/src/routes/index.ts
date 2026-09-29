import { Router } from 'express';
import { healthRouter } from './health.routes';
import { createAuthRouter } from './auth.routes';
import { createWorkspaceRouter } from './workspace.routes';
import { createProjectRouter } from './project.routes';

export function createApiRouter(): Router {
  const router = Router();
  router.use('/health', healthRouter);
  router.use('/auth', createAuthRouter());
  router.use('/workspaces', createWorkspaceRouter());
  router.use('/projects', createProjectRouter());
  return router;
}
