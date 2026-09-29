import { Layers } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { ThemeToggle } from '@/components/ThemeToggle';
import { UserMenu } from '@/components/UserMenu';
import { CreateWorkspaceForm } from '@/components/CreateWorkspaceForm';

/** Shown to signed-in users who belong to no workspace yet. */
export function CreateFirstWorkspacePage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-12 items-center justify-between border-b border-line bg-surface px-4">
        <Logo />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <UserMenu />
        </div>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-12 pb-16 sm:pt-20">
        <div className="w-full max-w-sm">
          <Layers className="size-6 text-accent" aria-hidden="true" />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">Create your first workspace</h1>
          <p className="mt-1 mb-6 text-sm text-fg-muted">
            A workspace holds your projects, endpoints and monitors, and the teammates who share
            them. You can create more and switch between them at any time.
          </p>
          <CreateWorkspaceForm submitLabel="Create workspace" />
        </div>
      </main>
    </div>
  );
}
