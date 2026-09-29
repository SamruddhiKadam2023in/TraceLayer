import type {
  AlertRuleConfig,
  AlertRuleView,
  ApiSuccessBody,
  EmailChannelConfig,
  FiredAlertView,
  NotificationChannelView,
  UpdateAlertRuleInput,
  UpdateChannelInput,
} from '@tracelayer/shared';
import { api } from './api';

// ─── Alert rules ─────────────────────────────────────────────────────────────

export async function fetchMonitorRules(monitorId: string): Promise<AlertRuleView[]> {
  const res = await api.get<ApiSuccessBody<AlertRuleView[]>>('/alerts', { params: { monitorId } });
  return res.data.data;
}

export async function createRule(config: AlertRuleConfig): Promise<AlertRuleView> {
  const res = await api.post<ApiSuccessBody<AlertRuleView>>('/alerts', config);
  return res.data.data;
}

export async function updateRule(
  id: string,
  changes: UpdateAlertRuleInput,
): Promise<AlertRuleView> {
  const res = await api.patch<ApiSuccessBody<AlertRuleView>>(`/alerts/${id}`, changes);
  return res.data.data;
}

export async function deleteRule(id: string): Promise<void> {
  await api.delete(`/alerts/${id}`);
}

export async function fetchFiredAlerts(projectId: string): Promise<FiredAlertView[]> {
  const res = await api.get<ApiSuccessBody<FiredAlertView[]>>('/alerts/fired', {
    params: { projectId },
  });
  return res.data.data;
}

// ─── Channels ────────────────────────────────────────────────────────────────

export async function fetchChannels(workspaceId: string): Promise<NotificationChannelView[]> {
  const res = await api.get<ApiSuccessBody<NotificationChannelView[]>>('/notification-channels', {
    params: { workspaceId },
  });
  return res.data.data;
}

export async function createChannel(input: {
  workspaceId: string;
  name: string;
  config: EmailChannelConfig;
}): Promise<NotificationChannelView> {
  const res = await api.post<ApiSuccessBody<NotificationChannelView>>('/notification-channels', {
    ...input,
    type: 'EMAIL',
  });
  return res.data.data;
}

export async function updateChannel(
  id: string,
  changes: UpdateChannelInput,
): Promise<NotificationChannelView> {
  const res = await api.patch<ApiSuccessBody<NotificationChannelView>>(
    `/notification-channels/${id}`,
    changes,
  );
  return res.data.data;
}

export async function deleteChannel(id: string): Promise<void> {
  await api.delete(`/notification-channels/${id}`);
}

export async function testChannel(id: string): Promise<void> {
  await api.post(`/notification-channels/${id}/test`);
}
