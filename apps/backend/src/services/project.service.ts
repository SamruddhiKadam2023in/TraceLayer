import type { Prisma } from '@tracelayer/db';
import {
  DEFAULT_ENVIRONMENTS,
  MAX_PROJECTS_PER_WORKSPACE,
  type ProjectView,
} from '@tracelayer/shared';
import { lockRow } from '../lib/locks';
import { prisma } from '../lib/prisma';
import { monitorIdsFor, unscheduleMonitors } from './monitor-cleanup.service';
import { AppError } from '../utils/errors';
import { compareNames } from '../utils/sort';
import type { ProjectAccess, WorkspaceAccess } from './access.service';

const projectInclude = {
  createdBy: { select: { id: true, name: true } },
  _count: { select: { environments: true } },
} as const satisfies Prisma.ProjectInclude;

type ProjectRow = Prisma.ProjectGetPayload<{ include: typeof projectInclude }>;

function toView(project: ProjectRow): ProjectView {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    description: project.description,
    createdBy: project.createdBy,
    environmentCount: project._count.environments,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

function nameTakenError(): AppError {
  return new AppError('CONFLICT', 'A project with this name already exists in the workspace', [
    { path: 'name', message: 'A project with this name already exists in the workspace' },
  ]);
}

async function assertNameAvailable(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  name: string,
  exceptProjectId?: string,
): Promise<void> {
  const clash = await tx.project.findFirst({
    where: {
      workspaceId,
      name: { equals: name, mode: 'insensitive' },
      ...(exceptProjectId ? { id: { not: exceptProjectId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw nameTakenError();
}

export async function listProjects(access: WorkspaceAccess): Promise<ProjectView[]> {
  const projects = await prisma.project.findMany({
    where: { workspaceId: access.workspaceId },
    include: projectInclude,
  });
  return projects.map(toView).sort((a, b) => compareNames(a.name, b.name));
}

/** Creates the project together with the default environments, atomically. */
export async function createProject(
  access: WorkspaceAccess,
  input: { name: string; description?: string | null },
): Promise<ProjectView> {
  return prisma.$transaction(async (tx) => {
    // Serializes project creation per workspace, so the limit and name checks cannot race.
    await lockRow(tx, 'workspaces', access.workspaceId);
    const count = await tx.project.count({ where: { workspaceId: access.workspaceId } });
    if (count >= MAX_PROJECTS_PER_WORKSPACE) {
      throw new AppError(
        'CONFLICT',
        `A workspace can have at most ${MAX_PROJECTS_PER_WORKSPACE} projects`,
      );
    }
    await assertNameAvailable(tx, access.workspaceId, input.name);

    const project = await tx.project.create({
      data: {
        workspaceId: access.workspaceId,
        name: input.name,
        description: input.description ?? null,
        createdById: access.userId,
        environments: {
          create: DEFAULT_ENVIRONMENTS.map((name, position) => ({ name, position })),
        },
      },
      include: projectInclude,
    });
    return toView(project);
  });
}

export async function getProject(access: ProjectAccess): Promise<ProjectView> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: access.projectId },
    include: projectInclude,
  });
  return toView(project);
}

export async function updateProject(
  access: ProjectAccess,
  input: { name?: string; description?: string | null },
): Promise<ProjectView> {
  return prisma.$transaction(async (tx) => {
    if (input.name !== undefined) {
      await lockRow(tx, 'workspaces', access.workspaceId);
      await assertNameAvailable(tx, access.workspaceId, input.name, access.projectId);
    }
    const project = await tx.project.update({
      where: { id: access.projectId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
      include: projectInclude,
    });
    return toView(project);
  });
}

/** Deletes the project; environments and variables cascade in the database. */
export async function deleteProject(access: ProjectAccess): Promise<void> {
  const monitorIds = await monitorIdsFor({ projectId: access.projectId });
  await prisma.project.delete({ where: { id: access.projectId } });
  await unscheduleMonitors(monitorIds);
}
