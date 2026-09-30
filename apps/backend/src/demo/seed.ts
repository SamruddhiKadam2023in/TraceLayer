import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Prisma, PrismaClient } from '@tracelayer/db';
import type { SecretBox } from '@tracelayer/executor';
import type { IncidentStatus } from '@tracelayer/shared';
import {
  DEMO_EMAIL_DOMAIN,
  DEMO_HISTORY_DAYS,
  DEMO_PROJECTS,
  DEMO_TEAMMATES,
  DEMO_WORKSPACE_NAME,
  type DemoMonitor,
  type DemoProject,
  type Person,
} from './demo-data';
import { generateHistory, type GeneratedIncident } from './generate';

export interface SeedOptions {
  /** Owner of the demo workspace (an existing account). */
  ownerId: string;
  /** "Now" for the generated history; tests pin it. */
  now?: Date;
  /** Called before the old demo workspace is deleted, with its monitor ids (to unschedule). */
  onRemovedMonitors?: (ids: string[]) => Promise<void>;
}

export interface SeedSummary {
  workspaceId: string;
  projects: number;
  endpoints: number;
  monitors: number;
  runs: number;
  incidents: number;
  activeIncidents: number;
}

const unusablePasswordHash = () => bcrypt.hash(randomBytes(32).toString('base64url'), 10);

/**
 * Creates (or recreates) the demo workspace for `ownerId` (spec §52): demo teammates, three
 * projects with environments, secrets, endpoints, paused monitors, a week of runs, alert rules,
 * alerts and incidents with their timelines, request history and a dependency map.
 *
 * Re-running replaces the owner's previous demo workspace, so the history always ends now.
 * Demo monitors start paused, so the generated history stays as generated until someone
 * resumes one (their endpoints are real public APIs, so they then run for real).
 */
export async function seedDemoWorkspace(
  prisma: PrismaClient,
  secrets: SecretBox,
  options: SeedOptions,
): Promise<SeedSummary> {
  const now = options.now ?? new Date();

  // Replace the owner's previous demo workspace.
  const previous = await prisma.workspace.findMany({
    where: { isDemo: true, members: { some: { userId: options.ownerId, role: 'OWNER' } } },
    select: { id: true },
  });
  if (previous.length) {
    const monitors = await prisma.monitor.findMany({
      where: { project: { workspaceId: { in: previous.map((w) => w.id) } } },
      select: { id: true },
    });
    await options.onRemovedMonitors?.(monitors.map((m) => m.id));
    await prisma.workspace.deleteMany({ where: { id: { in: previous.map((w) => w.id) } } });
  }

  // Demo teammates: accounts nobody can sign in to (random passwords, never shown).
  const people: Record<Person | 'viewer', { id: string; name: string }> = {
    owner: await prisma.user.findUniqueOrThrow({
      where: { id: options.ownerId },
      select: { id: true, name: true },
    }),
    teammate: { id: '', name: '' },
    viewer: { id: '', name: '' },
  };
  for (const mate of DEMO_TEAMMATES) {
    const user = await prisma.user.upsert({
      where: { email: mate.email },
      update: {},
      create: { name: mate.name, email: mate.email, passwordHash: await unusablePasswordHash() },
      select: { id: true, name: true },
    });
    people[mate.key] = user;
  }

  const workspace = await prisma.workspace.create({
    data: {
      name: DEMO_WORKSPACE_NAME,
      isDemo: true,
      members: {
        create: [
          { userId: options.ownerId, role: 'OWNER' },
          ...DEMO_TEAMMATES.map((m) => ({ userId: people[m.key].id, role: m.role })),
        ],
      },
    },
  });
  const channel = await prisma.notificationChannel.create({
    data: {
      workspaceId: workspace.id,
      name: 'On-call (demo)',
      type: 'EMAIL',
      // Disabled: the addresses are not real. Enable it with your own address to try alerts.
      enabled: false,
      config: { recipients: [`oncall@${DEMO_EMAIL_DOMAIN}`] },
    },
  });

  const summary: SeedSummary = {
    workspaceId: workspace.id,
    projects: 0,
    endpoints: 0,
    monitors: 0,
    runs: 0,
    incidents: 0,
    activeIncidents: 0,
  };
  for (const definition of DEMO_PROJECTS) {
    await seedProject(prisma, secrets, {
      definition,
      workspaceId: workspace.id,
      channelId: channel.id,
      people,
      now,
      summary,
    });
  }
  return summary;
}

interface ProjectContext {
  definition: DemoProject;
  workspaceId: string;
  channelId: string;
  people: Record<Person | 'viewer', { id: string; name: string }>;
  now: Date;
  summary: SeedSummary;
}

async function seedProject(prisma: PrismaClient, secrets: SecretBox, ctx: ProjectContext) {
  const { definition, people, now, summary } = ctx;
  const project = await prisma.project.create({
    data: {
      workspaceId: ctx.workspaceId,
      name: definition.name,
      description: definition.description,
      createdById: people.owner.id,
    },
  });
  summary.projects++;

  const production = await prisma.environment.create({
    data: {
      projectId: project.id,
      name: 'Production',
      baseUrl: definition.baseUrl,
      position: 2,
      variables: {
        create: definition.variables.map((v) =>
          v.secret
            ? { key: v.key, isSecret: true, encryptedValue: secrets.encrypt(v.value) }
            : { key: v.key, value: v.value },
        ),
      },
    },
  });
  await prisma.environment.createMany({
    data: [
      { projectId: project.id, name: 'Development', position: 0 },
      { projectId: project.id, name: 'Staging', baseUrl: definition.baseUrl, position: 1 },
    ],
  });

  const endpointIds = new Map<string, string>();
  for (const e of definition.endpoints) {
    const endpoint = await prisma.endpoint.create({
      data: {
        projectId: project.id,
        environmentId: production.id,
        name: e.name,
        description: e.description,
        method: e.method,
        url: e.url,
        headers: (e.headers ?? []) as Prisma.InputJsonValue,
        queryParams: (e.queryParams ?? []) as Prisma.InputJsonValue,
        body: (e.body ?? { type: 'none' }) as Prisma.InputJsonValue,
        auth: (e.auth ?? { type: 'none' }) as Prisma.InputJsonValue,
        expectedStatus: e.expectedStatus ?? null,
        tags: e.tags,
        createdById: people.owner.id,
      },
    });
    endpointIds.set(e.name, endpoint.id);
    summary.endpoints++;
  }

  // Monitors, their history and alert rules; incidents are numbered afterwards, in order.
  const incidents: {
    monitor: DemoMonitor;
    monitorId: string;
    ruleId: string;
    incident: GeneratedIncident;
  }[] = [];
  for (const m of definition.monitors) {
    const endpointId = endpointIds.get(m.endpoint)!;
    const history = generateHistory(m, now, DEMO_HISTORY_DAYS);
    const last = history.runs.at(-1);
    const monitor = await prisma.monitor.create({
      data: {
        projectId: project.id,
        endpointId,
        environmentId: production.id,
        name: m.name,
        type: m.type,
        intervalSeconds: m.intervalSeconds,
        timeoutMs: m.timeoutMs,
        expectedStatus: m.expectedStatus,
        latencyThresholdMs: m.latencyThresholdMs ?? null,
        assertions: (m.assertions ?? []) as Prisma.InputJsonValue,
        // Paused: the generated history stays as generated until someone resumes it.
        enabled: false,
        lastRunAt: last?.startedAt ?? null,
        lastRunSuccess: last?.success ?? null,
        consecutiveFailures: history.consecutiveFailures,
        createdById: people.owner.id,
      },
    });
    summary.monitors++;

    for (let i = 0; i < history.runs.length; i += 1000) {
      await prisma.monitorRun.createMany({
        data: history.runs.slice(i, i + 1000).map((run) => ({
          ...run,
          monitorId: monitor.id,
          projectId: project.id,
          endpointId,
          environmentId: production.id,
        })),
      });
    }
    summary.runs += history.runs.length;

    const rule = await prisma.alertRule.create({
      data: {
        projectId: project.id,
        monitorId: monitor.id,
        name: m.rule.name,
        metric: m.rule.metric,
        threshold: m.rule.threshold,
        durationMinutes: m.rule.durationMinutes,
        severity: m.rule.severity,
        state: history.rule.state,
        pendingSince: history.rule.pendingSince,
        lastValue: history.rule.lastValue,
        lastEvaluatedAt: history.rule.lastEvaluatedAt,
        channels: { create: { channelId: ctx.channelId } },
      },
    });
    for (const incident of history.incidents) {
      incidents.push({ monitor: m, monitorId: monitor.id, ruleId: rule.id, incident });
    }
  }

  incidents.sort((a, b) => a.incident.firedAt.getTime() - b.incident.firedAt.getTime());
  let number = 0;
  for (const item of incidents) {
    await seedIncident(prisma, { ...item, projectId: project.id, number: ++number, people, now });
    summary.incidents++;
    if (!item.incident.resolvedAt) summary.activeIncidents++;
  }
  await prisma.project.update({
    where: { id: project.id },
    data: { incidentCounter: number, dependencyVersion: definition.dependencies ? 1 : 0 },
  });

  await seedRequestHistory(prisma, ctx, project.id, production.id, endpointIds);
  if (definition.dependencies) await seedDependencyMap(prisma, definition, project.id);
}

async function seedIncident(
  prisma: PrismaClient,
  input: {
    monitor: DemoMonitor;
    monitorId: string;
    ruleId: string;
    incident: GeneratedIncident;
    projectId: string;
    number: number;
    people: Record<Person | 'viewer', { id: string; name: string }>;
    now: Date;
  },
) {
  const { monitor, incident, people, now } = input;
  const minutes = (m: number) => new Date(incident.firedAt.getTime() + m * 60_000);
  const end = incident.resolvedAt ?? now;
  const response = incident.scenario?.response;
  // Only what happened before the incident ended (or before now) is part of the story.
  const steps = (response?.steps ?? []).filter((s) => minutes(s.after) < end);

  type EventData = Omit<Prisma.IncidentEventCreateManyInput, 'incidentId'>;
  const events: EventData[] = [
    { type: 'DETECTED', createdAt: incident.firedAt },
    {
      type: 'ALERT_FIRED',
      message: `${monitor.rule.name}: ${incident.message}`,
      createdAt: incident.firedAt,
    },
  ];
  let status: IncidentStatus = 'OPEN';
  let acknowledgedAt: Date | null = null;
  let assigned = false;
  for (const step of steps) {
    const at = minutes(step.after);
    const actor = people[step.by];
    if (!assigned && response) {
      events.push({
        type: 'ASSIGNED',
        actorId: actor.id,
        toValue: people[response.assignee].name,
        createdAt: at,
      });
      assigned = true;
    }
    if ('status' in step) {
      events.push({
        type: 'STATUS_CHANGED',
        actorId: actor.id,
        fromValue: status,
        toValue: step.status,
        createdAt: at,
      });
      status = step.status;
      acknowledgedAt ??= at;
    } else {
      events.push({ type: 'COMMENT', actorId: actor.id, message: step.comment, createdAt: at });
    }
  }
  if (incident.resolvedAt) {
    events.push(
      {
        type: 'ALERT_RESOLVED',
        message: `${monitor.rule.name}: the condition cleared`,
        createdAt: incident.resolvedAt,
      },
      {
        type: 'STATUS_CHANGED',
        fromValue: status,
        toValue: 'RESOLVED',
        createdAt: incident.resolvedAt,
      },
    );
    const followUp = response?.followUp;
    const followUpAt =
      followUp && new Date(incident.resolvedAt.getTime() + followUp.after * 60_000);
    if (followUp && followUpAt && followUpAt < now) {
      events.push({
        type: 'COMMENT',
        actorId: people[followUp.by].id,
        message: followUp.comment,
        createdAt: followUpAt,
      });
    }
  }

  const title = `${monitor.name}: ${incident.message}`.slice(0, 300);
  const created = await prisma.incident.create({
    data: {
      projectId: input.projectId,
      number: input.number,
      monitorId: input.monitorId,
      title,
      severity: monitor.rule.severity,
      status: incident.resolvedAt ? 'RESOLVED' : status,
      assigneeId: assigned && response ? people[response.assignee].id : null,
      detectedAt: incident.firedAt,
      acknowledgedAt,
      resolvedAt: incident.resolvedAt,
      createdAt: incident.firedAt,
      events: { createMany: { data: events } },
      alerts: {
        create: {
          ruleId: input.ruleId,
          monitorId: input.monitorId,
          projectId: input.projectId,
          severity: monitor.rule.severity,
          status: incident.resolvedAt ? 'RESOLVED' : 'FIRING',
          value: incident.value,
          threshold: monitor.rule.threshold,
          message: incident.message.slice(0, 500),
          firedAt: incident.firedAt,
          resolvedAt: incident.resolvedAt,
        },
      },
    },
  });
  return created;
}

/** A few requests sent from the request builder over the last days. */
async function seedRequestHistory(
  prisma: PrismaClient,
  ctx: ProjectContext,
  projectId: string,
  environmentId: string,
  endpointIds: Map<string, string>,
) {
  const rows: Prisma.RequestHistoryCreateManyInput[] = [];
  const by = [ctx.people.owner.id, ctx.people.teammate.id];
  ctx.definition.endpoints.forEach((e, i) => {
    const query = (e.queryParams ?? []).map((q) => `${q.key}=${encodeURIComponent(q.value)}`);
    const url = `${ctx.definition.baseUrl}${e.url}${query.length ? `?${query.join('&')}` : ''}`;
    // "Current user" needs a token that is not set: its sends show the missing-variable error.
    const missingToken = e.auth?.type === 'bearer' && e.auth.token.includes('ACCESS_TOKEN');
    for (let n = 0; n < 4; n++) {
      rows.push({
        projectId,
        environmentId,
        endpointId: endpointIds.get(e.name)!,
        userId: by[(i + n) % 2]!,
        method: e.method,
        url,
        status: missingToken ? null : e.method === 'POST' && e.url.includes('carts') ? 201 : 200,
        errorCode: missingToken ? 'CONFIG_ERROR' : null,
        errorMessage: missingToken ? 'Variable ACCESS_TOKEN is not defined in Production' : null,
        durationMs: missingToken ? 1 : 180 + ((i * 97 + n * 53) % 260),
        sizeBytes: missingToken ? null : 900 + ((i * 331 + n * 71) % 2200),
        createdAt: new Date(ctx.now.getTime() - (n * 19 + i * 7 + 3) * 3_600_000),
      });
    }
  });
  await prisma.requestHistory.createMany({ data: rows });
}

async function seedDependencyMap(prisma: PrismaClient, definition: DemoProject, projectId: string) {
  const deps = definition.dependencies!;
  const ids = new Map(deps.nodes.map((n) => [n.key, randomUUID()]));
  await prisma.dependencyNode.createMany({
    data: deps.nodes.map((n) => ({
      id: ids.get(n.key)!,
      projectId,
      label: n.label,
      kind: n.kind,
      origin: n.inferred ? 'INFERRED' : 'MANUAL',
      host: n.host,
      x: n.x,
      y: n.y,
    })),
  });
  await prisma.dependencyEdge.createMany({
    data: deps.edges.map((e) => ({
      id: randomUUID(),
      projectId,
      sourceId: ids.get(e.from)!,
      targetId: ids.get(e.to)!,
      origin: e.inferred ? 'INFERRED' : 'MANUAL',
      label: e.label ?? null,
    })),
  });
}
