import { Router } from 'express';
import * as metricsController from '../controllers/metrics.controller';
import { requireAuth } from '../middleware/auth';
import { createMetricsRateLimiters } from '../middleware/rate-limit';

export function createMetricsRouter(): Router {
  const limiters = createMetricsRateLimiters();
  const router = Router();
  // Aggregations over up to 30 days of runs: authenticated and rate-limited (spec §41).
  router.use(requireAuth, limiters.metrics);

  router.get('/', metricsController.overview);
  router.get('/summary', metricsController.summary);
  router.get('/latency', metricsController.latency);
  router.get('/errors', metricsController.errors);

  return router;
}
