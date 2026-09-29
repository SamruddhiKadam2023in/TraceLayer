import type { Request, Response } from 'express';
import {
  addMemberSchema,
  createWorkspaceSchema,
  updateMemberSchema,
  updateWorkspaceSchema,
  type ApiSuccessBody,
} from '@tracelayer/shared';
import { getAuthUserId } from '../middleware/auth';
import { getWorkspaceAccess } from '../middleware/workspace-access';
import { parseId } from '../services/access.service';
import * as memberService from '../services/member.service';
import * as workspaceService from '../services/workspace.service';

function send<T>(res: Response, data: T, status = 200): void {
  const body: ApiSuccessBody<T> = { success: true, data };
  res.status(status).json(body);
}

// ─── Workspaces ──────────────────────────────────────────────────────────────

export async function list(req: Request, res: Response): Promise<void> {
  send(res, await workspaceService.listWorkspaces(getAuthUserId(req)));
}

export async function create(req: Request, res: Response): Promise<void> {
  const { name } = createWorkspaceSchema.parse(req.body);
  send(res, await workspaceService.createWorkspace(getAuthUserId(req), name), 201);
}

export async function get(req: Request, res: Response): Promise<void> {
  send(res, await workspaceService.getWorkspace(getWorkspaceAccess(req)));
}

export async function update(req: Request, res: Response): Promise<void> {
  const { name } = updateWorkspaceSchema.parse(req.body);
  send(res, await workspaceService.renameWorkspace(getWorkspaceAccess(req), name));
}

export async function remove(req: Request, res: Response): Promise<void> {
  await workspaceService.deleteWorkspace(getWorkspaceAccess(req));
  res.status(204).end();
}

// ─── Members ─────────────────────────────────────────────────────────────────
// Member mutations authorize inside a locked transaction (see member.service), so they take
// the ids straight from the route rather than from `requireWorkspace`.

export async function listMembers(req: Request, res: Response): Promise<void> {
  send(res, await memberService.listMembers(getWorkspaceAccess(req).workspaceId));
}

export async function addMember(req: Request, res: Response): Promise<void> {
  const workspaceId = parseId(req.params.workspaceId, 'Workspace');
  const input = addMemberSchema.parse(req.body);
  send(res, await memberService.addMember(workspaceId, getAuthUserId(req), input), 201);
}

export async function updateMember(req: Request, res: Response): Promise<void> {
  const workspaceId = parseId(req.params.workspaceId, 'Workspace');
  const targetUserId = parseId(req.params.userId, 'Member');
  const { role } = updateMemberSchema.parse(req.body);
  send(
    res,
    await memberService.updateMemberRole(workspaceId, getAuthUserId(req), targetUserId, role),
  );
}

export async function removeMember(req: Request, res: Response): Promise<void> {
  const workspaceId = parseId(req.params.workspaceId, 'Workspace');
  const targetUserId = parseId(req.params.userId, 'Member');
  await memberService.removeMember(workspaceId, getAuthUserId(req), targetUserId);
  res.status(204).end();
}
