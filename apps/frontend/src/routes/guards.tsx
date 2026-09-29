import { Navigate, Outlet, useLocation } from 'react-router';
import { FullPageLoader } from '@/components/FullPageLoader';
import { useAuthStore } from '@/stores/auth.store';
import { safeRedirectTarget, type RedirectState } from '@/utils/redirect';

/** Renders child routes for signed-in users; sends everyone else to /login. */
export function RequireAuth() {
  const status = useAuthStore((s) => s.status);
  const location = useLocation();

  if (status === 'unknown') return <FullPageLoader label="Restoring your session" />;
  if (status === 'anonymous') {
    const state: RedirectState = { from: location.pathname + location.search };
    return <Navigate to="/login" replace state={state} />;
  }
  return <Outlet />;
}

/** Keeps signed-in users away from /login and /register, returning them where they were going. */
export function RedirectIfAuthenticated() {
  const status = useAuthStore((s) => s.status);
  const location = useLocation();

  if (status === 'unknown') return <FullPageLoader label="Restoring your session" />;
  if (status === 'authenticated') {
    return <Navigate to={safeRedirectTarget(location.state)} replace />;
  }
  return <Outlet />;
}
