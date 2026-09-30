import type { Request, Response } from 'express';
import {
  dependencyMapQuerySchema,
  saveDependencyMapSchema,
  type ApiSuccessBody,
} from '@tracelayer/shared';
import { getAuthUserId } from '../middleware/auth';
import { authorizeProject } from '../services/access.service';
import * as dependencyService from '../services/dependency.service';

function send<T>(res: Response, data: T, status = 200): void {
  const body: ApiSuccessBody<T> = { success: true, data };
  res.status(status).json(body);
}

export async function getMap(req: Request, res: Response): Promise<void> {
  const { projectId } = dependencyMapQuerySchema.parse(req.query);
  const access = await authorizeProject(getAuthUserId(req), projectId, 'workspace.read');
  send(res, await dependencyService.getMap(access));
}

export async function saveMap(req: Request, res: Response): Promise<void> {
  const input = saveDependencyMapSchema.parse(req.body);
  // The map documents the monitored system: owners, admins and members edit it.
  const access = await authorizeProject(getAuthUserId(req), input.projectId, 'monitoring.manage');
  send(res, await dependencyService.saveMap(access, input));
}

export async function suggest(req: Request, res: Response): Promise<void> {
  const { projectId } = dependencyMapQuerySchema.parse(req.query);
  const access = await authorizeProject(getAuthUserId(req), projectId, 'monitoring.manage');
  send(res, await dependencyService.suggest(access));
}
