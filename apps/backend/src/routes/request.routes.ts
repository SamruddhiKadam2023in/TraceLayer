import { Router } from 'express';
import * as requestController from '../controllers/request.controller';
import { requireAuth } from '../middleware/auth';
import { createRequestRateLimiters } from '../middleware/rate-limit';

export function createRequestRouter(): Router {
  const limiters = createRequestRateLimiters();
  const router = Router();
  router.use(requireAuth);

  router.post('/execute', limiters.execute, requestController.execute);
  router.get('/history', requestController.history);

  return router;
}
