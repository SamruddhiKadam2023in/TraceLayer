import { useState } from 'react';
import { useNavigate } from 'react-router';
import { hasPermission, type WorkspaceSummary } from '@tracelayer/shared';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { deleteWorkspace, removeMember } from '@/services/workspace.service';
import { useAuthStore } from '@/stores/auth.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { SettingsSection } from './SettingsSection';

export function DangerZone({ workspace }: { workspace: WorkspaceSummary }) {
  const userId = useAuthStore((s) => s.user?.id);
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<'leave' | 'delete' | null>(null);
  const canDelete = hasPermission(workspace.role, 'workspace.delete');

  /** After leaving or deleting, move to another workspace (or the create-first screen). */
  const exit = () => {
    useWorkspaceStore.getState().forget(workspace.id);
    navigate('/', { replace: true });
  };

  return (
    <SettingsSection title="Danger zone" tone="danger">
      <div className="flex flex-col divide-y divide-line">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
          <div>
            <p className="text-sm font-medium">Leave workspace</p>
            <p className="text-sm text-fg-muted">
              You will lose access until someone adds you again.
            </p>
          </div>
          <Button variant="secondary" onClick={() => setDialog('leave')}>
            Leave workspace
          </Button>
        </div>
        {canDelete && (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
            <div>
              <p className="text-sm font-medium">Delete workspace</p>
              <p className="text-sm text-fg-muted">
                Permanently deletes the workspace and everything in it for all members.
              </p>
            </div>
            <Button variant="danger" onClick={() => setDialog('delete')}>
              Delete workspace
            </Button>
          </div>
        )}
      </div>

      {dialog === 'leave' && userId && (
        <ConfirmDialog
          title={`Leave ${workspace.name}?`}
          confirmLabel="Leave workspace"
          destructive
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await removeMember(workspace.id, userId);
            exit();
          }}
        >
          You will lose access to this workspace and its projects.
        </ConfirmDialog>
      )}
      {dialog === 'delete' && (
        <ConfirmDialog
          title={`Delete ${workspace.name}?`}
          confirmLabel="Delete workspace"
          destructive
          confirmationText={workspace.name}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await deleteWorkspace(workspace.id);
            exit();
          }}
        >
          This permanently deletes the workspace for all {workspace.memberCount}{' '}
          {workspace.memberCount === 1 ? 'member' : 'members'}. It cannot be undone.
        </ConfirmDialog>
      )}
    </SettingsSection>
  );
}
