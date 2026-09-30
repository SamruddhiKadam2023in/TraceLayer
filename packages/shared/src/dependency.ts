import { z } from 'zod';
import type { HealthStatus } from './metrics';

// ─── API dependency map (spec §30) ───────────────────────────────────────────

export const DEPENDENCY_NODE_KINDS = [
  'FRONTEND',
  'GATEWAY',
  'SERVICE',
  'DATABASE',
  'CACHE',
  'QUEUE',
  'EXTERNAL',
] as const;
export type DependencyNodeKind = (typeof DEPENDENCY_NODE_KINDS)[number];

export const DEPENDENCY_KIND_LABELS: Record<DependencyNodeKind, string> = {
  FRONTEND: 'Frontend',
  GATEWAY: 'API gateway',
  SERVICE: 'Service',
  DATABASE: 'Database',
  CACHE: 'Cache',
  QUEUE: 'Queue',
  EXTERNAL: 'External API',
};

/** Drawn by a person, or suggested by TraceLayer from the project's endpoints and monitors. */
export const DEPENDENCY_ORIGINS = ['MANUAL', 'INFERRED'] as const;
export type DependencyOrigin = (typeof DEPENDENCY_ORIGINS)[number];

export const MAX_DEPENDENCY_NODES = 100;
export const MAX_DEPENDENCY_EDGES = 300;
const COORDINATE_LIMIT = 100_000;

/** Lowercase host[:port], as in a URL. Letters, digits, dots, hyphens; optional port. */
const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253, 'Host is too long')
  .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/, 'Enter a host such as api.example.com');

const coordinate = z
  .number()
  .finite()
  .min(-COORDINATE_LIMIT)
  .max(COORDINATE_LIMIT)
  .transform((v) => Math.round(v));

export const dependencyNodeSchema = z.object({
  id: z.uuid(),
  label: z.string().trim().min(1, 'Name the node').max(60, 'At most 60 characters'),
  kind: z.enum(DEPENDENCY_NODE_KINDS),
  origin: z.enum(DEPENDENCY_ORIGINS),
  /** Links the node to monitored traffic: its health comes from monitors calling this host. */
  host: hostSchema.nullable(),
  x: coordinate,
  y: coordinate,
});
export type DependencyNodeInput = z.input<typeof dependencyNodeSchema>;

export const dependencyEdgeSchema = z.object({
  id: z.uuid(),
  /** The dependent (caller). */
  sourceId: z.uuid(),
  /** What it depends on. */
  targetId: z.uuid(),
  origin: z.enum(DEPENDENCY_ORIGINS),
  label: z.string().trim().max(60, 'At most 60 characters').nullable(),
});
export type DependencyEdgeInput = z.input<typeof dependencyEdgeSchema>;

/** Saving replaces the whole diagram, and only if nobody saved since `version` was loaded. */
export const saveDependencyMapSchema = z
  .object({
    projectId: z.uuid('Invalid project'),
    version: z.number().int().min(0),
    nodes: z
      .array(dependencyNodeSchema)
      .max(MAX_DEPENDENCY_NODES, `At most ${MAX_DEPENDENCY_NODES} nodes`),
    edges: z
      .array(dependencyEdgeSchema)
      .max(MAX_DEPENDENCY_EDGES, `At most ${MAX_DEPENDENCY_EDGES} connections`),
  })
  .superRefine((map, ctx) => {
    const nodeIds = new Set<string>();
    map.nodes.forEach((node, i) => {
      if (nodeIds.has(node.id)) {
        ctx.addIssue({ code: 'custom', path: ['nodes', i, 'id'], message: 'Duplicate node' });
      }
      nodeIds.add(node.id);
    });
    const edgeIds = new Set<string>();
    const pairs = new Set<string>();
    map.edges.forEach((edge, i) => {
      const path = ['edges', i];
      if (edgeIds.has(edge.id) || nodeIds.has(edge.id)) {
        ctx.addIssue({ code: 'custom', path: [...path, 'id'], message: 'Duplicate id' });
      }
      edgeIds.add(edge.id);
      if (!nodeIds.has(edge.sourceId) || !nodeIds.has(edge.targetId)) {
        ctx.addIssue({ code: 'custom', path, message: 'Connects a node that is not on the map' });
      } else if (edge.sourceId === edge.targetId) {
        ctx.addIssue({ code: 'custom', path, message: 'A node cannot depend on itself' });
      }
      const pair = `${edge.sourceId}>${edge.targetId}`;
      if (pairs.has(pair)) {
        ctx.addIssue({ code: 'custom', path, message: 'These nodes are already connected' });
      }
      pairs.add(pair);
    });
  });
export type SaveDependencyMapInput = z.input<typeof saveDependencyMapSchema>;

export const dependencyMapQuerySchema = z.object({ projectId: z.uuid('Invalid project') });

export interface DependencyNodeView {
  id: string;
  label: string;
  kind: DependencyNodeKind;
  origin: DependencyOrigin;
  host: string | null;
  x: number;
  y: number;
  /** Worst health of the monitors calling `host`; null when no monitor calls it. */
  health: HealthStatus | null;
  monitorCount: number;
}

export interface DependencyEdgeView {
  id: string;
  sourceId: string;
  targetId: string;
  origin: DependencyOrigin;
  label: string | null;
}

export interface DependencyMapView {
  projectId: string;
  /** Increases with every save; send it back when saving. */
  version: number;
  nodes: DependencyNodeView[];
  edges: DependencyEdgeView[];
}

/** What TraceLayer can infer that is not on the map yet. Nothing is saved until the user saves. */
export interface DependencySuggestions {
  nodes: DependencyNodeView[];
  edges: DependencyEdgeView[];
}

/** Worst first, for a node that summarises several monitors. */
export const HEALTH_SEVERITY: Record<HealthStatus, number> = {
  FAILING: 3,
  DEGRADED: 2,
  HEALTHY: 1,
  NO_DATA: 0,
};

/**
 * The host an endpoint URL points at, resolved against an environment base URL when the URL is
 * relative. Template variables ({{name}}) cannot be resolved here, so such hosts are skipped.
 */
export function resolveHost(url: string, baseUrl: string | null): string | null {
  try {
    const resolved = baseUrl ? new URL(url, `${baseUrl.replace(/\/+$/, '')}/`) : new URL(url);
    if (!/^https?:$/.test(resolved.protocol) || resolved.host.includes('{')) return null;
    return resolved.host.toLowerCase();
  } catch {
    return null;
  }
}
