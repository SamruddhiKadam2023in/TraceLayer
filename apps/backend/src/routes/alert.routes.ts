import { Router } from 'express';
import * as alertController from '../controllers/alert.controller';
import { requireAuth } from '../middleware/auth';
import { createAlertRateLimiters } from '../middleware/rate-limit';

/** Alert rules and fired alerts (spec §37 names rules "alerts"). */
export function createAlertRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', alertController.listRules);
  router.post('/', alertController.createRule);
  // Registered before /:ruleId so "fired" is not read as an id.
  router.get('/fired', alertController.listFired);
  router.get('/:ruleId', alertController.getRule);
  router.patch('/:ruleId', alertController.updateRule);
  router.delete('/:ruleId', alertController.deleteRule);

  return router;
}

export function createChannelRouter(): Router {
  const limiters = createAlertRateLimiters();
  const router = Router();
  router.use(requireAuth);

  router.get('/', alertController.listChannels);
  router.post('/', alertController.createChannel);
  router.patch('/:channelId', alertController.updateChannel);
  router.delete('/:channelId', alertController.deleteChannel);
  // Sends a real email, so it is rate-limited.
  router.post('/:channelId/test', limiters.testChannel, alertController.testChannel);

  return router;
}
