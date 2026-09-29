import { Router } from 'express';
import * as endpointController from '../controllers/endpoint.controller';
import { requireAuth } from '../middleware/auth';
import { createEndpointRateLimiters } from '../middleware/rate-limit';

/** Access is checked in the controller: list/create by project, the rest by endpoint. */
export function createEndpointRouter(): Router {
  const limiters = createEndpointRateLimiters();
  const router = Router();
  router.use(requireAuth);

  router.get('/', endpointController.list);
  router.post('/', limiters.createEndpoint, endpointController.create);
  router.get('/:endpointId', endpointController.get);
  router.patch('/:endpointId', endpointController.update);
  router.delete('/:endpointId', endpointController.remove);

  return router;
}
