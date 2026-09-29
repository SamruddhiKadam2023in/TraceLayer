import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { WorkspaceSummary } from '@tracelayer/shared';
import { fetchWorkspaces } from '@/services/workspace.service';
import { toApiError } from '@/utils/api-error';
import { useAuthStore } from './auth.store';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface WorkspaceState {
  status: LoadStatus;
  error: string | null;
  workspaces: WorkspaceSummary[];
  /** The selected workspace. Persisted so a reload reopens the same one. */
  currentId: string | null;
  load: () => Promise<void>;
  select: (id: string) => void;
  /** Adds or replaces a workspace in the list (after create or rename). */
  upsert: (workspace: WorkspaceSummary) => void;
  /** Drops a workspace the user deleted or left, and moves to another one. */
  forget: (id: string) => void;
  reset: () => void;
}

const byName = (a: WorkspaceSummary, b: WorkspaceSummary) => a.name.localeCompare(b.name);

/** Keeps the selection valid: the remembered workspace if still accessible, else the first. */
function resolveCurrent(workspaces: WorkspaceSummary[], preferred: string | null): string | null {
  if (preferred && workspaces.some((w) => w.id === preferred)) return preferred;
  return workspaces[0]?.id ?? null;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      status: 'idle',
      error: null,
      workspaces: [],
      currentId: null,

      load: async () => {
        set({ status: 'loading', error: null });
        try {
          const workspaces = await fetchWorkspaces();
          set({
            status: 'ready',
            workspaces,
            currentId: resolveCurrent(workspaces, get().currentId),
          });
        } catch (err) {
          set({ status: 'error', error: toApiError(err).message });
        }
      },

      select: (id) => {
        if (get().workspaces.some((w) => w.id === id)) set({ currentId: id });
      },

      upsert: (workspace) =>
        set((s) => ({
          workspaces: [...s.workspaces.filter((w) => w.id !== workspace.id), workspace].sort(
            byName,
          ),
        })),

      forget: (id) =>
        set((s) => {
          const workspaces = s.workspaces.filter((w) => w.id !== id);
          return { workspaces, currentId: resolveCurrent(workspaces, s.currentId) };
        }),

      reset: () => set({ status: 'idle', error: null, workspaces: [], currentId: null }),
    }),
    {
      name: 'tracelayer-workspace',
      partialize: (s) => ({ currentId: s.currentId }),
    },
  ),
);

/** The selected workspace. Only call beneath `RequireWorkspace`, which guarantees one exists. */
export function useCurrentWorkspace(): WorkspaceSummary {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.currentId));
  if (!workspace) throw new Error('useCurrentWorkspace used outside RequireWorkspace');
  return workspace;
}

// Signing out (or losing the session) must not leave one user's workspaces for the next.
useAuthStore.subscribe((state, previous) => {
  if (previous.status === 'authenticated' && state.status !== 'authenticated') {
    useWorkspaceStore.getState().reset();
  }
});
