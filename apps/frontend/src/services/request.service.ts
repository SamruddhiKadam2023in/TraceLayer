import type {
  ApiSuccessBody,
  ExecuteRequestInput,
  ExecuteRequestResponse,
  HistoryPage,
  HistoryQuery,
} from '@tracelayer/shared';
import { api } from './api';

export async function executeRequest(input: ExecuteRequestInput): Promise<ExecuteRequestResponse> {
  // The request itself has its own timeout (max 30s); leave room for the API around it.
  const res = await api.post<ApiSuccessBody<ExecuteRequestResponse>>('/requests/execute', input, {
    timeout: 45_000,
  });
  return res.data.data;
}

export async function fetchHistory(query: HistoryQuery): Promise<HistoryPage> {
  const res = await api.get<ApiSuccessBody<HistoryPage>>('/requests/history', { params: query });
  return res.data.data;
}
