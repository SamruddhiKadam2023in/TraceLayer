import { useEffect, useState } from 'react';
import { Link, Outlet } from 'react-router';
import { Menu, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { LiveIndicator } from '@/components/realtime/LiveIndicator';
import { RealtimeConnector } from '@/components/realtime/RealtimeConnector';
import { SidebarNav } from '@/components/Sidebar';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Toaster } from '@/components/Toaster';
import { UserMenu } from '@/components/UserMenu';
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher';
import { useUiStore } from '@/stores/ui.store';

/** Persistent application shell: top bar, collapsible sidebar, main content. */
export function AppLayout() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  return (
    <div className="flex h-dvh flex-col">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-surface px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:left-2 focus:top-2"
      >
        Skip to content
      </a>

      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-2 sm:px-3">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation"
          className="rounded-md p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg md:hidden"
        >
          <Menu className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          className="hidden rounded-md p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg md:block"
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" aria-hidden="true" />
          ) : (
            <PanelLeftClose className="size-4" aria-hidden="true" />
          )}
        </button>
        <Link to="/" className="hidden rounded-md px-1 sm:block">
          <Logo />
        </Link>
        <span className="hidden text-line sm:inline" aria-hidden="true">
          /
        </span>
        <WorkspaceSwitcher />
        <div className="ml-auto flex items-center gap-2">
          <LiveIndicator />
          <ThemeToggle />
          <UserMenu />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className={`hidden shrink-0 overflow-y-auto border-r border-line bg-surface md:block ${
            collapsed ? 'w-14' : 'w-56'
          }`}
        >
          <SidebarNav collapsed={collapsed} />
        </aside>

        {mobileOpen && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div
              className="absolute inset-0 bg-black/40"
              aria-hidden="true"
              onClick={() => setMobileOpen(false)}
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-line bg-surface"
            >
              <div className="flex h-12 items-center justify-between border-b border-line px-3">
                <Logo />
                <button
                  type="button"
                  onClick={() => setMobileOpen(false)}
                  aria-label="Close navigation"
                  autoFocus
                  className="rounded-md p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </div>
              <SidebarNav onNavigate={() => setMobileOpen(false)} />
            </div>
          </div>
        )}

        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <RealtimeConnector />
      <Toaster />
    </div>
  );
}
