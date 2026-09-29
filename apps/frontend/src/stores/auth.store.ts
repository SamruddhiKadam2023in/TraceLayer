import { create } from 'zustand';
import type { AuthSession, AuthUser } from '@tracelayer/shared';

/** `unknown` until the startup session check finishes. */
export type AuthStatus = 'unknown' | 'authenticated' | 'anonymous';

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  /** Held in memory only, never in localStorage, so injected scripts cannot lift it from storage. */
  accessToken: string | null;
  setSession: (session: AuthSession) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  status: 'unknown',
  user: null,
  accessToken: null,
  setSession: ({ user, accessToken }) => set({ status: 'authenticated', user, accessToken }),
  clearSession: () => set({ status: 'anonymous', user: null, accessToken: null }),
}));
