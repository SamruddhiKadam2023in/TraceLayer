import axios, { isAxiosError, type InternalAxiosRequestConfig } from 'axios';
import type { ApiSuccessBody, AuthSession } from '@tracelayer/shared';
import { useAuthStore } from '@/stores/auth.store';

declare module 'axios' {
  interface AxiosRequestConfig {
    /** Do not try to renew the session on 401 (set by the auth endpoints themselves). */
    skipAuthRefresh?: boolean;
  }
}

type RetriableConfig = InternalAxiosRequestConfig & { _retried?: boolean };

/** All API traffic goes through the same origin (`/api`): Vite proxies it in dev, nginx in Docker. */
export const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 15_000,
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token && !config.headers.has('Authorization')) {
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  return config;
});

// ─── Session renewal ─────────────────────────────────────────────────────────

const REFRESH_LOCK = 'tracelayer-session-refresh';
let inflightRefresh: Promise<AuthSession | null> | null = null;

/**
 * Tabs share one refresh cookie, and the server treats a reused refresh token as theft.
 * The Web Locks API makes tabs refresh one at a time, so each uses the latest cookie.
 */
async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return await navigator.locks.request(REFRESH_LOCK, fn);
  }
  return fn();
}

async function performRefresh(): Promise<AuthSession | null> {
  try {
    const res = await api.post<ApiSuccessBody<AuthSession>>('/auth/refresh', null, {
      skipAuthRefresh: true,
    });
    useAuthStore.getState().setSession(res.data.data);
    return res.data.data;
  } catch (err) {
    if (isAxiosError(err) && err.response?.status === 401) {
      useAuthStore.getState().clearSession();
      return null;
    }
    throw err;
  }
}

/**
 * Exchanges the refresh cookie for a new session. Concurrent callers share one request.
 * Resolves to null (and signs the user out locally) when there is no valid session.
 */
export function refreshSession(): Promise<AuthSession | null> {
  inflightRefresh ??= withRefreshLock(performRefresh).finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

// On 401, renew the session once and replay the request with the new access token.
api.interceptors.response.use(undefined, async (error: unknown) => {
  if (!isAxiosError(error) || error.response?.status !== 401 || !error.config) throw error;
  const config = error.config as RetriableConfig;
  if (config.skipAuthRefresh || config._retried) throw error;
  config._retried = true;

  const sentToken = config.headers.get('Authorization');
  const current = useAuthStore.getState().accessToken;
  // Another request already renewed the session while this one was in flight.
  const token =
    current && sentToken !== `Bearer ${current}` ? current : (await refreshSession())?.accessToken;
  if (!token) throw error;

  config.headers.set('Authorization', `Bearer ${token}`);
  return api.request(config);
});
