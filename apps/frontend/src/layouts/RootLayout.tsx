import { useEffect } from 'react';
import { Outlet } from 'react-router';
import { refreshSession } from '@/services/api';
import { useAuthStore } from '@/stores/auth.store';
import { useSystemThemeSync } from '@/stores/theme.store';

/** App-wide concerns: theme syncing and restoring the session on page load. */
export function RootLayout() {
  useSystemThemeSync();

  useEffect(() => {
    if (useAuthStore.getState().status !== 'unknown') return;
    // The refresh cookie survives reloads; the in-memory access token does not.
    // If the API is unreachable the user lands on sign-in, which reports the connection problem.
    refreshSession().catch(() => useAuthStore.getState().clearSession());
  }, []);

  return <Outlet />;
}
