import type { Request, Response } from 'express';
import { metricsQuerySchema, type ApiSuccessBody } from '@tracelayer/shared';
import { getAuthUserId } from '../middleware/auth';
import { authorizeProject, authorizeWorkspace } from '../services/access.service';
import * as metricsService from '../services/metrics.service';

function send<T>(res: Response, data: T): void {
  const body: ApiSuccessBody<T> = { success: true, data };
  res.json(body);
}

/** Scoped to one project, or a whole workspace, that the caller can read. */
async function parse(req: Request) {
  const { projectId, workspaceId, range, ...filters } = metricsQuerySchema.parse(req.query);
  const userId = getAuthUserId(req);
  // The schema guarantees exactly one of the two ids.
  const scope: metricsService.MetricsScope = projectId
    ? { projectId: (await authorizeProject(userId, projectId, 'workspace.read')).projectId }
    : {
        workspaceId: (await authorizeWorkspace(userId, workspaceId ?? '', 'workspace.read'))
          .workspaceId,
      };
  return { scope, range, filters };
}

export async function overview(req: Request, res: Response): Promise<void> {
  const { scope, range, filters } = await parse(req);
  send(res, await metricsService.getOverview(scope, range, filters));
}

export async function summary(req: Request, res: Response): Promise<void> {
  const { scope, range, filters } = await parse(req);
  send(res, await metricsService.getSummary(scope, range, filters));
}

export async function latency(req: Request, res: Response): Promise<void> {
  const { scope, range, filters } = await parse(req);
  send(res, await metricsService.getLatencySeries(scope, range, filters));
}

export async function errors(req: Request, res: Response): Promise<void> {
  const { scope, range, filters } = await parse(req);
  send(res, await metricsService.getErrorSeries(scope, range, filters));
}
