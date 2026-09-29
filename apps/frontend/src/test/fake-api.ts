import {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import type { AuthSession, WorkspaceSummary } from '@tracelayer/shared';
import { api } from '@/services/api';

export type FakeResponse = [status: number, body: unknown];
export type Handler = (config: InternalAxiosRequestConfig) => FakeResponse;

export interface RecordedCall {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
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
    createdAt: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
}

/** The signed-in user belongs to one workspace; add to every signed-in scenario. */
export const ONE_WORKSPACE: FakeResponse = [200, ok([makeWorkspace()])];
