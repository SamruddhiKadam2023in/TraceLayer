import { Link, Outlet } from 'react-router';
import { Activity } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useSystemThemeSync } from '@/stores/theme.store';

export function RootLayout() {
  useSystemThemeSync();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line bg-surface px-4">
        <Link to="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Activity className="size-4 text-accent" aria-hidden="true" />
          TraceLayer
        </Link>
        <ThemeToggle />
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
