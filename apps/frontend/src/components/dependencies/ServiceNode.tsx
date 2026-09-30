import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import {
  Boxes,
  Cloud,
  Database,
  Layers,
  ListOrdered,
  Monitor,
  Network,
  type LucideIcon,
} from 'lucide-react';
import {
  DEPENDENCY_KIND_LABELS,
  type DependencyNodeKind,
  type DependencyNodeView,
  type HealthStatus,
} from '@tracelayer/shared';

const KIND_ICONS: Record<DependencyNodeKind, LucideIcon> = {
  FRONTEND: Monitor,
  GATEWAY: Network,
  SERVICE: Boxes,
  DATABASE: Database,
  CACHE: Layers,
  QUEUE: ListOrdered,
  EXTERNAL: Cloud,
};

const HEALTH: Record<HealthStatus, { label: string; className: string; border: string }> = {
  HEALTHY: { label: 'Healthy', className: 'bg-ok-soft text-ok', border: 'border-ok' },
  DEGRADED: { label: 'Degraded', className: 'bg-warn-soft text-warn', border: 'border-warn' },
  FAILING: { label: 'Failing', className: 'bg-fail-soft text-fail', border: 'border-fail' },
  NO_DATA: { label: 'No data', className: 'bg-surface-2 text-fg-muted', border: 'border-line' },
};

/** React Flow needs node data to be a plain record. */
export type ServiceNodeData = DependencyNodeView & Record<string, unknown>;
export type ServiceNodeType = Node<ServiceNodeData, 'service'>;

/**
 * One box on the map. Manual nodes have a solid border, inferred ones a dashed border and an
 * "Inferred" tag; health is spelled out, colour only reinforces it.
 */
export function ServiceNode({ data, selected }: NodeProps<ServiceNodeType>) {
  const Icon = KIND_ICONS[data.kind];
  const health = data.health ? HEALTH[data.health] : null;
  const inferred = data.origin === 'INFERRED';
  return (
    <div
      data-testid={`map-node-${data.label}`}
      className={`w-48 rounded-lg border-2 bg-surface px-3 py-2 text-left shadow-sm ${
        inferred ? 'border-dashed' : ''
      } ${health ? health.border : 'border-line'} ${selected ? 'ring-2 ring-accent' : ''}`}
    >
      <Handle type="target" position={Position.Top} aria-label={`Depends on ${data.label}`} />
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{data.label}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-fg-subtle">
        <span>{DEPENDENCY_KIND_LABELS[data.kind]}</span>
        {inferred && (
          <span className="rounded border border-dashed border-line px-1 text-fg-muted">
            Inferred
          </span>
        )}
        {health && (
          <span className={`rounded px-1 font-medium ${health.className}`}>
            {health.label}
            {data.monitorCount > 1 ? ` · ${data.monitorCount} monitors` : ''}
          </span>
        )}
      </div>
      {data.host && (
        <p className="mt-0.5 truncate font-mono text-[11px] text-fg-subtle">{data.host}</p>
      )}
      <Handle type="source" position={Position.Bottom} aria-label={`${data.label} depends on…`} />
    </div>
  );
}
