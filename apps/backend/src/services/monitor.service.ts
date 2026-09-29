import type { Prisma } from '@tracelayer/db';
import { prepareRequest, RequestPreparationError } from '@tracelayer/executor';
import {
  assertionSchema,
  endpointRequestSchema,
  MAX_MONITORS_PER_PROJECT,
  monitorConfigSchema,
  type FailureReason,
  type MonitorConfig,
  type MonitorRunView,
  type MonitorView,
  type UpdateMonitorInput,
} from '@tracelayer/shared';
import { lockRow } from '../lib/locks';
import { enqueueMonitorRun, syncMonitorSchedule, unscheduleMonitor } from '../lib/monitor-queue';
import { prisma } from '../lib/prisma';
import { AppError } from '../utils/errors';
import { compareNames } from '../utils/sort';
import type { MonitorAccess, ProjectAccess } from './access.service';
import { loadResolvedEnvironment } from './resolved-environment.service';

const monitorInclude = {
  endpoint: { select: { id: true, name: true, method: true, url: true } },
  environment: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
} as const satisfies Prisma.MonitorInclude;

type MonitorRow = Prisma.MonitorGetPayload<{ include: typeof monitorInclude }>;

function toView(row: MonitorRow): MonitorView {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    endpointId: row.endpointId,
    // A deleted environment leaves the monitor without one; it reports CONFIG_ERROR until fixed.
    environmentId: row.environmentId ?? '',
    type: row.type,
    intervalSeconds: row.intervalSeconds,
    timeoutMs: row.timeoutMs,
    expectedStatus: row.expectedStatus,
    latencyThresholdMs: row.latencyThresholdMs,
    assertions: assertionSchema.array().catch([]).parse(row.assertions),
    enabled: row.enabled,
    endpoint: row.endpoint,
    environment: row.environment,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastRunSuccess: row.lastRunSuccess,
    consecutiveFailures: row.consecutiveFailures,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toColumns(config: MonitorConfig) {
  return {
    name: config.name,
    endpointId: config.endpointId,
    environmentId: config.environmentId,
    type: config.type,
    intervalSeconds: config.intervalSeconds,
    timeoutMs: config.timeoutMs,
    expectedStatus: config.expectedStatus,
    latencyThresholdMs: config.latencyThresholdMs,
    assertions: config.assertions as Prisma.InputJsonValue,
    enabled: config.enabled,
  };
}

function fieldError(
  code: 'CONFLICT' | 'NOT_FOUND' | 'VALIDATION_ERROR',
  path: string,
  message: string,
) {
  return new AppError(code, message, [{ path, message }]);
}

async function assertNameAvailable(
  tx: Prisma.TransactionClient,
  projectId: string,
  name: string,
  exceptId?: string,
): Promise<void> {
  const clash = await tx.monitor.findFirst({
    where: {
      projectId,
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw fieldError('CONFLICT', 'name', 'A monitor with this name already exists');
}

/**
 * Checks the endpoint and environment belong to the project, and that the request can actually
 * be built there (variables defined, base URL set, secrets allowed). Catching this when the
 * monitor is saved beats reporting the same configuration error every minute.
 */
async function validateTarget(projectId: string, endpointId: string, environmentId: string) {
  const endpoint = await prisma.endpoint.findFirst({ where: { id: endpointId, projectId } });
  if (!endpoint) throw fieldError('NOT_FOUND', 'endpointId', 'Endpoint not found in this project');
  const environment = await loadResolvedEnvironment(projectId, environmentId);

  const request = endpointRequestSchema.parse({
    method: endpoint.method,
    url: endpoint.url,
    headers: endpoint.headers,
    queryParams: endpoint.queryParams,
    body: endpoint.body,
    auth: endpoint.auth,
    timeoutMs: endpoint.timeoutMs,
  });
  try {
    prepareRequest(request, environment);
  } catch (err) {
    if (err instanceof RequestPreparationError) {
      throw fieldError(
        'VALIDATION_ERROR',
        'environmentId',
        `This endpoint cannot run in ${environment?.name ?? 'this environment'}: ${err.message}`,
      );
    }
    throw err;
  }
  return endpoint;
}

export async function listMonitors(access: ProjectAccess): Promise<MonitorView[]> {
  const rows = await prisma.monitor.findMany({
    where: { projectId: access.projectId },
    include: monitorInclude,
  });
  return rows.map(toView).sort((a, b) => compareNames(a.name, b.name));
}

export interface CreateMonitorData extends Omit<MonitorConfig, 'timeoutMs'> {
  timeoutMs?: number;
}

export async function createMonitor(
  access: ProjectAccess,
  input: CreateMonitorData,
): Promise<MonitorView> {
  const endpoint = await validateTarget(access.projectId, input.endpointId, input.environmentId);
  // Defaults the timeout to the endpoint's, then applies the cross-field rules.
  const config = monitorConfigSchema.parse({
    ...input,
    timeoutMs: input.timeoutMs ?? endpoint.timeoutMs,
  });

  const row = await prisma.$transaction(async (tx) => {
    await lockRow(tx, 'projects', access.projectId);
    const count = await tx.monitor.count({ where: { projectId: access.projectId } });
    if (count >= MAX_MONITORS_PER_PROJECT) {
      throw new AppError(
        'CONFLICT',
        `A project can have at most ${MAX_MONITORS_PER_PROJECT} monitors`,
      );
    }
    await assertNameAvailable(tx, access.projectId, config.name);
    return tx.monitor.create({
      data: { projectId: access.projectId, createdById: access.userId, ...toColumns(config) },
      include: monitorInclude,
    });
  });

  await syncMonitorSchedule(row);
  return toView(row);
}

export async function getMonitor(access: MonitorAccess): Promise<MonitorView> {
  const row = await prisma.monitor.findUniqueOrThrow({
    where: { id: access.monitorId },
    include: monitorInclude,
  });
  return toView(row);
}

/** Partial update, merged into the stored monitor and validated as a whole. */
export async function updateMonitor(
  access: MonitorAccess,
  changes: UpdateMonitorInput,
): Promise<MonitorView> {
  const current = await getMonitor(access);
  const config = monitorConfigSchema.parse({ ...current, ...changes });
  if (
    changes.endpointId !== undefined ||
    changes.environmentId !== undefined ||
    !current.environment
  ) {
    await validateTarget(access.projectId, config.endpointId, config.environmentId);
  }

  const row = await prisma.$transaction(async (tx) => {
    if (changes.name !== undefined) {
      await lockRow(tx, 'projects', access.projectId);
      await assertNameAvailable(tx, access.projectId, config.name, access.monitorId);
    }
    return tx.monitor.update({
      where: { id: access.monitorId },
      data: toColumns(config),
      include: monitorInclude,
    });
  });

  await syncMonitorSchedule(row);
  return toView(row);
}

export async function deleteMonitor(access: MonitorAccess): Promise<void> {
  await prisma.monitor.delete({ where: { id: access.monitorId } });
  await unscheduleMonitor(access.monitorId);
}

/** Queues an immediate check; the worker runs it like a scheduled one. */
export async function runMonitorNow(access: MonitorAccess): Promise<void> {
  try {
    await enqueueMonitorRun(access.monitorId);
  } catch {
    throw new AppError('UPSTREAM_ERROR', 'The job queue is unavailable. Try again shortly.');
  }
}

export async function listRuns(
  access: MonitorAccess,
  query: { limit: number; before?: string },
): Promise<MonitorRunView[]> {
  const runs = await prisma.monitorRun.findMany({
    where: {
      monitorId: access.monitorId,
      ...(query.before ? { startedAt: { lt: new Date(query.before) } } : {}),
    },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: query.limit,
  });
  return runs.map((run) => ({
    id: run.id,
    monitorId: run.monitorId,
    startedAt: run.startedAt.toISOString(),
    success: run.success,
    statusCode: run.statusCode,
    durationMs: run.durationMs,
    sizeBytes: run.sizeBytes,
    timedOut: run.timedOut,
    failureReason: run.failureReason as FailureReason | null,
    failureMessage: run.failureMessage,
  }));
}
