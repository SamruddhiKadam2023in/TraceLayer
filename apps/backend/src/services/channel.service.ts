import type { Prisma } from '@tracelayer/db';
import {
  emailChannelConfigSchema,
  MAX_CHANNELS_PER_WORKSPACE,
  type EmailChannelConfig,
  type NotificationChannelView,
  type UpdateChannelInput,
} from '@tracelayer/shared';
import { lockRow } from '../lib/locks';
import { enqueueNotification } from '../lib/notification-queue';
import { prisma } from '../lib/prisma';
import { AppError } from '../utils/errors';
import { compareNames } from '../utils/sort';
import type { ChannelAccess, WorkspaceAccess } from './access.service';

const channelInclude = {
  notifications: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: { status: true, createdAt: true, sentAt: true, error: true },
  },
} as const satisfies Prisma.NotificationChannelInclude;

type ChannelRow = Prisma.NotificationChannelGetPayload<{ include: typeof channelInclude }>;

function toView(row: ChannelRow): NotificationChannelView {
  const last = row.notifications[0];
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    type: row.type,
    config: emailChannelConfigSchema.catch({ recipients: [] }).parse(row.config),
    enabled: row.enabled,
    lastDelivery: last
      ? {
          status: last.status,
          at: (last.sentAt ?? last.createdAt).toISOString(),
          error: last.error,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listChannels(access: WorkspaceAccess): Promise<NotificationChannelView[]> {
  const rows = await prisma.notificationChannel.findMany({
    where: { workspaceId: access.workspaceId },
    include: channelInclude,
  });
  return rows.map(toView).sort((a, b) => compareNames(a.name, b.name));
}

export async function createChannel(
  access: WorkspaceAccess,
  input: { name: string; type: 'EMAIL'; config: EmailChannelConfig; enabled: boolean },
): Promise<NotificationChannelView> {
  const row = await prisma.$transaction(async (tx) => {
    await lockRow(tx, 'workspaces', access.workspaceId);
    const count = await tx.notificationChannel.count({
      where: { workspaceId: access.workspaceId },
    });
    if (count >= MAX_CHANNELS_PER_WORKSPACE) {
      throw new AppError(
        'CONFLICT',
        `A workspace can have at most ${MAX_CHANNELS_PER_WORKSPACE} channels`,
      );
    }
    return tx.notificationChannel.create({
      data: { workspaceId: access.workspaceId, ...input },
      include: channelInclude,
    });
  });
  return toView(row);
}

export async function updateChannel(
  access: ChannelAccess,
  changes: UpdateChannelInput,
): Promise<NotificationChannelView> {
  const row = await prisma.notificationChannel.update({
    where: { id: access.channelId },
    data: {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.enabled !== undefined ? { enabled: changes.enabled } : {}),
      ...(changes.config !== undefined
        ? { config: emailChannelConfigSchema.parse(changes.config) }
        : {}),
    },
    include: channelInclude,
  });
  return toView(row);
}

export async function deleteChannel(access: ChannelAccess): Promise<void> {
  await prisma.notificationChannel.delete({ where: { id: access.channelId } });
}

/** Queues a test message through the real delivery pipeline (worker + adapter). */
export async function sendTestNotification(
  access: ChannelAccess,
): Promise<{ notificationId: string }> {
  const notification = await prisma.notification.create({
    data: { workspaceId: access.workspaceId, channelId: access.channelId, event: 'TEST' },
    select: { id: true },
  });
  try {
    await enqueueNotification(notification.id);
  } catch {
    await prisma.notification.update({
      where: { id: notification.id },
      data: { status: 'FAILED', error: 'The job queue is unavailable' },
    });
    throw new AppError('UPSTREAM_ERROR', 'The job queue is unavailable. Try again shortly.');
  }
  return { notificationId: notification.id };
}
