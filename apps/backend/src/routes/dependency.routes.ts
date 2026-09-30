import { Router } from 'express';
import * as dependencyController from '../controllers/dependency.controller';
import { requireAuth } from '../middleware/auth';
import { createDependencyRateLimiters } from '../middleware/rate-limit';

/**
 * A project's dependency map (spec §30). The editor saves the whole diagram at once, so a save
 * is atomic and versioned instead of many single-node calls.
 */
export function createDependencyRouter(): Router {
  const limiters = createDependencyRateLimiters();
  const router = Router();
  router.use(requireAuth);

  router.get('/', dependencyController.getMap);
  router.put('/', limiters.save, dependencyController.saveMap);
  router.get('/suggestions', dependencyController.suggest);

  return router;
}
