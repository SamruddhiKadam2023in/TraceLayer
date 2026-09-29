import { z } from 'zod';
import { hasPermission, type Permission, type WorkspaceRole } from '@tracelayer/shared';
import { prisma } from '../lib/prisma';
import { AppError } from '../utils/errors';

/** Proof that a user may act in a workspace, and with which role. */
export interface WorkspaceAccess {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

const uuidSchema = z.uuid();

/**
 * Validates a route id. A malformed id can never match a row, so it is reported as not found
 * (instead of letting the database reject it as a 500).
 */
export function parseId(value: unknown, resource: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw AppError.notFound(resource);
  return parsed.data;
}

/**
 * Checks that `userId` belongs to the workspace and holds `permission`.
 * Non-members get 404 rather than 403, so workspace ids cannot be probed for existence.
 */
export async function authorizeWorkspace(
  userId: string,
  workspaceId: string,
  permission: Permission,
): Promise<WorkspaceAccess> {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!membership) throw AppError.notFound('Workspace');
  if (!hasPermission(membership.role, permission)) throw AppError.forbidden();
  return { workspaceId, userId, role: membership.role };
}
