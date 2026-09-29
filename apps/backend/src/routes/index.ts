import { Router } from 'express';
import { healthRouter } from './health.routes';
import { createAuthRouter } from './auth.routes';
import { createWorkspaceRouter } from './workspace.routes';
import { createProjectRouter } from './project.routes';
import { createEndpointRouter } from './endpoint.routes';
import { createRequestRouter } from './request.routes';
import { createMonitorRouter } from './monitor.routes';
import { createMetricsRouter } from './metrics.routes';
import { createAlertRouter, createChannelRouter } from './alert.routes';

export function createApiRouter(): Router {
  const router = Router();
  router.use('/health', healthRouter);
  router.use('/auth', createAuthRouter());
  router.use('/workspaces', createWorkspaceRouter());
  router.use('/projects', createProjectRouter());
  router.use('/endpoints', createEndpointRouter());
  router.use('/requests', createRequestRouter());
  router.use('/monitors', createMonitorRouter());
  router.use('/metrics', createMetricsRouter());
  router.use('/alerts', createAlertRouter());
  router.use('/notification-channels', createChannelRouter());
  return router;
}
