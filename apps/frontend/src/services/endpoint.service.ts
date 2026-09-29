import type {
  ApiSuccessBody,
  EndpointConfig,
  EndpointView,
  UpdateEndpointInput,
} from '@tracelayer/shared';
import { api } from './api';

export async function fetchEndpoints(projectId: string): Promise<EndpointView[]> {
  const res = await api.get<ApiSuccessBody<EndpointView[]>>('/endpoints', {
    params: { projectId },
  });
  return res.data.data;
}

export async function fetchEndpoint(endpointId: string): Promise<EndpointView> {
  const res = await api.get<ApiSuccessBody<EndpointView>>(`/endpoints/${endpointId}`);
  return res.data.data;
}

export async function createEndpoint(
  projectId: string,
  config: EndpointConfig,
): Promise<EndpointView> {
  const res = await api.post<ApiSuccessBody<EndpointView>>('/endpoints', { projectId, ...config });
  return res.data.data;
}

export async function updateEndpoint(
  endpointId: string,
  changes: UpdateEndpointInput,
): Promise<EndpointView> {
  const res = await api.patch<ApiSuccessBody<EndpointView>>(`/endpoints/${endpointId}`, changes);
  return res.data.data;
}

export async function deleteEndpoint(endpointId: string): Promise<void> {
  await api.delete(`/endpoints/${endpointId}`);
}
