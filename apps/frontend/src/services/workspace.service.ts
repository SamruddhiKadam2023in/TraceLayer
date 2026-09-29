import type {
  AddMemberInput,
  ApiSuccessBody,
  WorkspaceMemberView,
  WorkspaceRole,
  WorkspaceSummary,
} from '@tracelayer/shared';
import { api } from './api';

export async function fetchWorkspaces(): Promise<WorkspaceSummary[]> {
  const res = await api.get<ApiSuccessBody<WorkspaceSummary[]>>('/workspaces');
  return res.data.data;
}

export async function createWorkspace(name: string): Promise<WorkspaceSummary> {
  const res = await api.post<ApiSuccessBody<WorkspaceSummary>>('/workspaces', { name });
  return res.data.data;
}

export async function renameWorkspace(id: string, name: string): Promise<WorkspaceSummary> {
  const res = await api.patch<ApiSuccessBody<WorkspaceSummary>>(`/workspaces/${id}`, { name });
  return res.data.data;
}

export async function deleteWorkspace(id: string): Promise<void> {
  await api.delete(`/workspaces/${id}`);
}

export async function fetchMembers(workspaceId: string): Promise<WorkspaceMemberView[]> {
  const res = await api.get<ApiSuccessBody<WorkspaceMemberView[]>>(
    `/workspaces/${workspaceId}/members`,
  );
  return res.data.data;
}

export async function addMember(
  workspaceId: string,
  input: AddMemberInput,
): Promise<WorkspaceMemberView> {
  const res = await api.post<ApiSuccessBody<WorkspaceMemberView>>(
    `/workspaces/${workspaceId}/members`,
    input,
  );
  return res.data.data;
}

export async function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<WorkspaceMemberView> {
  const res = await api.patch<ApiSuccessBody<WorkspaceMemberView>>(
    `/workspaces/${workspaceId}/members/${userId}`,
    { role },
  );
  return res.data.data;
}

/** Removes a member; pass your own id to leave the workspace. */
export async function removeMember(workspaceId: string, userId: string): Promise<void> {
  await api.delete(`/workspaces/${workspaceId}/members/${userId}`);
}
