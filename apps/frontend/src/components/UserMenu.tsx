import { useCallback, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ChevronDown, LogOut } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { logout } from '@/services/auth.service';
import { useDismiss } from '@/hooks/useDismiss';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function UserMenu() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, containerRef, buttonRef);

  if (!user) return null;

  const signOut = async () => {
    setSigningOut(true);
    try {
      await logout();
    } catch {
      // logout() clears the local session even when the server is unreachable.
    }
    navigate('/login', { replace: true });
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Account menu for ${user.name}`}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md p-1 pr-1.5 text-sm hover:bg-surface-2"
      >
        <span
          aria-hidden="true"
          className="flex size-6 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-fg"
        >
          {initials(user.name)}
        </span>
        <span className="hidden max-w-40 truncate sm:inline">{user.name}</span>
        <ChevronDown className="size-3.5 text-fg-subtle" aria-hidden="true" />
      </button>

      {open && (
        <div
          id={panelId}
          className="animate-rise-in absolute right-0 z-30 mt-1 w-64 overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
        >
          <div className="border-b border-line px-3 py-2.5">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-fg-muted">{user.email}</p>
          </div>
          <div className="p-1">
            <button
              type="button"
              onClick={signOut}
              disabled={signingOut}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-60"
            >
              <LogOut className="size-4" aria-hidden="true" />
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
