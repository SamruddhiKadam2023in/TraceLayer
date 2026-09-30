import { z } from 'zod';
import { WORKSPACE_ROLES, type WorkspaceRole } from './constants';
import { emailSchema } from './auth';

// ─── Permissions ─────────────────────────────────────────────────────────────
// The single source of truth for role-based access. The API enforces it; the UI only uses it
// to hide controls a user cannot use.

export const PERMISSIONS = {
  /** See the workspace, its members and (later) its projects, metrics and incidents. */
  'workspace.read': ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'],
  /** Rename the workspace. */
  'workspace.update': ['OWNER'],
  'workspace.delete': ['OWNER'],
  /** Add, remove and change the role of members. */
  'members.manage': ['OWNER', 'ADMIN'],
  /** Create, edit and delete projects and environments (Phase 4). */
  'projects.manage': ['OWNER', 'ADMIN'],
  /** Create, edit and run endpoints and monitors (Phases 5–7). */
  'monitoring.manage': ['OWNER', 'ADMIN', 'MEMBER'],
  /** Change incident status, severity and assignee, and comment on incidents. */
  'incidents.manage': ['OWNER', 'ADMIN', 'MEMBER'],
} as const satisfies Record<string, readonly WorkspaceRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(role: WorkspaceRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly WorkspaceRole[]).includes(role);
}

/** Roles an actor may give to a member. Only owners can create owners. */
export function assignableRoles(actorRole: WorkspaceRole): WorkspaceRole[] {
  if (!hasPermission(actorRole, 'members.manage')) return [];
  return actorRole === 'OWNER'
    ? [...WORKSPACE_ROLES]
    : WORKSPACE_ROLES.filter((r) => r !== 'OWNER');
}

/** Whether an actor may change or remove a member currently holding `targetRole`. */
export function canManageMember(actorRole: WorkspaceRole, targetRole: WorkspaceRole): boolean {
  if (!hasPermission(actorRole, 'members.manage')) return false;
  return actorRole === 'OWNER' || targetRole !== 'OWNER';
}

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
  VIEWER: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  OWNER: 'Full access, including workspace settings and deletion',
  ADMIN: 'Manage projects and members',
  MEMBER: 'Manage endpoints and monitors',
  VIEWER: 'Read-only access',
};

// ─── Validation ──────────────────────────────────────────────────────────────

export const workspaceRoleSchema = z.enum(WORKSPACE_ROLES, { error: 'Choose a valid role' });

export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1, 'Workspace name is required')
  .max(100, 'Workspace name is too long');

export const createWorkspaceSchema = z.object({ name: workspaceNameSchema });
export type CreateWorkspaceInput = z.input<typeof createWorkspaceSchema>;

export const updateWorkspaceSchema = z.object({ name: workspaceNameSchema });
export type UpdateWorkspaceInput = z.input<typeof updateWorkspaceSchema>;

export const addMemberSchema = z.object({ email: emailSchema, role: workspaceRoleSchema });
export type AddMemberInput = z.input<typeof addMemberSchema>;

export const updateMemberSchema = z.object({ role: workspaceRoleSchema });
export type UpdateMemberInput = z.input<typeof updateMemberSchema>;

// ─── Response types ──────────────────────────────────────────────────────────

/** A workspace as seen by one of its members. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  /** The requesting user's role in this workspace. */
  role: WorkspaceRole;
  memberCount: number;
  /** Generated demo data (see the demo seed); the app labels it clearly. */
  isDemo: boolean;
  createdAt: string;
}

export interface WorkspaceMemberView {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  joinedAt: string;
}
