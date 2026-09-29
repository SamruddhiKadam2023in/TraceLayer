import type { EnvironmentVariable, Prisma } from '@tracelayer/db';
import {
  MAX_ENVIRONMENTS_PER_PROJECT,
  MAX_VARIABLES_PER_ENVIRONMENT,
  type EnvironmentVariableView,
  type EnvironmentView,
} from '@tracelayer/shared';
import { lockRow } from '../lib/locks';
import { prisma } from '../lib/prisma';
import { AppError } from '../utils/errors';
import { encryptSecret } from '../utils/secret-box';
import type { ProjectAccess } from './access.service';

const environmentInclude = {
  variables: { orderBy: { key: 'asc' } },
} as const satisfies Prisma.EnvironmentInclude;

type EnvironmentRow = Prisma.EnvironmentGetPayload<{ include: typeof environmentInclude }>;

/** Secret values never leave the server: the view carries only the key and the secret flag. */
export function toVariableView(variable: EnvironmentVariable): EnvironmentVariableView {
  return {
    id: variable.id,
    key: variable.key,
    isSecret: variable.isSecret,
    value: variable.isSecret ? null : variable.value,
    updatedAt: variable.updatedAt.toISOString(),
  };
}

function toView(environment: EnvironmentRow): EnvironmentView {
  return {
    id: environment.id,
    projectId: environment.projectId,
    name: environment.name,
    baseUrl: environment.baseUrl,
    variables: environment.variables.map(toVariableView),
    createdAt: environment.createdAt.toISOString(),
    updatedAt: environment.updatedAt.toISOString(),
  };
}

/** Column values for a variable: plaintext in `value`, or ciphertext in `encryptedValue`. */
function storedValue(value: string, isSecret: boolean) {
  return isSecret
    ? { isSecret: true, value: null, encryptedValue: encryptSecret(value) }
    : { isSecret: false, value, encryptedValue: null };
}

function fieldConflict(path: string, message: string): AppError {
  return new AppError('CONFLICT', message, [{ path, message }]);
}

async function assertEnvironmentNameAvailable(
  tx: Prisma.TransactionClient,
  projectId: string,
  name: string,
  exceptId?: string,
): Promise<void> {
  const clash = await tx.environment.findFirst({
    where: {
      projectId,
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw fieldConflict('name', 'An environment with this name already exists');
}

/** Loads an environment only if it belongs to the authorized project. */
async function findEnvironment(
  db: Prisma.TransactionClient,
  access: ProjectAccess,
  environmentId: string,
) {
  const environment = await db.environment.findFirst({
    where: { id: environmentId, projectId: access.projectId },
  });
  if (!environment) throw AppError.notFound('Environment');
  return environment;
}

// ─── Environments ────────────────────────────────────────────────────────────

export async function listEnvironments(access: ProjectAccess): Promise<EnvironmentView[]> {
  const environments = await prisma.environment.findMany({
    where: { projectId: access.projectId },
    include: environmentInclude,
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
  return environments.map(toView);
}

export async function createEnvironment(
  access: ProjectAccess,
  input: { name: string; baseUrl?: string | null },
): Promise<EnvironmentView> {
  return prisma.$transaction(async (tx) => {
    await lockRow(tx, 'projects', access.projectId);
    const { _count: count, _max: max } = await tx.environment.aggregate({
      where: { projectId: access.projectId },
      _count: true,
      _max: { position: true },
    });
    if (count >= MAX_ENVIRONMENTS_PER_PROJECT) {
      throw new AppError(
        'CONFLICT',
        `A project can have at most ${MAX_ENVIRONMENTS_PER_PROJECT} environments`,
      );
    }
    await assertEnvironmentNameAvailable(tx, access.projectId, input.name);
    const environment = await tx.environment.create({
      data: {
        projectId: access.projectId,
        name: input.name,
        baseUrl: input.baseUrl ?? null,
        // New environments go last.
        position: (max.position ?? -1) + 1,
      },
      include: environmentInclude,
    });
    return toView(environment);
  });
}

export async function updateEnvironment(
  access: ProjectAccess,
  environmentId: string,
  input: { name?: string; baseUrl?: string | null },
): Promise<EnvironmentView> {
  return prisma.$transaction(async (tx) => {
    await lockRow(tx, 'projects', access.projectId);
    await findEnvironment(tx, access, environmentId);
    if (input.name !== undefined) {
      await assertEnvironmentNameAvailable(tx, access.projectId, input.name, environmentId);
    }
    const environment = await tx.environment.update({
      where: { id: environmentId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      },
      include: environmentInclude,
    });
    return toView(environment);
  });
}

/** A project always keeps at least one environment to run requests against. */
export async function deleteEnvironment(
  access: ProjectAccess,
  environmentId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockRow(tx, 'projects', access.projectId);
    await findEnvironment(tx, access, environmentId);
    const count = await tx.environment.count({ where: { projectId: access.projectId } });
    if (count <= 1) {
      throw new AppError('CONFLICT', 'A project must keep at least one environment');
    }
    await tx.environment.delete({ where: { id: environmentId } });
  });
}

// ─── Variables ───────────────────────────────────────────────────────────────

export async function createVariable(
  access: ProjectAccess,
  environmentId: string,
  input: { key: string; value: string; isSecret: boolean },
): Promise<EnvironmentVariableView> {
  return prisma.$transaction(async (tx) => {
    await findEnvironment(tx, access, environmentId);
    await lockRow(tx, 'environments', environmentId);
    const existing = await tx.environmentVariable.findMany({
      where: { environmentId },
      select: { key: true },
    });
    if (existing.length >= MAX_VARIABLES_PER_ENVIRONMENT) {
      throw new AppError(
        'CONFLICT',
        `An environment can have at most ${MAX_VARIABLES_PER_ENVIRONMENT} variables`,
      );
    }
    if (existing.some((v) => v.key === input.key)) {
      throw fieldConflict('key', 'This environment already has a variable with this key');
    }
    const variable = await tx.environmentVariable.create({
      data: { environmentId, key: input.key, ...storedValue(input.value, input.isSecret) },
    });
    return toVariableView(variable);
  });
}

export async function updateVariable(
  access: ProjectAccess,
  environmentId: string,
  variableId: string,
  input: { key?: string; value?: string; isSecret?: boolean },
): Promise<EnvironmentVariableView> {
  return prisma.$transaction(async (tx) => {
    await findEnvironment(tx, access, environmentId);
    await lockRow(tx, 'environments', environmentId);
    const current = await tx.environmentVariable.findFirst({
      where: { id: variableId, environmentId },
    });
    if (!current) throw AppError.notFound('Variable');

    if (input.key !== undefined && input.key !== current.key) {
      const clash = await tx.environmentVariable.findFirst({
        where: { environmentId, key: input.key },
        select: { id: true },
      });
      if (clash)
        throw fieldConflict('key', 'This environment already has a variable with this key');
    }

    const isSecret = input.isSecret ?? current.isSecret;
    let valueColumns = {};
    if (input.value !== undefined) {
      valueColumns = storedValue(input.value, isSecret);
    } else if (isSecret !== current.isSecret) {
      if (!isSecret) {
        // Revealing a secret's old value would defeat the point of marking it secret.
        throw new AppError('VALIDATION_ERROR', 'Enter a new value to make this variable plain', [
          { path: 'value', message: 'Enter a new value to make this variable plain' },
        ]);
      }
      // Plain → secret: encrypt the existing value.
      valueColumns = storedValue(current.value ?? '', true);
    }

    const variable = await tx.environmentVariable.update({
      where: { id: variableId },
      data: { ...(input.key !== undefined ? { key: input.key } : {}), ...valueColumns },
    });
    return toVariableView(variable);
  });
}

export async function deleteVariable(
  access: ProjectAccess,
  environmentId: string,
  variableId: string,
): Promise<void> {
  await findEnvironment(prisma, access, environmentId);
  const { count } = await prisma.environmentVariable.deleteMany({
    where: { id: variableId, environmentId },
  });
  if (count === 0) throw AppError.notFound('Variable');
}
