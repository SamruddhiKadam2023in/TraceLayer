import {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import type {
  AuthSession,
  MetricsOverview,
  MetricsSummary,
  WorkspaceSummary,
} from '@tracelayer/shared';
import { api } from '@/services/api';

export type FakeResponse = [status: number, body: unknown];
export type Handler = (config: InternalAxiosRequestConfig) => FakeResponse;

export interface RecordedCall {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
  /** Query parameters (axios `params`). */
  params: unknown;
}

/**
 * Replaces the API client's transport with in-memory handlers keyed by "METHOD /path".
 * Interceptors, the auth store and error handling all run for real.
 */
export function installFakeApi(handlers: Record<string, Handler | FakeResponse>) {
  const calls: RecordedCall[] = [];

  const adapter: AxiosAdapter = async (config) => {
    const method = (config.method ?? 'get').toUpperCase();
    const url = config.url ?? '';
    const authorization = config.headers.get('Authorization');
    calls.push({
      method,
      url,
      authorization: typeof authorization === 'string' ? authorization : null,
      body: typeof config.data === 'string' ? JSON.parse(config.data) : config.data,
      params: config.params,
    });

    const handler = handlers[`${method} ${url}`];
    const [status, data] = !handler
      ? [404, apiError('NOT_FOUND', `No fake handler for ${method} ${url}`)]
      : typeof handler === 'function'
        ? handler(config)
        : handler;

    const response: AxiosResponse = { data, status, statusText: '', headers: {}, config };
    if (status >= 400) {
      throw new AxiosError(
        `Request failed with status code ${status}`,
        'ERR_BAD_REQUEST',
        config,
        null,
        response,
      );
    }
    return response;
  };

  api.defaults.adapter = adapter;
  return {
    calls,
    callsTo: (method: string, url: string) =>
      calls.filter((c) => c.method === method && c.url === url),
  };
}

export function ok<T>(data: T) {
  return { success: true, data };
}

export function apiError(code: string, message: string, details?: unknown[]) {
  return { success: false, error: { code, message, ...(details ? { details } : {}) } };
}

export function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    user: {
      id: 'user-1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      createdAt: '2026-09-29T10:00:00.000Z',
    },
    accessToken: 'access-token-1',
    expiresIn: 900,
    ...overrides,
  };
}

export const UNAUTHENTICATED: FakeResponse = [
  401,
  apiError('UNAUTHENTICATED', 'Session expired, please sign in again'),
];

export function makeWorkspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: 'ws-1',
    name: 'Acme',
    role: 'OWNER',
    memberCount: 1,
    isDemo: false,
    createdAt: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
}

/** The signed-in user belongs to one workspace; add to every signed-in scenario. */
export const ONE_WORKSPACE: FakeResponse = [200, ok([makeWorkspace()])];

// ─── Metrics fixtures ────────────────────────────────────────────────────────

const WINDOW = { range: '24h', from: '2026-09-29T10:00:00.000Z', to: '2026-09-30T10:00:00.000Z' };

export function makeSummary(overrides: Partial<MetricsSummary> = {}): MetricsSummary {
  return {
    ...(WINDOW as Pick<MetricsSummary, 'range' | 'from' | 'to'>),
    totals: { total: 1440, successful: 1437, failed: 3, uptime: 99.79, errorRate: 0.21 },
    latency: { avg: 184, min: 90, max: 1210, p50: 170, p95: 641, p99: 1200 },
    statusCodes: { '2xx': 1437, '3xx': 0, '4xx': 1, '5xx': 1, noResponse: 1 },
    ...overrides,
  };
}

/** Handlers for every metrics endpoint: a summary, flat series and an overview. */
export function metricsHandlers(
  options: { summary?: MetricsSummary; monitors?: MetricsOverview['monitors'] } = {},
): Record<string, FakeResponse> {
  const t = '2026-09-30T09:00:00.000Z';
  const monitors = options.monitors ?? [];
  const health = { HEALTHY: 0, DEGRADED: 0, FAILING: 0, NO_DATA: 0 };
  for (const m of monitors) health[m.health]++;
  return {
    'GET /metrics/summary': [200, ok(options.summary ?? makeSummary())],
    'GET /metrics/latency': [
      200,
      ok({
        ...WINDOW,
        bucketMs: 900_000,
        points: [{ t, avg: 184, p50: 170, p95: 641, p99: 1200 }],
      }),
    ],
    'GET /metrics/errors': [
      200,
      ok({ ...WINDOW, bucketMs: 900_000, points: [{ t, total: 15, failed: 1, errorRate: 6.67 }] }),
    ],
    'GET /metrics': [200, ok({ ...WINDOW, monitors, health })],
  };
}
