import { DangerZone } from '@/components/settings/DangerZone';
import { GeneralSettings } from '@/components/settings/GeneralSettings';
import { MembersSettings } from '@/components/settings/MembersSettings';
import { useCurrentWorkspace } from '@/stores/workspace.store';

export function WorkspaceSettingsPage() {
  const workspace = useCurrentWorkspace();

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
      <h1 className="text-xl font-semibold tracking-tight">Workspace settings</h1>
      <p className="mt-1 text-sm text-fg-muted">
        Manage <span className="font-medium text-fg">{workspace.name}</span> and who can access it.
      </p>
      {/* Keyed by workspace so switching workspaces resets every form and list. */}
      <div key={workspace.id} className="mt-6 flex flex-col gap-6">
        <GeneralSettings workspace={workspace} />
        <MembersSettings workspace={workspace} />
        <DangerZone workspace={workspace} />
      </div>
    </div>
  );
}
