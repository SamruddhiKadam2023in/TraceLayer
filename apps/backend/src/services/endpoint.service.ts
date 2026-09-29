import type { Prisma } from '@tracelayer/db';
import {
  endpointConfigSchema,
  MAX_ENDPOINTS_PER_PROJECT,
  type EndpointConfig,
  type EndpointView,
  type HttpMethod,
  type UpdateEndpointInput,
} from '@tracelayer/shared';
import { lockRow } from '../lib/locks';
import { prisma } from '../lib/prisma';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { compareNames } from '../utils/sort';
import type { EndpointAccess, ProjectAccess } from './access.service';

const endpointInclude = {
  createdBy: { select: { id: true, name: true } },
} as const satisfies Prisma.EndpointInclude;

type EndpointRow = Prisma.EndpointGetPayload<{ include: typeof endpointInclude }>;

/**
 * Stored JSON is re-validated on the way out. A row that no longer matches the schema is a
 * server bug, and failing loudly beats sending the client malformed configuration.
 */
function toView(row: EndpointRow): EndpointView {
  const parsed = endpointConfigSchema.safeParse({
    name: row.name,
    description: row.description,
    method: row.method,
    url: row.url,
    environmentId: row.environmentId,
    headers: row.headers,
    queryParams: row.queryParams,
    body: row.body,
    auth: row.auth,
    timeoutMs: row.timeoutMs,
    expectedStatus: row.expectedStatus,
    tags: row.tags,
  });
  if (!parsed.success) {
    // Not the client's fault: surface as a 500 (a plain Error) and log what was wrong.
    logger.error({ endpointId: row.id, issues: parsed.error.issues }, 'Stored endpoint is invalid');
    throw new Error(`Stored endpoint ${row.id} failed validation`);
  }
  return {
    id: row.id,
    projectId: row.projectId,
    ...parsed.data,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toColumns(config: EndpointConfig) {
  return {
    name: config.name,
    description: config.description,
    method: config.method,
    url: config.url,
    environmentId: config.environmentId,
    headers: config.headers,
    queryParams: config.queryParams,
    body: config.body,
    auth: config.auth,
    timeoutMs: config.timeoutMs,
    expectedStatus: config.expectedStatus,
    tags: config.tags,
  } satisfies Prisma.EndpointUncheckedUpdateInput;
}

function fieldError(code: 'CONFLICT' | 'NOT_FOUND', path: string, message: string): AppError {
  return new AppError(code, message, [{ path, message }]);
}

async function assertNameAvailable(
  tx: Prisma.TransactionClient,
  projectId: string,
  name: string,
  exceptId?: string,
): Promise<void> {
  const clash = await tx.endpoint.findFirst({
    where: {
      projectId,
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw fieldError('CONFLICT', 'name', 'An endpoint with this name already exists');
}

/** The default environment must belong to the same project. */
async function assertEnvironmentInProject(
  tx: Prisma.TransactionClient,
  projectId: string,
  environmentId: string | null,
): Promise<void> {
  if (environmentId === null) return;
  const environment = await tx.environment.findFirst({
    where: { id: environmentId, projectId },
    select: { id: true },
  });
  if (!environment) {
    throw fieldError('NOT_FOUND', 'environmentId', 'Environment not found in this project');
  }
}

export interface EndpointFilters {
  search?: string;
  method?: HttpMethod;
  tag?: string;
}

export async function listEndpoints(
  access: ProjectAccess,
  filters: EndpointFilters = {},
): Promise<EndpointView[]> {
  const rows = await prisma.endpoint.findMany({
    where: {
      projectId: access.projectId,
      ...(filters.method ? { method: filters.method } : {}),
      ...(filters.tag ? { tags: { has: filters.tag } } : {}),
      ...(filters.search
        ? {
            OR: [
              { name: { contains: filters.search, mode: 'insensitive' } },
              { url: { contains: filters.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: endpointInclude,
  });
  return rows.map(toView).sort((a, b) => compareNames(a.name, b.name));
}

export async function createEndpoint(
  access: ProjectAccess,
  config: EndpointConfig,
): Promise<EndpointView> {
  return prisma.$transaction(async (tx) => {
    await lockRow(tx, 'projects', access.projectId);
    const count = await tx.endpoint.count({ where: { projectId: access.projectId } });
    if (count >= MAX_ENDPOINTS_PER_PROJECT) {
      throw new AppError(
        'CONFLICT',
        `A project can have at most ${MAX_ENDPOINTS_PER_PROJECT} endpoints`,
      );
    }
    await assertNameAvailable(tx, access.projectId, config.name);
    await assertEnvironmentInProject(tx, access.projectId, config.environmentId);

    const row = await tx.endpoint.create({
      data: { projectId: access.projectId, createdById: access.userId, ...toColumns(config) },
      include: endpointInclude,
    });
    return toView(row);
  });
}

export async function getEndpoint(access: EndpointAccess): Promise<EndpointView> {
  const row = await prisma.endpoint.findUniqueOrThrow({
    where: { id: access.endpointId },
    include: endpointInclude,
  });
  return toView(row);
}

/**
 * Applies a partial update. The merged result is validated as a whole, so cross-field rules
 * (such as "GET cannot have a body") hold however the change is split across requests.
 */
export async function updateEndpoint(
  access: EndpointAccess,
  changes: UpdateEndpointInput,
): Promise<EndpointView> {
  return prisma.$transaction(async (tx) => {
    await lockRow(tx, 'projects', access.projectId);
    const current = toView(
      await tx.endpoint.findUniqueOrThrow({
        where: { id: access.endpointId },
        include: endpointInclude,
      }),
    );
    const config = endpointConfigSchema.parse({ ...current, ...changes });

    if (changes.name !== undefined) {
      await assertNameAvailable(tx, access.projectId, config.name, access.endpointId);
    }
    if (changes.environmentId !== undefined) {
      await assertEnvironmentInProject(tx, access.projectId, config.environmentId);
    }

    const row = await tx.endpoint.update({
      where: { id: access.endpointId },
      data: toColumns(config),
      include: endpointInclude,
    });
    return toView(row);
  });
}

export async function deleteEndpoint(access: EndpointAccess): Promise<void> {
  await prisma.endpoint.delete({ where: { id: access.endpointId } });
}
