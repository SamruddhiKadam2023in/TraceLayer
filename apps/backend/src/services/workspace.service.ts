import type { WorkspaceSummary } from '@tracelayer/shared';
import type { Workspace, WorkspaceRole } from '@tracelayer/db';
import { prisma } from '../lib/prisma';
import { monitorIdsFor, unscheduleMonitors } from './monitor-cleanup.service';
import { compareNames } from '../utils/sort';
import type { WorkspaceAccess } from './access.service';

const withMemberCount = { _count: { select: { members: true } } } as const;

function toSummary(
  workspace: Workspace & { _count: { members: number } },
  role: WorkspaceRole,
): WorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    role,
    memberCount: workspace._count.members,
    createdAt: workspace.createdAt.toISOString(),
  };
}

/** Every workspace the user belongs to, alphabetically. */
export async function listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    include: { workspace: { include: withMemberCount } },
  });
  return memberships
    .map((m) => toSummary(m.workspace, m.role))
    .sort((a, b) => compareNames(a.name, b.name));
}

/** Creates a workspace with its creator as the first owner, atomically. */
export async function createWorkspace(userId: string, name: string): Promise<WorkspaceSummary> {
  const workspace = await prisma.workspace.create({
    data: { name, members: { create: { userId, role: 'OWNER' } } },
    include: withMemberCount,
  });
  return toSummary(workspace, 'OWNER');
}

export async function getWorkspace(access: WorkspaceAccess): Promise<WorkspaceSummary> {
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: access.workspaceId },
    include: withMemberCount,
  });
  return toSummary(workspace, access.role);
}

export async function renameWorkspace(
  access: WorkspaceAccess,
  name: string,
): Promise<WorkspaceSummary> {
  const workspace = await prisma.workspace.update({
    where: { id: access.workspaceId },
    data: { name },
    include: withMemberCount,
  });
  return toSummary(workspace, access.role);
}

/** Deletes the workspace; memberships (and, later, projects) cascade in the database. */
export async function deleteWorkspace(access: WorkspaceAccess): Promise<void> {
  const monitorIds = await monitorIdsFor({ project: { workspaceId: access.workspaceId } });
  await prisma.workspace.delete({ where: { id: access.workspaceId } });
  await unscheduleMonitors(monitorIds);
}
