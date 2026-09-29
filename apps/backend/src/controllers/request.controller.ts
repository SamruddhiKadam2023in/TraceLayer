import type { Request, Response } from 'express';
import { executeRequestSchema, historyQuerySchema, type ApiSuccessBody } from '@tracelayer/shared';
import { getAuthUserId } from '../middleware/auth';
import { authorizeProject } from '../services/access.service';
import * as requestService from '../services/request.service';

function send<T>(res: Response, data: T, status = 200): void {
  const body: ApiSuccessBody<T> = { success: true, data };
  res.status(status).json(body);
}

/**
 * Sends a request through the platform. Needs `monitoring.manage`: running a request uses the
 * environment's secrets, so viewers (read-only) may not.
 */
export async function execute(req: Request, res: Response): Promise<void> {
  const { projectId, ...input } = executeRequestSchema.parse(req.body);
  const access = await authorizeProject(getAuthUserId(req), projectId, 'monitoring.manage');
  send(res, await requestService.runRequest(access, input));
}

export async function history(req: Request, res: Response): Promise<void> {
  const { projectId, ...query } = historyQuerySchema.parse(req.query);
  const access = await authorizeProject(getAuthUserId(req), projectId, 'workspace.read');
  send(res, await requestService.listHistory(access, query));
}
