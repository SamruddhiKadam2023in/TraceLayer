import type { ApiSuccessBody, AuthSession, LoginInput, RegisterInput } from '@tracelayer/shared';
import { useAuthStore } from '@/stores/auth.store';
import { api } from './api';

export async function login(input: LoginInput): Promise<AuthSession> {
  const res = await api.post<ApiSuccessBody<AuthSession>>('/auth/login', input, {
    skipAuthRefresh: true,
  });
  useAuthStore.getState().setSession(res.data.data);
  return res.data.data;
}

export async function register(input: RegisterInput): Promise<AuthSession> {
  const res = await api.post<ApiSuccessBody<AuthSession>>('/auth/register', input, {
    skipAuthRefresh: true,
  });
  useAuthStore.getState().setSession(res.data.data);
  return res.data.data;
}

/** Ends the session on the server, then locally even if the server could not be reached. */
export async function logout(): Promise<void> {
  try {
    await api.post('/auth/logout', null, { skipAuthRefresh: true });
  } finally {
    useAuthStore.getState().clearSession();
  }
}
