import type {
  ApiSuccessBody,
  MonitorConfig,
  MonitorRunView,
  MonitorView,
  UpdateMonitorInput,
} from '@tracelayer/shared';
import { api } from './api';

export async function fetchMonitors(projectId: string): Promise<MonitorView[]> {
  const res = await api.get<ApiSuccessBody<MonitorView[]>>('/monitors', { params: { projectId } });
  return res.data.data;
}

export async function fetchMonitor(monitorId: string): Promise<MonitorView> {
  const res = await api.get<ApiSuccessBody<MonitorView>>(`/monitors/${monitorId}`);
  return res.data.data;
}

export async function createMonitor(
  projectId: string,
  config: MonitorConfig,
): Promise<MonitorView> {
  const res = await api.post<ApiSuccessBody<MonitorView>>('/monitors', { projectId, ...config });
  return res.data.data;
}

export async function updateMonitor(
  monitorId: string,
  changes: UpdateMonitorInput,
): Promise<MonitorView> {
  const res = await api.patch<ApiSuccessBody<MonitorView>>(`/monitors/${monitorId}`, changes);
  return res.data.data;
}

export async function deleteMonitor(monitorId: string): Promise<void> {
  await api.delete(`/monitors/${monitorId}`);
}

export async function runMonitorNow(monitorId: string): Promise<void> {
  await api.post(`/monitors/${monitorId}/run`);
}

export async function fetchMonitorRuns(monitorId: string, limit = 25): Promise<MonitorRunView[]> {
  const res = await api.get<ApiSuccessBody<MonitorRunView[]>>(`/monitors/${monitorId}/runs`, {
    params: { limit },
  });
  return res.data.data;
}
