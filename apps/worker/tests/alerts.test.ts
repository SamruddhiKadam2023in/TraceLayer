import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPrismaClient, type AlertMetric } from '@tracelayer/db';
import { closeConnectionPools, createSecretBox } from '@tracelayer/executor';
import { evaluateMonitorRules } from '../src/alerts/evaluate-rules';
import { processMonitorCheck, type ProcessDependencies } from '../src/checks/process-check';
import type { ChannelAdapters } from '../src/notifications/channels';
import { deliverNotification } from '../src/notifications/deliver';
import { renderMessage } from '../src/notifications/message';

const prisma = createPrismaClient();
const secrets = createSecretBox(process.env.ENCRYPTION_KEY!);

// An upstream whose health the tests control.
let upstreamStatus = 200;
let upstream: Server;
let origin: string;
beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  await prisma.$disconnect();
  await closeConnectionPools();
});

let ids: {
  workspaceId: string;
  projectId: string;
  endpointId: string;
  monitorId: string;
  channelId: string;
};
const queued: string[] = [];
const deps: ProcessDependencies = {
  prisma,
  secrets,
  allowPrivateNetwork: true,
  enqueueNotification: async (id) => {
    queued.push(id);
  },
};

beforeEach(async () => {
  upstreamStatus = 200;
  queued.length = 0;
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE users, workspaces, projects, environments, endpoints, monitors, monitor_runs, alert_rules, alerts, notification_channels, notifications CASCADE',
  );
  const workspace = await prisma.workspace.create({ data: { name: 'Acme' } });
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Orders API' },
  });
  const environment = await prisma.environment.create({
    data: { projectId: project.id, name: 'Production', baseUrl: origin },
  });
  const endpoint = await prisma.endpoint.create({
    data: { projectId: project.id, name: 'Health', method: 'GET', url: '/health' },
  });
  const monitor = await prisma.monitor.create({
    data: {
      projectId: project.id,
      endpointId: endpoint.id,
      environmentId: environment.id,
      name: 'Orders health',
      type: 'STATUS',
      intervalSeconds: 60,
      timeoutMs: 2000,
    },
  });
  const channel = await prisma.notificationChannel.create({
    data: {
      workspaceId: workspace.id,
      name: 'On-call',
      type: 'EMAIL',
      config: { recipients: ['oncall@example.com'] },
    },
  });
  ids = {
    workspaceId: workspace.id,
    projectId: project.id,
    endpointId: endpoint.id,
    monitorId: monitor.id,
    channelId: channel.id,
  };
});

async function addRule(
  metric: AlertMetric,
  threshold: number,
  durationMinutes = 0,
  withChannel = true,
) {
  return prisma.alertRule.create({
    data: {
      projectId: ids.projectId,
      monitorId: ids.monitorId,
      name: `${metric} rule`,
      metric,
      threshold,
      durationMinutes,
      severity: 'HIGH',
      ...(withChannel ? { channels: { create: { channelId: ids.channelId } } } : {}),
    },
  });
}

async function addRuns(
  runs: { minutesAgo: number; success: boolean; statusCode: number | null; durationMs?: number }[],
  now: Date,
) {
  await prisma.monitorRun.createMany({
    data: runs.map((r) => ({
      monitorId: ids.monitorId,
      projectId: ids.projectId,
      endpointId: ids.endpointId,
      startedAt: new Date(now.getTime() - r.minutesAgo * 60_000),
      success: r.success,
      statusCode: r.statusCode,
      durationMs: r.durationMs ?? 100,
    })),
  });
}

describe('processMonitorCheck: from a real failing check to a queued email', () => {
  it('fires a rule, creates an alert and queues a notification per channel; then resolves', async () => {
    const rule = await addRule('CONSECUTIVE_FAILURES', 1);
    upstreamStatus = 503;

    const first = await processMonitorCheck(ids.monitorId, deps);
    expect(first).toMatchObject({ fired: 0, notificationsQueued: 0 }); // 1 failure is not > 1
    const second = await processMonitorCheck(ids.monitorId, deps);
    expect(second).toMatchObject({ fired: 1, notificationsQueued: 1 });

    const alert = await prisma.alert.findFirstOrThrow();
    expect(alert).toMatchObject({
      ruleId: rule.id,
      status: 'FIRING',
      severity: 'HIGH',
      value: 2,
      threshold: 1,
    });
    expect(alert.message).toBe('Consecutive failures 2 — rule: Consecutive failures > 1');
    const [notification] = await prisma.notification.findMany();
    expect(notification).toMatchObject({
      alertId: alert.id,
      channelId: ids.channelId,
      event: 'ALERT_FIRED',
      status: 'PENDING',
    });
    expect(queued).toEqual([notification!.id]);

    // Still failing: no second alert.
    expect(await processMonitorCheck(ids.monitorId, deps)).toMatchObject({ fired: 0 });

    upstreamStatus = 200;
    const recovered = await processMonitorCheck(ids.monitorId, deps);
    expect(recovered).toMatchObject({ resolved: 1, notificationsQueued: 1 });
    expect(await prisma.alert.findFirstOrThrow()).toMatchObject({ status: 'RESOLVED' });
    expect(await prisma.alert.count()).toBe(1);
    expect(
      (await prisma.notification.findMany({ orderBy: { createdAt: 'asc' } })).map((n) => n.event),
    ).toEqual(['ALERT_FIRED', 'ALERT_RESOLVED']);
  });

  it('still completes the check when live events cannot be published', async () => {
    const publishErrors: unknown[] = [];
    const result = await processMonitorCheck(ids.monitorId, {
      ...deps,
      publish: () => {
        throw new Error('Redis unavailable');
      },
      onPublishError: (err) => void publishErrors.push(err),
    });
    expect(result.check).toMatchObject({ status: 'completed', success: true });
    expect(await prisma.monitorRun.count()).toBe(1);
    expect(publishErrors).toEqual([new Error('Redis unavailable')]);
  });

  it('skips disabled channels and rules without channels', async () => {
    await prisma.notificationChannel.update({
      where: { id: ids.channelId },
      data: { enabled: false },
    });
    await addRule('STATUS_CODE', 503);
    upstreamStatus = 503;
    expect(await processMonitorCheck(ids.monitorId, deps)).toMatchObject({
      fired: 1,
      notificationsQueued: 0,
    });
  });
});

describe('evaluateMonitorRules', () => {
  const now = new Date();

  it('evaluates window rules over their own window', async () => {
    // 3 of 10 runs in the last 5 minutes failed (30%); older runs are all fine.
    await addRuns(
      [
        ...Array.from({ length: 7 }, (_, i) => ({
          minutesAgo: 0.2 + i * 0.5,
          success: true,
          statusCode: 200,
        })),
        ...Array.from({ length: 3 }, (_, i) => ({
          minutesAgo: 1 + i,
          success: false,
          statusCode: 500,
        })),
        ...Array.from({ length: 20 }, (_, i) => ({
          minutesAgo: 10 + i,
          success: true,
          statusCode: 200,
        })),
      ],
      now,
    );
    const fiveMinutes = await addRule('ERROR_RATE', 20, 5);
    const hour = await addRule('ERROR_RATE', 20, 60);

    const results = await evaluateMonitorRules(prisma, ids.monitorId, now);
    const byRule = Object.fromEntries(results.map((r) => [r.ruleId, r.transition]));
    expect(byRule[fiveMinutes.id]).toBe('fired'); // 30% > 20%
    expect(byRule[hour.id]).toBeNull(); // 3 of 30 = 10%
    expect(
      (await prisma.alertRule.findUniqueOrThrow({ where: { id: fiveMinutes.id } })).lastValue,
    ).toBe(30);
  });

  it('holds sustained rules until their duration passes', async () => {
    await addRuns([{ minutesAgo: 0, success: false, statusCode: 503 }], now);
    const r = await addRule('STATUS_CODE', 503, 3);

    expect((await evaluateMonitorRules(prisma, ids.monitorId, now))[0]?.transition).toBeNull();
    expect(await prisma.alertRule.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({
      state: 'PENDING',
    });

    const later = new Date(now.getTime() + 3 * 60_000);
    await addRuns([{ minutesAgo: 0, success: false, statusCode: 503 }], later);
    expect((await evaluateMonitorRules(prisma, ids.monitorId, later))[0]?.transition).toBe('fired');
  });

  it('never fires twice when two evaluations race', async () => {
    await addRuns([{ minutesAgo: 0, success: false, statusCode: 503 }], now);
    await addRule('STATUS_CODE', 503);
    const results = await Promise.all([
      evaluateMonitorRules(prisma, ids.monitorId, now),
      evaluateMonitorRules(prisma, ids.monitorId, now),
    ]);
    expect(results.flat().filter((r) => r.transition === 'fired')).toHaveLength(1);
    expect(await prisma.alert.count()).toBe(1);
  });

  it('ignores disabled rules', async () => {
    await addRuns([{ minutesAgo: 0, success: false, statusCode: 503 }], now);
    const r = await addRule('STATUS_CODE', 503);
    await prisma.alertRule.update({ where: { id: r.id }, data: { enabled: false } });
    expect(await evaluateMonitorRules(prisma, ids.monitorId, now)).toEqual([]);
  });
});

describe('deliverNotification', () => {
  async function queuedNotification() {
    await addRule('CONSECUTIVE_FAILURES', 0);
    upstreamStatus = 503;
    await processMonitorCheck(ids.monitorId, deps);
    return queued[0]!;
  }

  function adapters(send: ChannelAdapters['EMAIL']['send']): ChannelAdapters {
    return { EMAIL: { send } };
  }

  it('sends through the channel adapter and records success', async () => {
    const id = await queuedNotification();
    const sent: { config: unknown; subject: string; text: string }[] = [];
    const result = await deliverNotification(
      id,
      {
        prisma,
        appUrl: 'https://app.tracelayer.dev',
        adapters: adapters(async (config, message) => {
          sent.push({ config, subject: message.subject, text: message.text });
        }),
      },
      false,
    );

    expect(result).toEqual({ status: 'sent' });
    expect(sent[0]?.config).toEqual({ recipients: ['oncall@example.com'] });
    expect(sent[0]?.subject).toBe(
      '[HIGH] Orders health: Consecutive failures 1 — rule: Consecutive failures > 0',
    );
    expect(sent[0]?.text).toContain('GET /health');
    expect(sent[0]?.text).toContain(
      `https://app.tracelayer.dev/projects/${ids.projectId}/monitors/${ids.monitorId}`,
    );
    expect(await prisma.notification.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'SENT',
      attempts: 1,
      error: null,
    });
  });

  it('records failures, stays pending for a retry, and fails for good on the last attempt', async () => {
    const id = await queuedNotification();
    const failing = {
      prisma,
      appUrl: 'http://x',
      adapters: adapters(async () => {
        throw new Error('SMTP 421 try later');
      }),
    };

    await expect(deliverNotification(id, failing, false)).rejects.toThrow('SMTP 421');
    expect(await prisma.notification.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      error: 'SMTP 421 try later',
    });

    await expect(deliverNotification(id, failing, true)).rejects.toThrow();
    expect(await prisma.notification.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'FAILED',
      attempts: 2,
    });
  });

  it('skips notifications that were deleted, already sent, or whose channel was disabled', async () => {
    const id = await queuedNotification();
    const sent: string[] = [];
    const deliveryDeps = {
      prisma,
      appUrl: 'http://x',
      adapters: adapters(async (_config, message) => void sent.push(message.subject)),
    };

    await prisma.notificationChannel.update({
      where: { id: ids.channelId },
      data: { enabled: false },
    });
    expect(await deliverNotification(id, deliveryDeps, false)).toEqual({
      status: 'skipped',
      reason: 'channel disabled',
    });
    expect(await prisma.notification.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'FAILED',
      error: 'Channel is disabled',
    });

    // A test notification still reaches a disabled channel: people test before enabling.
    const test = await prisma.notification.create({
      data: { workspaceId: ids.workspaceId, channelId: ids.channelId, event: 'TEST' },
    });
    expect(await deliverNotification(test.id, deliveryDeps, false)).toEqual({ status: 'sent' });
    expect(await deliverNotification(test.id, deliveryDeps, false)).toEqual({
      status: 'skipped',
      reason: 'already sent',
    });
    expect(
      await deliverNotification('00000000-0000-4000-8000-000000000000', deliveryDeps, false),
    ).toEqual({ status: 'skipped', reason: 'notification deleted' });
    expect(sent).toHaveLength(1);
  });
});

describe('renderMessage', () => {
  it('escapes user-controlled text in HTML', () => {
    const message = renderMessage({
      event: 'ALERT_FIRED',
      workspaceName: 'Acme',
      channelName: 'On-call',
      appUrl: 'http://localhost:8080',
      alert: {
        message: 'Status code 500 — rule: Status code = 500',
        severity: 'CRITICAL',
        metric: 'STATUS_CODE',
        value: 500,
        threshold: 500,
        firedAt: new Date('2026-09-30T10:42:00Z'),
        resolvedAt: null,
        ruleName: '<script>alert(1)</script>',
        monitor: { id: 'm', name: 'Orders <b>API</b>' },
        endpoint: { method: 'POST', url: '/orders' },
        project: { id: 'p', name: 'Shop' },
      },
    });
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.html).toContain('Orders &lt;b&gt;API&lt;/b&gt;');
    expect(message.text).toContain('API ALERT');
    expect(message.text).toContain('Detected: 2026-09-30 10:42:00 UTC');
  });
});
