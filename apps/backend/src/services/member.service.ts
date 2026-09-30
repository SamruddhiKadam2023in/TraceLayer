import type { Prisma, WorkspaceRole } from '@tracelayer/db';
import {
  assignableRoles,
  canManageMember,
  hasPermission,
  WORKSPACE_ROLES,
  type AddMemberInput,
  type WorkspaceMemberView,
} from '@tracelayer/shared';
import { prisma } from '../lib/prisma';
import { revokeWorkspaceAccess } from '../lib/realtime';
import { AppError } from '../utils/errors';
import { compareNames } from '../utils/sort';

interface LockedMember {
  user_id: string;
  role: WorkspaceRole;
}

const LAST_OWNER_MESSAGE = 'A workspace must always have at least one owner';

/**
 * Runs a membership change with every member row of the workspace locked (SELECT … FOR UPDATE).
 * Changes to one workspace's members are therefore serialized: two owners demoting each other
 * at the same moment cannot both succeed and leave the workspace without an owner.
 * Permissions are checked against the locked rows, i.e. against the actor's role right now.
 */
async function withLockedMembers<T>(
  workspaceId: string,
  actorUserId: string,
  fn: (
    tx: Prisma.TransactionClient,
    members: LockedMember[],
    actorRole: WorkspaceRole,
  ) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const members = await tx.$queryRaw<LockedMember[]>`
      SELECT user_id::text AS user_id, role::text AS role
      FROM workspace_members
      WHERE workspace_id = ${workspaceId}::uuid
      FOR UPDATE`;
    const actor = members.find((m) => m.user_id === actorUserId);
    if (!actor) throw AppError.notFound('Workspace');
    return fn(tx, members, actor.role);
  });
}

function findTarget(members: LockedMember[], userId: string): LockedMember {
  const target = members.find((m) => m.user_id === userId);
  if (!target) throw AppError.notFound('Member');
  return target;
}

function isLastOwner(members: LockedMember[], target: LockedMember): boolean {
  return target.role === 'OWNER' && members.filter((m) => m.role === 'OWNER').length === 1;
}

const ROLE_RANK = Object.fromEntries(WORKSPACE_ROLES.map((r, i) => [r, i])) as Record<
  WorkspaceRole,
  number
>;

export async function listMembers(workspaceId: string): Promise<WorkspaceMemberView[]> {
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    include: { user: { select: { name: true, email: true } } },
  });
  return members
    .map((m) => ({
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      joinedAt: m.createdAt.toISOString(),
    }))
    .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || compareNames(a.name, b.name));
}

/** Adds an existing TraceLayer user to the workspace. */
export async function addMember(
  workspaceId: string,
  actorUserId: string,
  input: AddMemberInput,
): Promise<WorkspaceMemberView> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true, name: true, email: true },
  });

  return withLockedMembers(workspaceId, actorUserId, async (tx, members, actorRole) => {
    if (!hasPermission(actorRole, 'members.manage')) throw AppError.forbidden();
    if (!assignableRoles(actorRole).includes(input.role)) {
      throw AppError.forbidden('Only owners can add owners');
    }
    if (!user) {
      throw new AppError('NOT_FOUND', 'No TraceLayer account uses this email', [
        { path: 'email', message: 'No TraceLayer account uses this email' },
      ]);
    }
    if (members.some((m) => m.user_id === user.id)) {
      throw new AppError('CONFLICT', 'This user is already a member', [
        { path: 'email', message: 'This user is already a member' },
      ]);
    }

    const member = await tx.workspaceMember.create({
      data: { workspaceId, userId: user.id, role: input.role },
    });
    return {
      userId: user.id,
      name: user.name,
      email: user.email,
      role: member.role,
      joinedAt: member.createdAt.toISOString(),
    };
  });
}

export async function updateMemberRole(
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
  role: WorkspaceRole,
): Promise<WorkspaceMemberView> {
  await withLockedMembers(workspaceId, actorUserId, async (tx, members, actorRole) => {
    if (!hasPermission(actorRole, 'members.manage')) throw AppError.forbidden();
    const target = findTarget(members, targetUserId);
    if (!canManageMember(actorRole, target.role)) {
      throw AppError.forbidden('Only owners can change an owner');
    }
    if (!assignableRoles(actorRole).includes(role)) {
      throw AppError.forbidden('Only owners can make someone an owner');
    }
    if (role !== 'OWNER' && isLastOwner(members, target)) {
      throw new AppError('CONFLICT', LAST_OWNER_MESSAGE);
    }
    await tx.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      data: { role },
    });
  });

  const member = await prisma.workspaceMember.findUniqueOrThrow({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    include: { user: { select: { name: true, email: true } } },
  });
  return {
    userId: member.userId,
    name: member.user.name,
    email: member.user.email,
    role: member.role,
    joinedAt: member.createdAt.toISOString(),
  };
}

/** Removes a member. Removing yourself ("leave") needs no management permission. */
export async function removeMember(
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
): Promise<void> {
  await withLockedMembers(workspaceId, actorUserId, async (tx, members, actorRole) => {
    const target = findTarget(members, targetUserId);
    const leaving = targetUserId === actorUserId;
    if (!leaving && !canManageMember(actorRole, target.role)) {
      throw AppError.forbidden(
        hasPermission(actorRole, 'members.manage')
          ? 'Only owners can remove an owner'
          : 'You do not have permission to perform this action',
      );
    }
    if (isLastOwner(members, target)) {
      throw new AppError(
        'CONFLICT',
        leaving
          ? 'You are the only owner. Make someone else an owner, or delete the workspace.'
          : LAST_OWNER_MESSAGE,
      );
    }
    await tx.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    });
  });
  // Their open tabs stop receiving this workspace's live events at once.
  revokeWorkspaceAccess(targetUserId, workspaceId);
}
