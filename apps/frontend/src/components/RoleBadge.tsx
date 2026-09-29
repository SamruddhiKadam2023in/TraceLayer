import { ROLE_LABELS, type WorkspaceRole } from '@tracelayer/shared';

export function RoleBadge({ role }: { role: WorkspaceRole }) {
  return (
    <span className="inline-flex items-center rounded border border-line px-1.5 py-0.5 text-[11px] font-medium text-fg-muted">
      {ROLE_LABELS[role]}
    </span>
  );
}
