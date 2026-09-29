import type {
  ApiSuccessBody,
  ErrorPoint,
  LatencyPoint,
  MetricsOverview,
  MetricsQuery,
  MetricsSummary,
  TimeSeries,
} from '@tracelayer/shared';
import { api } from './api';

async function get<T>(path: string, query: MetricsQuery): Promise<T> {
  const res = await api.get<ApiSuccessBody<T>>(`/metrics${path}`, { params: query });
  return res.data.data;
}

export const fetchMetricsOverview = (query: MetricsQuery) => get<MetricsOverview>('', query);
export const fetchMetricsSummary = (query: MetricsQuery) => get<MetricsSummary>('/summary', query);
export const fetchLatencySeries = (query: MetricsQuery) =>
  get<TimeSeries<LatencyPoint>>('/latency', query);
export const fetchErrorSeries = (query: MetricsQuery) =>
  get<TimeSeries<ErrorPoint>>('/errors', query);
