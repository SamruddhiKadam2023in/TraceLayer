import { Router } from 'express';
import * as monitorController from '../controllers/monitor.controller';
import { requireAuth } from '../middleware/auth';
import { createMonitorRateLimiters } from '../middleware/rate-limit';

export function createMonitorRouter(): Router {
  const limiters = createMonitorRateLimiters();
  const router = Router();
  router.use(requireAuth);

  router.get('/', monitorController.list);
  router.post('/', limiters.createMonitor, monitorController.create);
  router.get('/:monitorId', monitorController.get);
  router.patch('/:monitorId', monitorController.update);
  router.delete('/:monitorId', monitorController.remove);
  router.post('/:monitorId/run', limiters.runMonitor, monitorController.runNow);
  router.get('/:monitorId/runs', monitorController.runs);

  return router;
}
