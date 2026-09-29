import { Router } from 'express';
import * as projectController from '../controllers/project.controller';
import { requireAuth } from '../middleware/auth';
import { requireProject } from '../middleware/project-access';
import { createProjectRateLimiters } from '../middleware/rate-limit';

export function createProjectRouter(): Router {
  const limiters = createProjectRateLimiters();
  const read = requireProject('workspace.read');
  const manage = requireProject('projects.manage');
  const router = Router();
  router.use(requireAuth);

  // List and create are scoped by workspace (query/body); access is checked in the controller.
  router.get('/', projectController.list);
  router.post('/', limiters.createProject, projectController.create);
  router.get('/:projectId', read, projectController.get);
  router.patch('/:projectId', manage, projectController.update);
  router.delete('/:projectId', manage, projectController.remove);

  const environments = '/:projectId/environments';
  router.get(environments, read, projectController.listEnvironments);
  router.post(environments, manage, projectController.createEnvironment);
  router.patch(`${environments}/:environmentId`, manage, projectController.updateEnvironment);
  router.delete(`${environments}/:environmentId`, manage, projectController.removeEnvironment);

  const variables = `${environments}/:environmentId/variables`;
  router.post(variables, manage, projectController.createVariable);
  router.patch(`${variables}/:variableId`, manage, projectController.updateVariable);
  router.delete(`${variables}/:variableId`, manage, projectController.removeVariable);

  return router;
}
