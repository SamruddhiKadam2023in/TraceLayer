import { Router } from 'express';
import * as incidentController from '../controllers/incident.controller';
import { requireAuth } from '../middleware/auth';
import { createIncidentRateLimiters } from '../middleware/rate-limit';

/** Incidents and their timelines (spec §26–27, §37). */
export function createIncidentRouter(): Router {
  const limiters = createIncidentRateLimiters();
  const router = Router();
  router.use(requireAuth);

  router.get('/', incidentController.listIncidents);
  router.get('/:incidentId', incidentController.getIncident);
  router.patch('/:incidentId', incidentController.updateIncident);
  // Comments are the only timeline entries people write directly.
  router.post('/:incidentId/events', limiters.comment, incidentController.addComment);

  return router;
}
