import { Router } from 'express';
import * as workspaceController from '../controllers/workspace.controller';
import { requireAuth } from '../middleware/auth';
import { createWorkspaceRateLimiters } from '../middleware/rate-limit';
import { requireWorkspace } from '../middleware/workspace-access';

export function createWorkspaceRouter(): Router {
  const limiters = createWorkspaceRateLimiters();
  const router = Router();
  router.use(requireAuth);

  router.get('/', workspaceController.list);
  router.post('/', limiters.createWorkspace, workspaceController.create);
  router.get('/:workspaceId', requireWorkspace('workspace.read'), workspaceController.get);
  router.patch('/:workspaceId', requireWorkspace('workspace.update'), workspaceController.update);
  router.delete('/:workspaceId', requireWorkspace('workspace.delete'), workspaceController.remove);

  router.get(
    '/:workspaceId/members',
    requireWorkspace('workspace.read'),
    workspaceController.listMembers,
  );
  router.post('/:workspaceId/members', limiters.addMember, workspaceController.addMember);
  router.patch('/:workspaceId/members/:userId', workspaceController.updateMember);
  router.delete('/:workspaceId/members/:userId', workspaceController.removeMember);

  return router;
}
