import type { PrismaClient } from '@tracelayer/db';
import type { ChannelAdapters } from './channels';
import { renderMessage } from './message';

export interface DeliveryDependencies {
  prisma: PrismaClient;
  adapters: ChannelAdapters;
  appUrl: string;
}

export type DeliveryResult = { status: 'sent' } | { status: 'skipped'; reason: string };

/**
 * Sends one logged notification through its channel's adapter and records the outcome.
 * Throws on a delivery error so BullMQ retries with backoff; `finalAttempt` marks the row
 * FAILED instead of leaving it PENDING once retries are exhausted.
 */
export async function deliverNotification(
  notificationId: string,
  deps: DeliveryDependencies,
  finalAttempt: boolean,
): Promise<DeliveryResult> {
  const notification = await deps.prisma.notification.findUnique({
    where: { id: notificationId },
    include: {
      channel: true,
      workspace: { select: { name: true } },
      alert: {
        include: {
          rule: { select: { name: true, metric: true } },
          monitor: {
            select: { id: true, name: true, endpoint: { select: { method: true, url: true } } },
          },
          project: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!notification) return { status: 'skipped', reason: 'notification deleted' };
  if (notification.status === 'SENT') return { status: 'skipped', reason: 'already sent' };
  if (!notification.channel.enabled && notification.event !== 'TEST') {
    await deps.prisma.notification.update({
      where: { id: notificationId },
      data: { status: 'FAILED', error: 'Channel is disabled' },
    });
    return { status: 'skipped', reason: 'channel disabled' };
  }

  const a = notification.alert;
  const message = renderMessage({
    event: notification.event,
    workspaceName: notification.workspace.name,
    channelName: notification.channel.name,
    appUrl: deps.appUrl,
    alert: a
      ? {
          message: a.message,
          severity: a.severity,
          metric: a.rule?.metric ?? null,
          value: a.value,
          threshold: a.threshold,
          firedAt: a.firedAt,
          resolvedAt: a.resolvedAt,
          ruleName: a.rule?.name ?? null,
          monitor: { id: a.monitor.id, name: a.monitor.name },
          endpoint: a.monitor.endpoint,
          project: a.project,
        }
      : undefined,
  });

  try {
    await deps.adapters[notification.channel.type].send(notification.channel.config, message);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await deps.prisma.notification.update({
      where: { id: notificationId },
      data: {
        attempts: { increment: 1 },
        error: error.slice(0, 500),
        status: finalAttempt ? 'FAILED' : 'PENDING',
      },
    });
    throw err;
  }

  await deps.prisma.notification.update({
    where: { id: notificationId },
    data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 }, error: null },
  });
  return { status: 'sent' };
}
