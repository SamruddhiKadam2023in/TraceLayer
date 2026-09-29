import type {
  ApiSuccessBody,
  CreateEnvironmentInput,
  CreateVariableInput,
  EnvironmentVariableView,
  EnvironmentView,
  ProjectView,
  UpdateEnvironmentInput,
  UpdateProjectInput,
  UpdateVariableInput,
} from '@tracelayer/shared';
import { api } from './api';

// ─── Projects ────────────────────────────────────────────────────────────────

export async function fetchProjects(workspaceId: string): Promise<ProjectView[]> {
  const res = await api.get<ApiSuccessBody<ProjectView[]>>('/projects', {
    params: { workspaceId },
  });
  return res.data.data;
}

export async function fetchProject(projectId: string): Promise<ProjectView> {
  const res = await api.get<ApiSuccessBody<ProjectView>>(`/projects/${projectId}`);
  return res.data.data;
}

export async function createProject(input: {
  workspaceId: string;
  name: string;
  description?: string | null;
}): Promise<ProjectView> {
  const res = await api.post<ApiSuccessBody<ProjectView>>('/projects', input);
  return res.data.data;
}

export async function updateProject(
  projectId: string,
  input: UpdateProjectInput,
): Promise<ProjectView> {
  const res = await api.patch<ApiSuccessBody<ProjectView>>(`/projects/${projectId}`, input);
  return res.data.data;
}

export async function deleteProject(projectId: string): Promise<void> {
  await api.delete(`/projects/${projectId}`);
}

// ─── Environments ────────────────────────────────────────────────────────────

const environmentsPath = (projectId: string) => `/projects/${projectId}/environments`;

export async function fetchEnvironments(projectId: string): Promise<EnvironmentView[]> {
  const res = await api.get<ApiSuccessBody<EnvironmentView[]>>(environmentsPath(projectId));
  return res.data.data;
}

export async function createEnvironment(
  projectId: string,
  input: CreateEnvironmentInput,
): Promise<EnvironmentView> {
  const res = await api.post<ApiSuccessBody<EnvironmentView>>(environmentsPath(projectId), input);
  return res.data.data;
}

export async function updateEnvironment(
  projectId: string,
  environmentId: string,
  input: UpdateEnvironmentInput,
): Promise<EnvironmentView> {
  const res = await api.patch<ApiSuccessBody<EnvironmentView>>(
    `${environmentsPath(projectId)}/${environmentId}`,
    input,
  );
  return res.data.data;
}

export async function deleteEnvironment(projectId: string, environmentId: string): Promise<void> {
  await api.delete(`${environmentsPath(projectId)}/${environmentId}`);
}

// ─── Variables ───────────────────────────────────────────────────────────────

const variablesPath = (projectId: string, environmentId: string) =>
  `${environmentsPath(projectId)}/${environmentId}/variables`;

export async function createVariable(
  projectId: string,
  environmentId: string,
  input: CreateVariableInput,
): Promise<EnvironmentVariableView> {
  const res = await api.post<ApiSuccessBody<EnvironmentVariableView>>(
    variablesPath(projectId, environmentId),
    input,
  );
  return res.data.data;
}

export async function updateVariable(
  projectId: string,
  environmentId: string,
  variableId: string,
  input: UpdateVariableInput,
): Promise<EnvironmentVariableView> {
  const res = await api.patch<ApiSuccessBody<EnvironmentVariableView>>(
    `${variablesPath(projectId, environmentId)}/${variableId}`,
    input,
  );
  return res.data.data;
}

export async function deleteVariable(
  projectId: string,
  environmentId: string,
  variableId: string,
): Promise<void> {
  await api.delete(`${variablesPath(projectId, environmentId)}/${variableId}`);
}
