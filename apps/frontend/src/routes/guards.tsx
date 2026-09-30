import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { ServerCrash } from 'lucide-react';
import { Button } from '@/components/Button';
import { FullPageLoader } from '@/components/FullPageLoader';
import { CreateFirstWorkspacePage } from '@/pages/CreateFirstWorkspacePage';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useAuthStore } from '@/stores/auth.store';
import { safeRedirectTarget, type RedirectState } from '@/utils/redirect';

/** Renders child routes for signed-in users; sends everyone else to /login. */
export function RequireAuth() {
  const status = useAuthStore((s) => s.status);
  const location = useLocation();

  if (status === 'unknown') return <FullPageLoader label="Restoring your session" />;
  if (status === 'anonymous') {
    // The home page for visitors is the landing page; anything deeper asks them to sign in.
    if (location.pathname === '/') return <Navigate to="/welcome" replace />;
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

/**
 * Loads the user's workspaces and guarantees a current one for everything beneath it.
 * Users without any workspace are asked to create their first.
 */
export function RequireWorkspace() {
  const status = useWorkspaceStore((s) => s.status);
  const error = useWorkspaceStore((s) => s.error);
  const hasCurrent = useWorkspaceStore((s) => s.currentId !== null);
  const load = useWorkspaceStore((s) => s.load);

  useEffect(() => {
    if (useWorkspaceStore.getState().status === 'idle') void load();
  }, [load]);

  if (status === 'idle' || status === 'loading') {
    return <FullPageLoader label="Loading workspaces" />;
  }
  if (status === 'error') {
    return (
      <div
        role="alert"
        className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center"
      >
        <ServerCrash className="size-6 text-fail" aria-hidden="true" />
        <p className="text-sm text-fg-muted">{error}</p>
        <Button onClick={() => void load()}>Retry</Button>
      </div>
    );
  }
  if (!hasCurrent) return <CreateFirstWorkspacePage />;
  return <Outlet />;
}
