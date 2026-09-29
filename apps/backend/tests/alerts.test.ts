import request from 'supertest';
import { MAX_RULES_PER_MONITOR, type WorkspaceRole } from '@tracelayer/shared';

jest.mock('../src/lib/monitor-queue', () => ({
  syncMonitorSchedule: jest.fn(),
  unscheduleMonitor: jest.fn(),
  enqueueMonitorRun: jest.fn(),
  closeMonitorQueue: jest.fn(),
}));
const mockEnqueueNotification = jest.fn();
jest.mock('../src/lib/notification-queue', () => ({
  enqueueNotification: mockEnqueueNotification,
  closeNotificationQueue: jest.fn(),
}));

import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { createTestUser, resetDatabase, type TestUser } from './helpers';

let app: ReturnType<typeof createApp>;
let owner: TestUser;
let workspaceId: string;
let projectId: string;
let monitorId: string;

beforeEach(async () => {
  await resetDatabase();
  app = createApp();
  owner = await createTestUser(app, 'Olivia Owner');
  workspaceId = (await request(app).post('/api/workspaces').set(owner.auth).send({ name: 'Acme' }))
    .body.data.id;
  projectId = (
    await request(app)
      .post('/api/projects')
      .set(owner.auth)
      .send({ workspaceId, name: 'Orders API' })
  ).body.data.id;
  const endpoint = await prisma.endpoint.create({
    data: { projectId, name: 'Health', method: 'GET', url: 'https://api.example.com/health' },
  });
  monitorId = (
    await prisma.monitor.create({
      data: {
        projectId,
        endpointId: endpoint.id,
        name: 'Orders health',
        type: 'STATUS',
        intervalSeconds: 60,
        timeoutMs: 5000,
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function userWithRole(name: string, role: WorkspaceRole): Promise<TestUser> {
  const user = await createTestUser(app, name);
  await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role } });
  return user;
}

const createChannel = (body: object = {}, user = owner) =>
  request(app)
    .post('/api/notification-channels')
    .set(user.auth)
    .send({
      workspaceId,
      name: 'On-call',
      type: 'EMAIL',
      config: { recipients: ['oncall@example.com'] },
      ...body,
    });

const createRule = (body: object = {}, user = owner) =>
  request(app)
    .post('/api/alerts')
    .set(user.auth)
    .send({ monitorId, name: 'High error rate', metric: 'ERROR_RATE', threshold: 5, ...body });

describe('alert rules', () => {
  it('creates a rule with defaults and a readable description', async () => {
    const channel = (await createChannel()).body.data;
    const res = await createRule({ channelIds: [channel.id] });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      monitorId,
      metric: 'ERROR_RATE',
      threshold: 5,
      durationMinutes: 5,
      severity: 'HIGH',
      enabled: true,
      channelIds: [channel.id],
      state: 'OK',
      monitor: { id: monitorId, name: 'Orders health' },
      description: 'Error rate > 5% over 5 min',
    });
  });

  it.each([
    ['a percentage above 100', { threshold: 150 }, 'threshold'],
    ['a fractional status code', { metric: 'STATUS_CODE', threshold: 503.5 }, 'threshold'],
    ['a window rule with no window', { durationMinutes: 0 }, 'durationMinutes'],
    ['an unknown metric', { metric: 'CPU' }, 'metric'],
  ])('rejects %s', async (_label, body, path) => {
    const res = await createRule(body);
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(path);
  });

  it('only accepts channels of the same workspace', async () => {
    const other = await request(app)
      .post('/api/workspaces')
      .set(owner.auth)
      .send({ name: 'Other' });
    const foreign = await request(app)
      .post('/api/notification-channels')
      .set(owner.auth)
      .send({
        workspaceId: other.body.data.id,
        name: 'X',
        type: 'EMAIL',
        config: { recipients: ['x@example.com'] },
      });
    const res = await createRule({ channelIds: [foreign.body.data.id] });
    expect(res.status).toBe(404);
    expect(res.body.error.details[0].path).toBe('channelIds');
  });

  it('lists rules by monitor and by project, and limits rules per monitor', async () => {
    await createRule({ name: 'B rule' });
    await createRule({ name: 'A rule', metric: 'STATUS_CODE', threshold: 503, durationMinutes: 0 });
    const byMonitor = await request(app).get('/api/alerts').query({ monitorId }).set(owner.auth);
    expect(byMonitor.body.data.map((r: { name: string }) => r.name)).toEqual(['A rule', 'B rule']);
    const byProject = await request(app).get('/api/alerts').query({ projectId }).set(owner.auth);
    expect(byProject.body.data).toHaveLength(2);

    await prisma.alertRule.createMany({
      data: Array.from({ length: MAX_RULES_PER_MONITOR - 2 }, (_, i) => ({
        projectId,
        monitorId,
        name: `R${i}`,
        metric: 'UPTIME' as const,
        threshold: 99,
        durationMinutes: 60,
        severity: 'LOW' as const,
      })),
    });
    expect((await createRule({ name: 'Too many' })).status).toBe(409);
  });

  it('restarts a rule whose condition changes, resolving its open alert', async () => {
    const rule = (await createRule()).body.data;
    await prisma.alertRule.update({ where: { id: rule.id }, data: { state: 'FIRING' } });
    const alert = await prisma.alert.create({
      data: {
        ruleId: rule.id,
        monitorId,
        projectId,
        severity: 'HIGH',
        value: 9,
        threshold: 5,
        message: 'x',
      },
    });

    // Renaming does not touch the alert.
    await request(app).patch(`/api/alerts/${rule.id}`).set(owner.auth).send({ name: 'Renamed' });
    expect(await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } })).toMatchObject({
      status: 'FIRING',
    });

    const res = await request(app)
      .patch(`/api/alerts/${rule.id}`)
      .set(owner.auth)
      .send({ threshold: 10 });
    expect(res.body.data).toMatchObject({ threshold: 10, state: 'OK' });
    expect(await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } })).toMatchObject({
      status: 'RESOLVED',
    });
  });

  it('keeps alert history when a rule is deleted', async () => {
    const rule = (await createRule()).body.data;
    await prisma.alert.create({
      data: {
        ruleId: rule.id,
        monitorId,
        projectId,
        severity: 'HIGH',
        value: 9,
        threshold: 5,
        message: 'x',
      },
    });
    expect((await request(app).delete(`/api/alerts/${rule.id}`).set(owner.auth)).status).toBe(204);
    const [alert] = await prisma.alert.findMany();
    expect(alert).toMatchObject({ ruleId: null, status: 'RESOLVED' });
  });

  it('lists fired alerts with firing ones first', async () => {
    const rule = (await createRule()).body.data;
    const base = {
      ruleId: rule.id,
      monitorId,
      projectId,
      severity: 'HIGH' as const,
      threshold: 5,
      message: 'x',
    };
    await prisma.alert.create({
      data: {
        ...base,
        value: 6,
        status: 'RESOLVED',
        firedAt: new Date('2026-09-30T08:00:00Z'),
        resolvedAt: new Date('2026-09-30T08:10:00Z'),
      },
    });
    await prisma.alert.create({
      data: { ...base, value: 9, status: 'FIRING', firedAt: new Date('2026-09-30T07:00:00Z') },
    });

    const res = await request(app).get('/api/alerts/fired').query({ projectId }).set(owner.auth);
    expect(
      res.body.data.map((a: { status: string; value: number }) => `${a.status}:${a.value}`),
    ).toEqual(['FIRING:9', 'RESOLVED:6']);
    expect(res.body.data[0].rule).toEqual({ id: rule.id, name: 'High error rate' });
  });

  it('lets members manage rules and viewers only read them', async () => {
    const member = await userWithRole('Mia Member', 'MEMBER');
    const viewer = await userWithRole('Vic Viewer', 'VIEWER');
    expect((await createRule({}, member)).status).toBe(201);
    expect((await createRule({ name: 'V' }, viewer)).status).toBe(403);
    expect(
      (await request(app).get('/api/alerts').query({ monitorId }).set(viewer.auth)).status,
    ).toBe(200);
    const outsider = await createTestUser(app, 'Eve Outsider');
    expect(
      (await request(app).get('/api/alerts').query({ monitorId }).set(outsider.auth)).status,
    ).toBe(404);
  });
});

describe('notification channels', () => {
  it('creates channels with de-duplicated, normalised recipients and reports the last delivery', async () => {
    const res = await createChannel({
      config: { recipients: ['A@Example.com', 'a@example.com', 'b@example.com'] },
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'On-call',
      type: 'EMAIL',
      config: { recipients: ['a@example.com', 'b@example.com'] },
      enabled: true,
      lastDelivery: null,
    });
    expect((await createChannel({ config: { recipients: [] } })).status).toBe(400);
    expect((await createChannel({ config: { recipients: ['not-an-email'] } })).status).toBe(400);
  });

  it('sends a test through the queue and records it', async () => {
    const channel = (await createChannel()).body.data;
    const res = await request(app)
      .post(`/api/notification-channels/${channel.id}/test`)
      .set(owner.auth);
    expect(res.status).toBe(202);
    const [notification] = await prisma.notification.findMany();
    expect(notification).toMatchObject({ channelId: channel.id, event: 'TEST', status: 'PENDING' });
    expect(mockEnqueueNotification).toHaveBeenCalledWith(notification!.id);

    const list = await request(app)
      .get('/api/notification-channels')
      .query({ workspaceId })
      .set(owner.auth);
    expect(list.body.data[0].lastDelivery).toMatchObject({ status: 'PENDING' });
  });

  it('reports an unavailable queue and marks the test as failed', async () => {
    mockEnqueueNotification.mockRejectedValueOnce(new Error('Redis down'));
    const channel = (await createChannel()).body.data;
    const res = await request(app)
      .post(`/api/notification-channels/${channel.id}/test`)
      .set(owner.auth);
    expect(res.status).toBe(502);
    expect(await prisma.notification.findFirstOrThrow()).toMatchObject({ status: 'FAILED' });
  });

  it('is managed by owners and admins; members and viewers can only read', async () => {
    const admin = await userWithRole('Adam Admin', 'ADMIN');
    const member = await userWithRole('Mia Member', 'MEMBER');
    expect((await createChannel({ name: 'Admin channel' }, admin)).status).toBe(201);
    expect((await createChannel({ name: 'Member channel' }, member)).status).toBe(403);
    const channel = (await createChannel()).body.data;
    expect(
      (
        await request(app)
          .patch(`/api/notification-channels/${channel.id}`)
          .set(member.auth)
          .send({ enabled: false })
      ).status,
    ).toBe(403);
    expect(
      (await request(app).post(`/api/notification-channels/${channel.id}/test`).set(member.auth))
        .status,
    ).toBe(403);
    expect(
      (await request(app).get('/api/notification-channels').query({ workspaceId }).set(member.auth))
        .status,
    ).toBe(200);
  });

  it('removes a deleted channel from its rules', async () => {
    const channel = (await createChannel()).body.data;
    const rule = (await createRule({ channelIds: [channel.id] })).body.data;
    await request(app).delete(`/api/notification-channels/${channel.id}`).set(owner.auth);
    const after = await request(app).get(`/api/alerts/${rule.id}`).set(owner.auth);
    expect(after.body.data.channelIds).toEqual([]);
  });
});
