import { useCallback, useId, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { ROLE_LABELS } from '@tracelayer/shared';
import { useDismiss } from '@/hooks/useDismiss';
import { useCurrentWorkspace, useWorkspaceStore } from '@/stores/workspace.store';
import { CreateWorkspaceForm } from './CreateWorkspaceForm';
import { Modal } from './Modal';

/** Top-bar control showing the current workspace, for switching or creating one. */
export function WorkspaceSwitcher() {
  const current = useCurrentWorkspace();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const select = useWorkspaceStore((s) => s.select);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, containerRef, buttonRef);

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`Current workspace: ${current.name}. Switch workspace`}
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium hover:bg-surface-2"
      >
        <span className="truncate">{current.name}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      </button>

      {open && (
        <div
          id={listId}
          className="absolute left-0 z-30 mt-1 w-72 overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
        >
          <p className="px-3 pt-2.5 pb-1 text-xs font-medium text-fg-subtle">Workspaces</p>
          <ul className="max-h-72 overflow-y-auto p-1">
            {workspaces.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  aria-current={w.id === current.id ? 'true' : undefined}
                  onClick={() => {
                    select(w.id);
                    setOpen(false);
                    buttonRef.current?.focus();
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{w.name}</span>
                    <span className="block text-xs text-fg-subtle">
                      {ROLE_LABELS[w.role]} · {w.memberCount}{' '}
                      {w.memberCount === 1 ? 'member' : 'members'}
                    </span>
                  </span>
                  {w.id === current.id && (
                    <Check className="size-4 shrink-0 text-accent" aria-hidden="true" />
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t border-line p-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setCreating(true);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg-muted hover:bg-surface-2 hover:text-fg"
            >
              <Plus className="size-4" aria-hidden="true" />
              Create workspace
            </button>
          </div>
        </div>
      )}

      {creating && (
        <Modal
          title="Create workspace"
          description="Workspaces group projects and the people who work on them."
          onClose={() => setCreating(false)}
        >
          <CreateWorkspaceForm
            onCreated={() => setCreating(false)}
            onCancel={() => setCreating(false)}
          />
        </Modal>
      )}
    </div>
  );
}
