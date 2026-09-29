import type { Request, Response } from 'express';
import {
  createMonitorSchema,
  listMonitorsQuerySchema,
  monitorRunsQuerySchema,
  updateMonitorSchema,
  type ApiSuccessBody,
} from '@tracelayer/shared';
import { getAuthUserId } from '../middleware/auth';
import { authorizeMonitor, authorizeProject, parseId } from '../services/access.service';
import * as monitorService from '../services/monitor.service';

function send<T>(res: Response, data: T, status = 200): void {
  const body: ApiSuccessBody<T> = { success: true, data };
  res.status(status).json(body);
}

function monitorAccess(req: Request, permission: 'workspace.read' | 'monitoring.manage') {
  return authorizeMonitor(getAuthUserId(req), parseId(req.params.monitorId, 'Monitor'), permission);
}

export async function list(req: Request, res: Response): Promise<void> {
  const { projectId } = listMonitorsQuerySchema.parse(req.query);
  const access = await authorizeProject(getAuthUserId(req), projectId, 'workspace.read');
  send(res, await monitorService.listMonitors(access));
}

export async function create(req: Request, res: Response): Promise<void> {
  const { projectId, ...input } = createMonitorSchema.parse(req.body);
  const access = await authorizeProject(getAuthUserId(req), projectId, 'monitoring.manage');
  send(res, await monitorService.createMonitor(access, input), 201);
}

export async function get(req: Request, res: Response): Promise<void> {
  send(res, await monitorService.getMonitor(await monitorAccess(req, 'workspace.read')));
}

export async function update(req: Request, res: Response): Promise<void> {
  const changes = updateMonitorSchema.parse(req.body);
  send(
    res,
    await monitorService.updateMonitor(await monitorAccess(req, 'monitoring.manage'), changes),
  );
}

export async function remove(req: Request, res: Response): Promise<void> {
  await monitorService.deleteMonitor(await monitorAccess(req, 'monitoring.manage'));
  res.status(204).end();
}

/** 202: the check is queued; the run appears once the worker has executed it. */
export async function runNow(req: Request, res: Response): Promise<void> {
  await monitorService.runMonitorNow(await monitorAccess(req, 'monitoring.manage'));
  send(res, { queued: true }, 202);
}

export async function runs(req: Request, res: Response): Promise<void> {
  const query = monitorRunsQuerySchema.parse(req.query);
  send(res, await monitorService.listRuns(await monitorAccess(req, 'workspace.read'), query));
}
