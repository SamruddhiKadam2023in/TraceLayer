import { randomUUID } from 'node:crypto';
import type { Prisma } from '@tracelayer/db';
import {
  HEALTH_SEVERITY,
  resolveHost,
  type DependencyEdgeView,
  type DependencyMapView,
  type DependencyNodeView,
  type DependencySuggestions,
  type HealthStatus,
  type SaveDependencyMapInput,
  saveDependencyMapSchema,
} from '@tracelayer/shared';
import { lockRow } from '../lib/locks';
import { prisma } from '../lib/prisma';
import { AppError } from '../utils/errors';
import type { ProjectAccess } from './access.service';
import { healthByMonitor } from './metrics.service';

type HostHealth = Map<string, { health: HealthStatus; monitorCount: number }>;

/**
 * The hosts the project's monitors call, each with the worst health among those monitors.
 * This is what lights up nodes on the map, and what inference starts from.
 */
async function monitoredHosts(projectId: string): Promise<HostHealth> {
  const monitors = await prisma.monitor.findMany({
    where: { projectId },
    select: {
      id: true,
      endpoint: { select: { url: true } },
      environment: { select: { baseUrl: true } },
    },
  });
  const health = await healthByMonitor(monitors.map((m) => m.id));
  const hosts: HostHealth = new Map();
  for (const monitor of monitors) {
    const host = resolveHost(monitor.endpoint.url, monitor.environment?.baseUrl ?? null);
    if (!host) continue;
    const current = hosts.get(host);
    const monitorHealth = health.get(monitor.id) ?? 'NO_DATA';
    hosts.set(host, {
      health:
        current && HEALTH_SEVERITY[current.health] >= HEALTH_SEVERITY[monitorHealth]
          ? current.health
          : monitorHealth,
      monitorCount: (current?.monitorCount ?? 0) + 1,
    });
  }
  return hosts;
}

type NodeRow = Prisma.DependencyNodeGetPayload<object>;
type EdgeRow = Prisma.DependencyEdgeGetPayload<object>;

function toNodeView(node: NodeRow, hosts: HostHealth): DependencyNodeView {
  const monitored = node.host ? hosts.get(node.host) : undefined;
  return {
    id: node.id,
    label: node.label,
    kind: node.kind,
    origin: node.origin,
    host: node.host,
    x: node.x,
    y: node.y,
    health: monitored?.health ?? null,
    monitorCount: monitored?.monitorCount ?? 0,
  };
}

function toEdgeView(edge: EdgeRow): DependencyEdgeView {
  return {
    id: edge.id,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    origin: edge.origin,
    label: edge.label,
  };
}

export async function getMap(access: ProjectAccess): Promise<DependencyMapView> {
  const [project, nodes, edges, hosts] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { id: access.projectId },
      select: { dependencyVersion: true },
    }),
    prisma.dependencyNode.findMany({
      where: { projectId: access.projectId },
      orderBy: [{ y: 'asc' }, { x: 'asc' }],
    }),
    prisma.dependencyEdge.findMany({ where: { projectId: access.projectId } }),
    monitoredHosts(access.projectId),
  ]);
  return {
    projectId: access.projectId,
    version: project.dependencyVersion,
    nodes: nodes.map((n) => toNodeView(n, hosts)),
    edges: edges.map(toEdgeView),
  };
}

/**
 * Replaces the diagram (spec §30 "save diagrams") in one transaction. The project row is
 * locked and the version compared, so two people editing the same map cannot silently
 * overwrite each other: the second save is refused and they reload.
 */
export async function saveMap(
  access: ProjectAccess,
  input: SaveDependencyMapInput,
): Promise<DependencyMapView> {
  const map = saveDependencyMapSchema.parse(input);
  const ids = [...map.nodes.map((n) => n.id), ...map.edges.map((e) => e.id)];

  await prisma.$transaction(async (tx) => {
    await lockRow(tx, 'projects', access.projectId);
    const project = await tx.project.findUniqueOrThrow({
      where: { id: access.projectId },
      select: { dependencyVersion: true },
    });
    if (project.dependencyVersion !== map.version) {
      throw new AppError(
        'CONFLICT',
        'Someone else saved this map since you opened it. Reload to see their changes.',
      );
    }
    // Ids are chosen by the editor; one that belongs to another project is never reused.
    const [foreignNodes, foreignEdges] = await Promise.all([
      tx.dependencyNode.count({ where: { id: { in: ids }, projectId: { not: access.projectId } } }),
      tx.dependencyEdge.count({ where: { id: { in: ids }, projectId: { not: access.projectId } } }),
    ]);
    if (foreignNodes + foreignEdges > 0) {
      throw new AppError('VALIDATION_ERROR', 'The map contains ids that are already in use');
    }

    await tx.dependencyNode.deleteMany({ where: { projectId: access.projectId } });
    await tx.dependencyNode.createMany({
      data: map.nodes.map((n) => ({ ...n, projectId: access.projectId })),
    });
    await tx.dependencyEdge.createMany({
      data: map.edges.map((e) => ({ ...e, projectId: access.projectId })),
    });
    await tx.project.update({
      where: { id: access.projectId },
      data: { dependencyVersion: { increment: 1 } },
    });
  });
  return getMap(access);
}

const ROW_GAP = 160;
const COLUMN_GAP = 220;

/**
 * Inferred dependencies (spec §30, "clearly distinguish manual from inferred"): every host the
 * project's endpoints and monitors call becomes a service node, connected from the map's entry
 * point (the first Frontend or API gateway node, or a suggested "Clients" node). Only what is
 * not on the map yet is suggested; nothing is saved until the user saves.
 */
export async function suggest(access: ProjectAccess): Promise<DependencySuggestions> {
  const [existing, edges, endpoints, hosts] = await Promise.all([
    prisma.dependencyNode.findMany({ where: { projectId: access.projectId } }),
    prisma.dependencyEdge.findMany({ where: { projectId: access.projectId } }),
    prisma.endpoint.findMany({
      where: { projectId: access.projectId },
      select: { url: true, environment: { select: { baseUrl: true } } },
    }),
    monitoredHosts(access.projectId),
  ]);

  // Monitored hosts first (they carry health), then hosts only saved endpoints call.
  const allHosts = new Set(hosts.keys());
  for (const endpoint of endpoints) {
    const host = resolveHost(endpoint.url, endpoint.environment?.baseUrl ?? null);
    if (host) allHosts.add(host);
  }
  const onMap = new Set(existing.map((n) => n.host).filter((h): h is string => h !== null));
  const newHosts = [...allHosts].filter((h) => !onMap.has(h)).sort();

  const baseY = existing.length ? Math.max(...existing.map((n) => n.y)) + ROW_GAP : 0;
  const nodes: DependencyNodeView[] = [];

  const anchor = existing
    .filter((n) => n.kind === 'FRONTEND' || n.kind === 'GATEWAY')
    .sort((a, b) => a.y - b.y || a.x - b.x)[0];
  let anchorId = anchor?.id;
  let hostRowY = baseY;
  if (!anchor && (newHosts.length > 0 || onMap.size > 0)) {
    anchorId = randomUUID();
    nodes.push({
      id: anchorId,
      label: 'Clients',
      kind: 'FRONTEND',
      origin: 'INFERRED',
      host: null,
      x: Math.max(0, ((newHosts.length - 1) * COLUMN_GAP) / 2),
      y: baseY,
      health: null,
      monitorCount: 0,
    });
    hostRowY = baseY + ROW_GAP;
  }

  newHosts.forEach((host, i) => {
    const monitored = hosts.get(host);
    nodes.push({
      id: randomUUID(),
      label: host,
      kind: 'SERVICE',
      origin: 'INFERRED',
      host,
      x: i * COLUMN_GAP,
      y: hostRowY,
      health: monitored?.health ?? null,
      monitorCount: monitored?.monitorCount ?? 0,
    });
  });

  // Connect the entry point to every host node nothing depends on yet.
  const hasIncoming = new Set(edges.map((e) => e.targetId));
  const targets = [
    ...existing.filter((n) => n.host && !hasIncoming.has(n.id) && n.id !== anchorId),
    ...nodes.filter((n) => n.host),
  ];
  const suggestedEdges: DependencyEdgeView[] = anchorId
    ? targets.map((target) => ({
        id: randomUUID(),
        sourceId: anchorId,
        targetId: target.id,
        origin: 'INFERRED',
        label: null,
      }))
    : [];

  // A suggested "Clients" node alone, with nothing to connect, is not worth suggesting.
  if (suggestedEdges.length === 0) return { nodes: nodes.filter((n) => n.host), edges: [] };
  return { nodes, edges: suggestedEdges };
}
