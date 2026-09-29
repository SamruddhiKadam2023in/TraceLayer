import type { Request, Response } from 'express';
import {
  createEnvironmentSchema,
  createProjectSchema,
  createVariableSchema,
  listProjectsQuerySchema,
  updateEnvironmentSchema,
  updateProjectSchema,
  updateVariableSchema,
  type ApiSuccessBody,
} from '@tracelayer/shared';
import { getAuthUserId } from '../middleware/auth';
import { getProjectAccess } from '../middleware/project-access';
import { authorizeWorkspace, parseId } from '../services/access.service';
import * as environmentService from '../services/environment.service';
import * as projectService from '../services/project.service';

function send<T>(res: Response, data: T, status = 200): void {
  const body: ApiSuccessBody<T> = { success: true, data };
  res.status(status).json(body);
}

// ─── Projects ────────────────────────────────────────────────────────────────

export async function list(req: Request, res: Response): Promise<void> {
  const { workspaceId } = listProjectsQuerySchema.parse(req.query);
  const access = await authorizeWorkspace(getAuthUserId(req), workspaceId, 'workspace.read');
  send(res, await projectService.listProjects(access));
}

export async function create(req: Request, res: Response): Promise<void> {
  const { workspaceId, ...input } = createProjectSchema.parse(req.body);
  const access = await authorizeWorkspace(getAuthUserId(req), workspaceId, 'projects.manage');
  send(res, await projectService.createProject(access, input), 201);
}

export async function get(req: Request, res: Response): Promise<void> {
  send(res, await projectService.getProject(getProjectAccess(req)));
}

export async function update(req: Request, res: Response): Promise<void> {
  const input = updateProjectSchema.parse(req.body);
  send(res, await projectService.updateProject(getProjectAccess(req), input));
}

export async function remove(req: Request, res: Response): Promise<void> {
  await projectService.deleteProject(getProjectAccess(req));
  res.status(204).end();
}

// ─── Environments ────────────────────────────────────────────────────────────

export async function listEnvironments(req: Request, res: Response): Promise<void> {
  send(res, await environmentService.listEnvironments(getProjectAccess(req)));
}

export async function createEnvironment(req: Request, res: Response): Promise<void> {
  const input = createEnvironmentSchema.parse(req.body);
  send(res, await environmentService.createEnvironment(getProjectAccess(req), input), 201);
}

export async function updateEnvironment(req: Request, res: Response): Promise<void> {
  const environmentId = parseId(req.params.environmentId, 'Environment');
  const input = updateEnvironmentSchema.parse(req.body);
  send(
    res,
    await environmentService.updateEnvironment(getProjectAccess(req), environmentId, input),
  );
}

export async function removeEnvironment(req: Request, res: Response): Promise<void> {
  const environmentId = parseId(req.params.environmentId, 'Environment');
  await environmentService.deleteEnvironment(getProjectAccess(req), environmentId);
  res.status(204).end();
}

// ─── Variables ───────────────────────────────────────────────────────────────

export async function createVariable(req: Request, res: Response): Promise<void> {
  const environmentId = parseId(req.params.environmentId, 'Environment');
  const input = createVariableSchema.parse(req.body);
  send(
    res,
    await environmentService.createVariable(getProjectAccess(req), environmentId, input),
    201,
  );
}

export async function updateVariable(req: Request, res: Response): Promise<void> {
  const environmentId = parseId(req.params.environmentId, 'Environment');
  const variableId = parseId(req.params.variableId, 'Variable');
  const input = updateVariableSchema.parse(req.body);
  send(
    res,
    await environmentService.updateVariable(
      getProjectAccess(req),
      environmentId,
      variableId,
      input,
    ),
  );
}

export async function removeVariable(req: Request, res: Response): Promise<void> {
  const environmentId = parseId(req.params.environmentId, 'Environment');
  const variableId = parseId(req.params.variableId, 'Variable');
  await environmentService.deleteVariable(getProjectAccess(req), environmentId, variableId);
  res.status(204).end();
}
