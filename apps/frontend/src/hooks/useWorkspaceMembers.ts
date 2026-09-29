import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceMemberView } from '@tracelayer/shared';
import { fetchMembers } from '@/services/workspace.service';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { toApiError } from '@/utils/api-error';

interface MembersState {
  members: WorkspaceMemberView[] | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setMembers: (update: (members: WorkspaceMemberView[]) => WorkspaceMemberView[]) => void;
}

export function useWorkspaceMembers(workspaceId: string): MembersState {
  const [members, setMembersState] = useState<WorkspaceMemberView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchMembers(workspaceId)
      .then((data) => {
        if (cancelled) return;
        setMembersState(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const apiError = toApiError(err);
        // Access was revoked (removed from the workspace, or it was deleted): resync the list.
        if (apiError.code === 'NOT_FOUND') void useWorkspaceStore.getState().load();
        setError(apiError.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, reloadKey]);

  const reload = useCallback(() => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  const setMembers = useCallback(
    (update: (members: WorkspaceMemberView[]) => WorkspaceMemberView[]) =>
      setMembersState((current) => (current ? update(current) : current)),
    [],
  );

  return { members, error, loading, reload, setMembers };
}
