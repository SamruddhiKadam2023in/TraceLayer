import { isAxiosError } from 'axios';
import type { ApiResponse, HealthReport } from '@tracelayer/shared';
import { api } from './api';

/**
 * The API answers 503 with a full report when a dependency is down,
 * so a 503 carrying a report is data, not a failed request.
 */
export async function fetchHealth(): Promise<HealthReport> {
  try {
    const res = await api.get<ApiResponse<HealthReport>>('/health');
    if (res.data.success) return res.data.data;
    throw new Error(res.data.error.message);
  } catch (err) {
    if (isAxiosError<ApiResponse<HealthReport>>(err) && err.response?.data?.success) {
      return err.response.data.data;
    }
    throw err;
  }
}
