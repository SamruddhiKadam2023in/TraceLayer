import type { Prisma } from '@tracelayer/db';
import {
  executeRequest,
  prepareRequest,
  RequestPreparationError,
  type ResolvedEnvironment,
} from '@tracelayer/executor';
import {
  HISTORY_RETENTION_PER_PROJECT,
  type EndpointRequest,
  type ExecuteRequestResponse,
  type ExecutionErrorCode,
  type HistoryEntry,
  type HistoryPage,
  type HistoryQueryParsed,
} from '@tracelayer/shared';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { decryptSecret } from '../utils/secret-box';
import type { ProjectAccess } from './access.service';

function fieldNotFound(path: string, message: string): AppError {
  return new AppError('NOT_FOUND', message, [{ path, message }]);
}

/** Loads the environment with secrets decrypted. Server-side only: never returned to a client. */
async function loadEnvironment(
  projectId: string,
  environmentId: string | null,
): Promise<ResolvedEnvironment | null> {
  if (environmentId === null) return null;
  const environment = await prisma.environment.findFirst({
    where: { id: environmentId, projectId },
    include: { variables: true },
  });
  if (!environment) throw fieldNotFound('environmentId', 'Environment not found in this project');
  return {
    name: environment.name,
    baseUrl: environment.baseUrl,
    variables: environment.variables.map((v) => ({
      key: v.key,
      isSecret: v.isSecret,
      value: v.isSecret ? decryptSecret(v.encryptedValue ?? '') : (v.value ?? ''),
    })),
  };
}

async function assertEndpointInProject(
  projectId: string,
  endpointId: string | null,
): Promise<void> {
  if (endpointId === null) return;
  const endpoint = await prisma.endpoint.findFirst({
    where: { id: endpointId, projectId },
    select: { id: true },
  });
  if (!endpoint) throw fieldNotFound('endpointId', 'Endpoint not found in this project');
}

/** Keeps the newest HISTORY_RETENTION_PER_PROJECT entries per project. */
async function pruneHistory(projectId: string): Promise<void> {
  const cutoff = await prisma.requestHistory.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    skip: HISTORY_RETENTION_PER_PROJECT,
    select: { createdAt: true },
  });
  if (cutoff) {
    await prisma.requestHistory.deleteMany({
      where: { projectId, createdAt: { lte: cutoff.createdAt } },
    });
  }
}

export interface ExecuteInput {
  environmentId: string | null;
  endpointId: string | null;
  request: EndpointRequest;
  saveToHistory: boolean;
}

/**
 * Runs a request on behalf of a user: substitutes the environment's variables (decrypting
 * secrets here, on the server), sends it with SSRF protection, and records the outcome.
 * Configuration problems are client errors (400/404); network outcomes are results.
 */
export async function runRequest(
  access: ProjectAccess,
  input: ExecuteInput,
): Promise<ExecuteRequestResponse> {
  await assertEndpointInProject(access.projectId, input.endpointId);
  const environment = await loadEnvironment(access.projectId, input.environmentId);

  let prepared;
  try {
    prepared = prepareRequest(input.request, environment);
  } catch (err) {
    if (err instanceof RequestPreparationError) {
      throw new AppError(
        'VALIDATION_ERROR',
        err.message,
        err.path ? [{ path: err.path, message: err.message }] : undefined,
      );
    }
    throw err;
  }

  const result = await executeRequest(prepared, {
    allowPrivateNetwork: env.ALLOW_PRIVATE_NETWORK_TARGETS,
  });

  let historyId: string | null = null;
  if (input.saveToHistory) {
    const entry = await prisma.requestHistory.create({
      data: {
        projectId: access.projectId,
        endpointId: input.endpointId,
        environmentId: input.environmentId,
        userId: access.userId,
        method: input.request.method,
        url: result.request.url.slice(0, 4096),
        status: result.response?.status ?? null,
        errorCode: result.error?.code ?? null,
        errorMessage: result.error?.message.slice(0, 500) ?? null,
        durationMs: result.durationMs,
        sizeBytes: result.response?.sizeBytes ?? null,
      },
      select: { id: true },
    });
    historyId = entry.id;
    // Housekeeping must never fail the request the user is waiting for.
    pruneHistory(access.projectId).catch((err: unknown) =>
      logger.warn({ err, projectId: access.projectId }, 'Pruning request history failed'),
    );
  }

  return { result, historyId };
}

// ─── History ─────────────────────────────────────────────────────────────────

const historyInclude = {
  endpoint: { select: { id: true, name: true } },
  environment: { select: { id: true, name: true } },
  user: { select: { id: true, name: true } },
} as const satisfies Prisma.RequestHistoryInclude;

type HistoryRow = Prisma.RequestHistoryGetPayload<{ include: typeof historyInclude }>;

function toEntry(row: HistoryRow): HistoryEntry {
  return {
    id: row.id,
    projectId: row.projectId,
    endpoint: row.endpoint,
    environment: row.environment,
    user: row.user,
    method: row.method,
    url: row.url,
    status: row.status,
    errorCode: row.errorCode as ExecutionErrorCode | null,
    errorMessage: row.errorMessage,
    durationMs: row.durationMs,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

function statusWhere(status: string | undefined): Prisma.RequestHistoryWhereInput {
  if (!status) return {};
  if (status === 'error') return { status: null };
  const hundred = Number(status[0]) * 100;
  return { status: { gte: hundred, lt: hundred + 100 } };
}

/**
 * Sort order with tie-breakers, so pagination never repeats or skips rows.
 * Failed requests have no status: they sort before 2xx ascending and last descending.
 */
function historyOrder(
  sort: 'createdAt' | 'durationMs' | 'status',
  order: 'asc' | 'desc',
): Prisma.RequestHistoryOrderByWithRelationInput[] {
  if (sort === 'createdAt') return [{ createdAt: order }, { id: order }];
  const primary: Prisma.RequestHistoryOrderByWithRelationInput =
    sort === 'status'
      ? { status: { sort: order, nulls: order === 'asc' ? 'first' : 'last' } }
      : { durationMs: order };
  return [primary, { createdAt: 'desc' }, { id: 'desc' }];
}

export async function listHistory(
  access: ProjectAccess,
  query: Omit<HistoryQueryParsed, 'projectId'>,
): Promise<HistoryPage> {
  const where: Prisma.RequestHistoryWhereInput = {
    projectId: access.projectId,
    ...(query.endpointId ? { endpointId: query.endpointId } : {}),
    ...(query.environmentId ? { environmentId: query.environmentId } : {}),
    ...(query.method ? { method: query.method } : {}),
    ...statusWhere(query.status),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        }
      : {}),
    ...(query.search ? { url: { contains: query.search, mode: 'insensitive' } } : {}),
  };

  const [total, rows] = await prisma.$transaction([
    prisma.requestHistory.count({ where }),
    prisma.requestHistory.findMany({
      where,
      include: historyInclude,
      orderBy: historyOrder(query.sort, query.order),
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  return { items: rows.map(toEntry), total, page: query.page, pageSize: query.pageSize };
}
