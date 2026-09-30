import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Plus, Save, Sparkles, Trash2, Undo2 } from 'lucide-react';
import {
  DEPENDENCY_KIND_LABELS,
  DEPENDENCY_NODE_KINDS,
  MAX_DEPENDENCY_NODES,
  saveDependencyMapSchema,
  type DependencyEdgeView,
  type DependencyMapView,
  type DependencyNodeKind,
  type DependencyNodeView,
  type DependencyOrigin,
  type HealthStatus,
} from '@tracelayer/shared';
import { ErrorAlert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { SelectField } from '@/components/SelectField';
import { TextField } from '@/components/TextField';
import { useChartColors } from '@/hooks/useChartColors';
import { fetchDependencySuggestions, saveDependencyMap } from '@/services/dependency.service';
import { toApiError } from '@/utils/api-error';
import { ServiceNode, type ServiceNodeType } from './ServiceNode';

type MapEdge = Edge<{ origin: DependencyOrigin; label: string | null }>;

export type HostHealth = Map<string, { health: HealthStatus; monitorCount: number }>;

const nodeTypes = { service: ServiceNode };
const ORIGIN_LABEL: Record<DependencyOrigin, string> = { MANUAL: 'Manual', INFERRED: 'Inferred' };

const toFlowNode = (node: DependencyNodeView): ServiceNodeType => ({
  id: node.id,
  type: 'service',
  position: { x: node.x, y: node.y },
  data: { ...node },
});
const toFlowEdge = (edge: DependencyEdgeView): MapEdge => ({
  id: edge.id,
  source: edge.sourceId,
  target: edge.targetId,
  data: { origin: edge.origin, label: edge.label },
});

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
const useIsDark = () =>
  useSyncExternalStore(
    subscribeTheme,
    () => document.documentElement.classList.contains('dark'),
    () => false,
  );

function Notice({ tone, children }: { tone: 'ok' | 'info'; children: ReactNode }) {
  return (
    <p role="status" className={`text-sm ${tone === 'ok' ? 'text-ok' : 'text-fg-muted'}`}>
      {children}
    </p>
  );
}

interface DependencyMapEditorProps {
  projectId: string;
  /** The saved map this editing session starts from. */
  initial: DependencyMapView;
  /** Latest health per host (refreshed live), overriding what `initial` carried. */
  health: HostHealth;
  canEdit: boolean;
  onSaved: (map: DependencyMapView) => void;
  /** Discard local changes and start again from the latest saved map. */
  onReload: () => void;
}

/**
 * The dependency map editor (spec §30): create nodes, connect them, rename and remove them,
 * and save the diagram. Everything the canvas does can also be done from the side panel, so
 * the map works with a keyboard and a screen reader.
 */
export function DependencyMapEditor({
  projectId,
  initial,
  health,
  canEdit,
  onSaved,
  onReload,
}: DependencyMapEditorProps) {
  // Pinned for the whole session: saves must name the version these edits started from, even if
  // the page refreshes the map in the background.
  const [base] = useState(initial);
  const [nodes, setNodes, applyNodeChanges] = useNodesState<ServiceNodeType>(
    base.nodes.map(toFlowNode),
  );
  const [edges, setEdges, applyEdgeChanges] = useEdgesState<MapEdge>(base.edges.map(toFlowEdge));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'info'; text: string } | null>(null);
  const [connectFrom, setConnectFrom] = useState('');
  const [connectTo, setConnectTo] = useState('');
  const colors = useChartColors();
  const dark = useIsDark();

  // Leaving with unsaved changes asks the browser to confirm.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const changed = () => {
    setDirty(true);
    setNotice(null);
  };
  const selected = nodes.find((n) => n.selected)?.data ?? null;
  const labelOf = (id: string) => nodes.find((n) => n.id === id)?.data.label ?? '?';

  const updateNode = (id: string, patch: Partial<DependencyNodeView>) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
    changed();
  };
  const selectNode = (id: string) =>
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
  const removeNode = (id: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    changed();
  };
  const connect = (source: string, target: string, origin: DependencyOrigin = 'MANUAL') => {
    if (source === target) {
      setNotice({ tone: 'info', text: 'A node cannot depend on itself.' });
      return;
    }
    if (edges.some((e) => e.source === source && e.target === target)) {
      setNotice({ tone: 'info', text: 'These nodes are already connected.' });
      return;
    }
    setEdges((es) => [
      ...es,
      { id: crypto.randomUUID(), source, target, data: { origin, label: null } },
    ]);
    changed();
  };

  const addNode = () => {
    if (nodes.length >= MAX_DEPENDENCY_NODES) {
      setNotice({ tone: 'info', text: `A map can have at most ${MAX_DEPENDENCY_NODES} nodes.` });
      return;
    }
    const bottom = nodes.length ? Math.max(...nodes.map((n) => n.position.y)) + 160 : 0;
    const node: DependencyNodeView = {
      id: crypto.randomUUID(),
      label: `Service ${nodes.length + 1}`,
      kind: 'SERVICE',
      origin: 'MANUAL',
      host: null,
      x: 0,
      y: Math.round(bottom),
      health: null,
      monitorCount: 0,
    };
    setNodes((ns) => [
      ...ns.map((n) => ({ ...n, selected: false })),
      { ...toFlowNode(node), selected: true },
    ]);
    changed();
  };

  const detect = async () => {
    setError(null);
    try {
      const suggestions = await fetchDependencySuggestions(projectId);
      if (suggestions.nodes.length === 0 && suggestions.edges.length === 0) {
        setNotice({
          tone: 'info',
          text: 'Nothing new to suggest: every host your endpoints call is already on the map.',
        });
        return;
      }
      // Suggestions are laid out below the saved map; offset them below local additions too.
      const savedBottom = base.nodes.length ? Math.max(...base.nodes.map((n) => n.y)) : 0;
      const localBottom = nodes.length ? Math.max(...nodes.map((n) => n.position.y)) : 0;
      const shift = Math.max(0, localBottom - savedBottom);
      setNodes((ns) => [
        ...ns,
        ...suggestions.nodes.map((n) => toFlowNode({ ...n, y: n.y + shift })),
      ]);
      setEdges((es) => [...es, ...suggestions.edges.map(toFlowEdge)]);
      setDirty(true);
      setNotice({
        tone: 'ok',
        text: `Added ${suggestions.nodes.length} inferred node${suggestions.nodes.length === 1 ? '' : 's'} and ${suggestions.edges.length} connection${suggestions.edges.length === 1 ? '' : 's'}. Review them, then save.`,
      });
    } catch (err) {
      setError({ message: toApiError(err).message, conflict: false });
    }
  };

  const save = async () => {
    const input = {
      projectId,
      version: base.version,
      nodes: nodes.map((n) => ({
        id: n.id,
        label: n.data.label,
        kind: n.data.kind,
        origin: n.data.origin,
        host: n.data.host?.trim() ? n.data.host.trim() : null,
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
      })),
      edges: edges.map((e) => ({
        id: e.id,
        sourceId: e.source,
        targetId: e.target,
        origin: e.data?.origin ?? 'MANUAL',
        label: e.data?.label ?? null,
      })),
    };
    const check = saveDependencyMapSchema.safeParse(input);
    if (!check.success) {
      const issue = check.error.issues[0]!;
      const [collection, index] = issue.path as [string, number];
      const where =
        collection === 'nodes' && typeof index === 'number'
          ? ` (${input.nodes[index]?.label || 'unnamed node'})`
          : '';
      setError({ message: `${issue.message}${where}`, conflict: false });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(await saveDependencyMap(input));
    } catch (err) {
      const apiError = toApiError(err);
      setError({ message: apiError.message, conflict: apiError.code === 'CONFLICT' });
      setSaving(false);
    }
  };

  const onNodesChange = (changes: NodeChange<ServiceNodeType>[]) => {
    applyNodeChanges(changes);
    if (
      changes.some((c) => (c.type === 'position' && c.dragging === false) || c.type === 'remove')
    ) {
      changed();
    }
  };
  const onEdgesChange = (changes: EdgeChange<MapEdge>[]) => {
    applyEdgeChanges(changes);
    if (changes.some((c) => c.type === 'remove')) changed();
  };

  // Live health (spec §24) on top of the editable data; styling tells manual from inferred.
  const shownNodes = useMemo(
    () =>
      nodes.map((n) => {
        const live = n.data.host ? health.get(n.data.host.trim().toLowerCase()) : undefined;
        return live ? { ...n, data: { ...n.data, ...live } } : n;
      }),
    [nodes, health],
  );
  const shownEdges = useMemo(
    () =>
      edges.map((e) => {
        const inferred = e.data?.origin === 'INFERRED';
        return {
          ...e,
          label: e.data?.label ?? (inferred ? 'inferred' : undefined),
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: inferred ? colors.subtle : colors.text,
          },
          style: {
            stroke: inferred ? colors.subtle : colors.text,
            strokeWidth: 1.5,
            ...(inferred ? { strokeDasharray: '6 4' } : {}),
          },
        };
      }),
    [edges, colors],
  );

  const nodeOptions = nodes.map((n) => ({ value: n.id, label: n.data.label }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (
          <>
            <Button variant="secondary" onClick={addNode}>
              <Plus className="size-4" aria-hidden="true" />
              Add node
            </Button>
            <Button variant="secondary" onClick={detect}>
              <Sparkles className="size-4" aria-hidden="true" />
              Detect dependencies
            </Button>
            <Button onClick={save} loading={saving} disabled={!dirty}>
              <Save className="size-4" aria-hidden="true" />
              Save map
            </Button>
            {dirty && (
              <Button variant="ghost" onClick={onReload} disabled={saving}>
                <Undo2 className="size-4" aria-hidden="true" />
                Discard changes
              </Button>
            )}
            <span className="text-xs text-fg-subtle">{dirty ? 'Unsaved changes' : 'Saved'}</span>
          </>
        )}
        <span className="ml-auto flex items-center gap-3 text-xs text-fg-muted" aria-label="Legend">
          <span className="flex items-center gap-1">
            <span className="w-6 border-t-2 border-fg-muted" aria-hidden="true" /> Manual
          </span>
          <span className="flex items-center gap-1">
            <span className="w-6 border-t-2 border-dashed border-fg-subtle" aria-hidden="true" />{' '}
            Inferred
          </span>
        </span>
      </div>
      {error && (
        <ErrorAlert>
          {error.message}{' '}
          {error.conflict && (
            <button type="button" onClick={onReload} className="font-medium underline">
              Reload map
            </button>
          )}
        </ErrorAlert>
      )}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <div
          className="h-[34rem] overflow-hidden rounded-lg border border-line bg-surface"
          aria-label="Dependency map canvas"
          role="region"
        >
          {nodes.length === 0 ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-fg-subtle">
              {canEdit
                ? 'Empty map. Add nodes, or let TraceLayer detect the hosts your endpoints call.'
                : 'No dependency map yet.'}
            </div>
          ) : (
            <ReactFlow<ServiceNodeType, MapEdge>
              nodes={shownNodes}
              edges={shownEdges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={(c: Connection) => canEdit && connect(c.source, c.target)}
              nodesDraggable={canEdit}
              nodesConnectable={canEdit}
              deleteKeyCode={canEdit ? ['Backspace', 'Delete'] : null}
              colorMode={dark ? 'dark' : 'light'}
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>

        <aside aria-label="Map details" className="flex flex-col gap-4 text-sm">
          <section aria-labelledby="map-nodes" className="flex flex-col gap-2">
            <h3 id="map-nodes" className="font-semibold">
              Nodes ({nodes.length})
            </h3>
            <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {nodes.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => selectNode(n.id)}
                    aria-pressed={Boolean(n.selected)}
                    className={`w-full truncate rounded px-2 py-1 text-left hover:bg-surface-2 ${
                      n.selected ? 'bg-surface-2 font-medium' : ''
                    }`}
                  >
                    {n.data.label}
                    {n.data.origin === 'INFERRED' && (
                      <span className="ml-1 text-xs text-fg-subtle">(inferred)</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {selected && (
            <section
              aria-label={`Selected node ${selected.label}`}
              className="flex flex-col gap-2 rounded-lg border border-line p-3"
            >
              <p className="text-xs text-fg-subtle">
                {ORIGIN_LABEL[selected.origin]} node
                {selected.origin === 'INFERRED' && ': detected from your endpoints'}
              </p>
              {canEdit ? (
                <>
                  <TextField
                    label="Name"
                    value={selected.label}
                    maxLength={60}
                    onChange={(e) => updateNode(selected.id, { label: e.target.value })}
                  />
                  <SelectField
                    label="Kind"
                    value={selected.kind}
                    options={DEPENDENCY_NODE_KINDS.map((k) => ({
                      value: k,
                      label: DEPENDENCY_KIND_LABELS[k],
                    }))}
                    onChange={(e) =>
                      updateNode(selected.id, { kind: e.target.value as DependencyNodeKind })
                    }
                  />
                  <TextField
                    label="Host (optional)"
                    placeholder="api.example.com"
                    hint="Monitors calling this host show their health on the node."
                    value={selected.host ?? ''}
                    onChange={(e) => updateNode(selected.id, { host: e.target.value || null })}
                  />
                  <Button variant="secondary" onClick={() => removeNode(selected.id)}>
                    <Trash2 className="size-4" aria-hidden="true" />
                    Remove node
                  </Button>
                </>
              ) : (
                <dl className="flex flex-col gap-1">
                  <dt className="text-xs text-fg-subtle">Name</dt>
                  <dd>{selected.label}</dd>
                  <dt className="text-xs text-fg-subtle">Kind</dt>
                  <dd>{DEPENDENCY_KIND_LABELS[selected.kind]}</dd>
                  {selected.host && (
                    <>
                      <dt className="text-xs text-fg-subtle">Host</dt>
                      <dd className="font-mono text-xs">{selected.host}</dd>
                    </>
                  )}
                </dl>
              )}
            </section>
          )}

          <section aria-labelledby="map-connections" className="flex flex-col gap-2">
            <h3 id="map-connections" className="font-semibold">
              Connections ({edges.length})
            </h3>
            <ul aria-label="Connections" className="flex max-h-48 flex-col gap-1 overflow-y-auto">
              {edges.map((e) => (
                <li key={e.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {labelOf(e.source)} → {labelOf(e.target)}
                  </span>
                  <span
                    className={`rounded px-1 text-[11px] ${
                      e.data?.origin === 'INFERRED'
                        ? 'border border-dashed border-line text-fg-subtle'
                        : 'bg-surface-2 text-fg-muted'
                    }`}
                  >
                    {ORIGIN_LABEL[e.data?.origin ?? 'MANUAL']}
                  </span>
                  {canEdit && (
                    <button
                      type="button"
                      aria-label={`Remove connection ${labelOf(e.source)} to ${labelOf(e.target)}`}
                      onClick={() => {
                        setEdges((es) => es.filter((x) => x.id !== e.id));
                        changed();
                      }}
                      className="rounded p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {canEdit && nodes.length >= 2 && (
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (connectFrom && connectTo) connect(connectFrom, connectTo);
                }}
              >
                <SelectField
                  label="From (depends on…)"
                  value={connectFrom}
                  options={[{ value: '', label: 'Choose a node' }, ...nodeOptions]}
                  onChange={(e) => setConnectFrom(e.target.value)}
                />
                <SelectField
                  label="To"
                  value={connectTo}
                  options={[{ value: '', label: 'Choose a node' }, ...nodeOptions]}
                  onChange={(e) => setConnectTo(e.target.value)}
                />
                <Button type="submit" variant="secondary" disabled={!connectFrom || !connectTo}>
                  Connect
                </Button>
              </form>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
