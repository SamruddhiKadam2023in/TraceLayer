import type { Request, Response } from 'express';
import { metricsQuerySchema, type ApiSuccessBody } from '@tracelayer/shared';
import { getAuthUserId } from '../middleware/auth';
import { authorizeProject } from '../services/access.service';
import * as metricsService from '../services/metrics.service';

function send<T>(res: Response, data: T): void {
  const body: ApiSuccessBody<T> = { success: true, data };
  res.json(body);
}

/** Every metrics endpoint is scoped to one project the caller can read. */
async function parse(req: Request) {
  const { projectId, range, ...filters } = metricsQuerySchema.parse(req.query);
  const access = await authorizeProject(getAuthUserId(req), projectId, 'workspace.read');
  return { access, range, filters };
}

export async function overview(req: Request, res: Response): Promise<void> {
  const { access, range, filters } = await parse(req);
  send(res, await metricsService.getOverview(access, range, filters));
}

export async function summary(req: Request, res: Response): Promise<void> {
  const { access, range, filters } = await parse(req);
  send(res, await metricsService.getSummary(access, range, filters));
}

export async function latency(req: Request, res: Response): Promise<void> {
  const { access, range, filters } = await parse(req);
  send(res, await metricsService.getLatencySeries(access, range, filters));
}

export async function errors(req: Request, res: Response): Promise<void> {
  const { access, range, filters } = await parse(req);
  send(res, await metricsService.getErrorSeries(access, range, filters));
}
