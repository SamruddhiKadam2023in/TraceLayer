import type {
  ApiSuccessBody,
  DependencyMapView,
  DependencySuggestions,
  SaveDependencyMapInput,
} from '@tracelayer/shared';
import { api } from './api';

export async function fetchDependencyMap(projectId: string): Promise<DependencyMapView> {
  const res = await api.get<ApiSuccessBody<DependencyMapView>>('/dependencies', {
    params: { projectId },
  });
  return res.data.data;
}

export async function saveDependencyMap(input: SaveDependencyMapInput): Promise<DependencyMapView> {
  const res = await api.put<ApiSuccessBody<DependencyMapView>>('/dependencies', input);
  return res.data.data;
}

export async function fetchDependencySuggestions(
  projectId: string,
): Promise<DependencySuggestions> {
  const res = await api.get<ApiSuccessBody<DependencySuggestions>>('/dependencies/suggestions', {
    params: { projectId },
  });
  return res.data.data;
}
