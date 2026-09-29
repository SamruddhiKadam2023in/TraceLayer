import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { UserMinus } from 'lucide-react';
import {
  addMemberSchema,
  assignableRoles,
  canManageMember,
  hasPermission,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  type AddMemberInput,
  type WorkspaceMemberView,
  type WorkspaceRole,
  type WorkspaceSummary,
} from '@tracelayer/shared';
import { ErrorAlert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { RoleBadge } from '@/components/RoleBadge';
import { SelectField } from '@/components/SelectField';
import { TextField } from '@/components/TextField';
import { useWorkspaceMembers } from '@/hooks/useWorkspaceMembers';
import { addMember, removeMember, updateMemberRole } from '@/services/workspace.service';
import { useAuthStore } from '@/stores/auth.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { fieldErrors, toApiError } from '@/utils/api-error';
import { SettingsSection } from './SettingsSection';

function roleOptions(roles: WorkspaceRole[]) {
  return roles.map((r) => ({ value: r, label: ROLE_LABELS[r] }));
}

function AddMemberForm({
  workspace,
  onAdded,
}: {
  workspace: WorkspaceSummary;
  onAdded: (member: WorkspaceMemberView) => void;
}) {
  const roles = assignableRoles(workspace.role);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    control,
    formState: { errors, isSubmitting },
  } = useForm<AddMemberInput>({
    resolver: zodResolver(addMemberSchema),
    defaultValues: { email: '', role: 'MEMBER' },
  });
  const selectedRole = useWatch({ control, name: 'role' });

  const onSubmit = handleSubmit(async (values) => {
    try {
      onAdded(await addMember(workspace.id, values));
      reset({ email: '', role: values.role });
    } catch (err) {
      const apiError = toApiError(err);
      const fields = fieldErrors(apiError);
      if (fields.email) setError('email', { message: fields.email });
      else setError('root', { message: apiError.message });
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3 border-b border-line pb-4">
      {errors.root?.message && <ErrorAlert>{errors.root.message}</ErrorAlert>}
      <div className="grid gap-3 sm:grid-cols-[1fr_9rem_auto] sm:items-start">
        <TextField
          label="Email address"
          type="email"
          placeholder="teammate@company.com"
          autoComplete="off"
          hint="They need a TraceLayer account already."
          error={errors.email?.message}
          {...register('email')}
        />
        <SelectField label="Role" options={roleOptions(roles)} {...register('role')} />
        <Button type="submit" loading={isSubmitting} className="sm:mt-[1.625rem]">
          Add member
        </Button>
      </div>
      {selectedRole && (
        <p className="text-xs text-fg-subtle">
          {ROLE_LABELS[selectedRole]}: {ROLE_DESCRIPTIONS[selectedRole]}.
        </p>
      )}
    </form>
  );
}

export function MembersSettings({ workspace }: { workspace: WorkspaceSummary }) {
  const currentUserId = useAuthStore((s) => s.user?.id);
  const { members, error, loading, reload, setMembers } = useWorkspaceMembers(workspace.id);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<WorkspaceMemberView | null>(null);
  const canManage = hasPermission(workspace.role, 'members.manage');

  const syncCount = (delta: number) =>
    useWorkspaceStore
      .getState()
      .upsert({ ...workspace, memberCount: workspace.memberCount + delta });

  const changeRole = async (member: WorkspaceMemberView, role: WorkspaceRole) => {
    setActionError(null);
    setPendingUserId(member.userId);
    try {
      const updated = await updateMemberRole(workspace.id, member.userId, role);
      setMembers((list) => list.map((m) => (m.userId === updated.userId ? updated : m)));
      // Changing your own role changes what you may do from now on.
      if (updated.userId === currentUserId) {
        useWorkspaceStore.getState().upsert({ ...workspace, role: updated.role });
      }
    } catch (err) {
      setActionError(toApiError(err).message);
    } finally {
      setPendingUserId(null);
    }
  };

  return (
    <SettingsSection
      title="Members"
      description={
        canManage
          ? 'Add teammates who already have a TraceLayer account, and choose what they can do.'
          : 'People who have access to this workspace.'
      }
    >
      <div className="flex flex-col gap-4">
        {canManage && (
          <AddMemberForm
            workspace={workspace}
            onAdded={(member) => {
              setMembers((list) => [...list, member]);
              syncCount(1);
            }}
          />
        )}
        {actionError && <ErrorAlert>{actionError}</ErrorAlert>}

        {error ? (
          <div role="alert" className="flex items-center justify-between gap-3 text-sm text-fail">
            {error}
            <Button variant="secondary" onClick={reload}>
              Retry
            </Button>
          </div>
        ) : loading && !members ? (
          <p className="text-sm text-fg-subtle" role="status">
            Loading members…
          </p>
        ) : (
          <ul aria-label="Workspace members" className="divide-y divide-line">
            {(members ?? []).map((member) => {
              const isSelf = member.userId === currentUserId;
              const manageable = canManageMember(workspace.role, member.role);
              return (
                <li
                  key={member.userId}
                  data-testid={`member-${member.email}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {member.name}
                      {isSelf && <span className="ml-1.5 font-normal text-fg-subtle">(you)</span>}
                    </p>
                    <p className="truncate text-xs text-fg-muted">{member.email}</p>
                  </div>
                  {manageable ? (
                    <SelectField
                      label={`Role for ${member.name}`}
                      hideLabel
                      value={member.role}
                      disabled={pendingUserId === member.userId}
                      onChange={(e) => void changeRole(member, e.target.value as WorkspaceRole)}
                      options={roleOptions(
                        // Keep an owner's current role listed even for actors who cannot assign it.
                        [...new Set([member.role, ...assignableRoles(workspace.role)])],
                      )}
                    />
                  ) : (
                    <RoleBadge role={member.role} />
                  )}
                  {manageable && !isSelf ? (
                    <Button
                      variant="ghost"
                      aria-label={`Remove ${member.name}`}
                      title={`Remove ${member.name}`}
                      onClick={() => setRemoving(member)}
                      className="px-2"
                    >
                      <UserMinus className="size-4" aria-hidden="true" />
                    </Button>
                  ) : (
                    // Keeps rows aligned whether or not a remove button is shown.
                    canManage && <span className="w-8" aria-hidden="true" />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          confirmLabel="Remove member"
          destructive
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await removeMember(workspace.id, removing.userId);
            setMembers((list) => list.filter((m) => m.userId !== removing.userId));
            syncCount(-1);
            setRemoving(null);
          }}
        >
          {removing.name} ({removing.email}) will immediately lose access to {workspace.name}.
        </ConfirmDialog>
      )}
    </SettingsSection>
  );
}
