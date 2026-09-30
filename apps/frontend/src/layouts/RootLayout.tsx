import { useEffect } from 'react';
import { Outlet } from 'react-router';
import { isAxiosError } from 'axios';
import { refreshSession } from '@/services/api';
import { useAuthStore } from '@/stores/auth.store';
import { useSystemThemeSync } from '@/stores/theme.store';

const MAX_RATE_LIMIT_RETRIES = 2;

/**
 * Restores the session from the refresh cookie (the in-memory access token does not survive a
 * reload). A rate-limited attempt waits as the server asks and tries again, instead of signing
 * the person out: their session is still valid. Any other failure lands on sign-in, which
 * reports a connection problem if there is one.
 */
async function restoreSession(attempt = 0): Promise<void> {
  try {
    await refreshSession();
  } catch (err) {
    if (isAxiosError(err) && err.response?.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfter = Number(err.response.headers['retry-after']);
      const seconds = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2, 30);
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return restoreSession(attempt + 1);
    }
    useAuthStore.getState().clearSession();
  }
}

/** App-wide concerns: theme syncing and restoring the session on page load. */
export function RootLayout() {
  useSystemThemeSync();

  useEffect(() => {
    if (useAuthStore.getState().status !== 'unknown') return;
    void restoreSession();
  }, []);

  return <Outlet />;
}
