import { Outlet } from 'react-router';
import { Logo } from '@/components/Logo';
import { ThemeToggle } from '@/components/ThemeToggle';

/** Centered single-column layout for the sign-in and sign-up screens. */
export function AuthLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-12 items-center justify-between px-4">
        <Logo />
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-10 pb-16 sm:pt-20">
        <div className="w-full max-w-sm">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
