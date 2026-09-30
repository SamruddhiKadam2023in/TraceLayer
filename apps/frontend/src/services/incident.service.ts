import type {
  ApiSuccessBody,
  IncidentDetail,
  IncidentEventView,
  IncidentListQuery,
  IncidentPage,
  UpdateIncidentInput,
} from '@tracelayer/shared';
import { api } from './api';

export async function fetchIncidents(query: IncidentListQuery): Promise<IncidentPage> {
  const res = await api.get<ApiSuccessBody<IncidentPage>>('/incidents', { params: query });
  return res.data.data;
}

export async function fetchIncident(id: string): Promise<IncidentDetail> {
  const res = await api.get<ApiSuccessBody<IncidentDetail>>(`/incidents/${id}`);
  return res.data.data;
}

export async function updateIncident(
  id: string,
  changes: UpdateIncidentInput,
): Promise<IncidentDetail> {
  const res = await api.patch<ApiSuccessBody<IncidentDetail>>(`/incidents/${id}`, changes);
  return res.data.data;
}

export async function addIncidentComment(id: string, message: string): Promise<IncidentEventView> {
  const res = await api.post<ApiSuccessBody<IncidentEventView>>(`/incidents/${id}/events`, {
    message,
  });
  return res.data.data;
}
