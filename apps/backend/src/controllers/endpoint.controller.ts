import type { Request, Response } from 'express';
import {
  createEndpointSchema,
  listEndpointsQuerySchema,
  updateEndpointSchema,
  type ApiSuccessBody,
} from '@tracelayer/shared';
import { getAuthUserId } from '../middleware/auth';
import { authorizeEndpoint, authorizeProject, parseId } from '../services/access.service';
import * as endpointService from '../services/endpoint.service';

function send<T>(res: Response, data: T, status = 200): void {
  const body: ApiSuccessBody<T> = { success: true, data };
  res.status(status).json(body);
}

function endpointId(req: Request): string {
  return parseId(req.params.endpointId, 'Endpoint');
}

export async function list(req: Request, res: Response): Promise<void> {
  const { projectId, ...filters } = listEndpointsQuerySchema.parse(req.query);
  const access = await authorizeProject(getAuthUserId(req), projectId, 'workspace.read');
  send(res, await endpointService.listEndpoints(access, filters));
}

export async function create(req: Request, res: Response): Promise<void> {
  const { projectId, ...config } = createEndpointSchema.parse(req.body);
  const access = await authorizeProject(getAuthUserId(req), projectId, 'monitoring.manage');
  send(res, await endpointService.createEndpoint(access, config), 201);
}

export async function get(req: Request, res: Response): Promise<void> {
  const access = await authorizeEndpoint(getAuthUserId(req), endpointId(req), 'workspace.read');
  send(res, await endpointService.getEndpoint(access));
}

export async function update(req: Request, res: Response): Promise<void> {
  const changes = updateEndpointSchema.parse(req.body);
  const access = await authorizeEndpoint(getAuthUserId(req), endpointId(req), 'monitoring.manage');
  send(res, await endpointService.updateEndpoint(access, changes));
}

export async function remove(req: Request, res: Response): Promise<void> {
  const access = await authorizeEndpoint(getAuthUserId(req), endpointId(req), 'monitoring.manage');
  await endpointService.deleteEndpoint(access);
  res.status(204).end();
}
