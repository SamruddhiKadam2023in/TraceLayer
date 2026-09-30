import type { Request, Response } from 'express';
import {
  incidentCommentSchema,
  incidentListQuerySchema,
  updateIncidentSchema,
  type ApiSuccessBody,
} from '@tracelayer/shared';
import { getAuthUserId } from '../middleware/auth';
import {
  authorizeIncident,
  authorizeMonitor,
  authorizeProject,
  authorizeWorkspace,
  parseId,
} from '../services/access.service';
import * as incidentService from '../services/incident.service';
import { AppError } from '../utils/errors';

function send<T>(res: Response, data: T, status = 200): void {
  const body: ApiSuccessBody<T> = { success: true, data };
  res.status(status).json(body);
}

const incidentAccess = (req: Request, permission: 'workspace.read' | 'incidents.manage') =>
  authorizeIncident(getAuthUserId(req), parseId(req.params.incidentId, 'Incident'), permission);

export async function listIncidents(req: Request, res: Response): Promise<void> {
  const query = incidentListQuerySchema.parse(req.query);
  const userId = getAuthUserId(req);
  const scope = query.projectId
    ? await authorizeProject(userId, query.projectId, 'workspace.read')
    : await authorizeWorkspace(userId, query.workspaceId!, 'workspace.read');
  if (query.monitorId) {
    // A monitor filter from another project or workspace is reported, not silently empty.
    const monitor = await authorizeMonitor(userId, query.monitorId, 'workspace.read');
    const outside =
      'projectId' in scope
        ? monitor.projectId !== scope.projectId
        : monitor.workspaceId !== scope.workspaceId;
    if (outside) throw AppError.notFound('Monitor');
  }
  send(res, await incidentService.listIncidents(scope, query));
}

export async function getIncident(req: Request, res: Response): Promise<void> {
  send(res, await incidentService.getIncident(await incidentAccess(req, 'workspace.read')));
}

export async function updateIncident(req: Request, res: Response): Promise<void> {
  const changes = updateIncidentSchema.parse(req.body);
  // Working on incidents: owners, admins and members. Viewers can follow along.
  const access = await incidentAccess(req, 'incidents.manage');
  send(res, await incidentService.updateIncident(access, changes));
}

export async function addComment(req: Request, res: Response): Promise<void> {
  const { message } = incidentCommentSchema.parse(req.body);
  const access = await incidentAccess(req, 'incidents.manage');
  send(res, await incidentService.addComment(access, message), 201);
}
