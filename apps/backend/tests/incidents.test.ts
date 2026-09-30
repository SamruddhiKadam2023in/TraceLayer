import request from 'supertest';
import { lockIncident, onAlertResolved, openOrJoinIncident, type Severity } from '@tracelayer/db';
import type { WorkspaceRole } from '@tracelayer/shared';

jest.mock('../src/lib/monitor-queue', () => ({
  syncMonitorSchedule: jest.fn(),
  unscheduleMonitor: jest.fn(),
  enqueueMonitorRun: jest.fn(),
  closeMonitorQueue: jest.fn(),
}));
jest.mock('../src/lib/notification-queue', () => ({
  enqueueNotification: jest.fn(),
  closeNotificationQueue: jest.fn(),
}));

import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { createTestUser, resetDatabase, type TestUser } from './helpers';

let app: ReturnType<typeof createApp>;
let owner: TestUser;
let workspaceId: string;
let projectId: string;
let endpointId: string;
let monitorId: string;

beforeEach(async () => {
  await resetDatabase();
  app = createApp();
  owner = await createTestUser(app, 'Olivia Owner');
  workspaceId = (await request(app).post('/api/workspaces').set(owner.auth).send({ name: 'Acme' }))
    .body.data.id;
  projectId = await createProject('Orders API');
  endpointId = (
    await prisma.endpoint.create({
      data: { projectId, name: 'Orders', method: 'POST', url: 'https://api.example.com/orders' },
    })
  ).id;
  monitorId = await createMonitor('Orders health');
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createProject(name: string, ws = workspaceId, user = owner) {
  return (await request(app).post('/api/projects').set(user.auth).send({ workspaceId: ws, name }))
    .body.data.id as string;
}

async function createMonitor(name: string, project = projectId, endpoint = endpointId) {
  return (
    await prisma.monitor.create({
      data: {
        projectId: project,
        endpointId: endpoint,
        name,
        type: 'STATUS',
        intervalSeconds: 60,
        timeoutMs: 5000,
      },
    })
  ).id;
}

async function userWithRole(name: string, role: WorkspaceRole): Promise<TestUser> {
  const user = await createTestUser(app, name);
  await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role } });
  return user;
}

/** Fires an alert the way the worker does and returns the incident it opened or joined. */
async function fireAlert(
  severity: Severity = 'HIGH',
  monitor = monitorId,
  project = projectId,
  now = new Date(),
) {
  return prisma.$transaction(async (tx) => {
    const alert = await tx.alert.create({
      data: {
        monitorId: monitor,
        projectId: project,
        severity,
        threshold: 5,
        value: 8.7,
        message: 'Error rate 8.7% > 5% over 5 min',
        firedAt: now,
      },
    });
    const incident = await openOrJoinIncident(tx, {
      alertId: alert.id,
      projectId: project,
      monitorId: monitor,
      monitorName: 'Orders health',
      ruleName: 'Error spike',
      severity,
      message: alert.message,
      now,
    });
    return { alertId: alert.id, ...incident };
  });
}

/** The monitor recovered: the worker resolves the alert, which may resolve the incident. */
async function recover(alertId: string) {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    await tx.alert.update({
      where: { id: alertId },
      data: { status: 'RESOLVED', resolvedAt: now },
    });
    return onAlertResolved(tx, {
      alertId,
      now,
      autoResolve: true,
      reason: 'Error spike: the condition cleared',
    });
  });
}

const list = (query: object, user = owner) =>
  request(app).get('/api/incidents').query(query).set(user.auth);
const patch = (id: string, body: object, user = owner) =>
  request(app).patch(`/api/incidents/${id}`).set(user.auth).send(body);
const comment = (id: string, message: string, user = owner) =>
  request(app).post(`/api/incidents/${id}/events`).set(user.auth).send({ message });

describe('GET /api/incidents', () => {
  it('lists a project’s incidents newest first with filters and paging', async () => {
    const first = await fireAlert('HIGH', monitorId, projectId, new Date(Date.now() - 60_000));
    await recover(first.alertId);
    const second = await fireAlert('CRITICAL', await createMonitor('Payments'));

    const all = await list({ projectId });
    expect(all.status).toBe(200);
    expect(all.body.data).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(all.body.data.items.map((i: { number: number }) => i.number)).toEqual([2, 1]);
    expect(all.body.data.items[0]).toMatchObject({
      id: second.incidentId,
      title: 'Orders health: Error rate 8.7% > 5% over 5 min',
      severity: 'CRITICAL',
      status: 'OPEN',
      project: { id: projectId, name: 'Orders API' },
      firingAlerts: 1,
      assignee: null,
      resolvedAt: null,
    });
    expect(all.body.data.items[1]).toMatchObject({ status: 'RESOLVED', firingAlerts: 0 });

    const active = await list({ projectId, status: 'ACTIVE' });
    expect(active.body.data.items.map((i: { id: string }) => i.id)).toEqual([second.incidentId]);
    const resolved = await list({ projectId, status: 'RESOLVED' });
    expect(resolved.body.data.items.map((i: { id: string }) => i.id)).toEqual([first.incidentId]);
    expect((await list({ projectId, severity: 'LOW' })).body.data.total).toBe(0);
    expect((await list({ projectId, monitorId })).body.data.total).toBe(1);

    const paged = await list({ projectId, page: 2, pageSize: 1 });
    expect(paged.body.data).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(paged.body.data.items[0].id).toBe(first.incidentId);
  });

  it('lists a whole workspace for the dashboard, and filters by assignee', async () => {
    const otherProject = await createProject('Payments API');
    const otherEndpoint = await prisma.endpoint.create({
      data: { projectId: otherProject, name: 'Pay', method: 'POST', url: 'https://x.test/pay' },
    });
    const otherMonitor = await createMonitor('Pay health', otherProject, otherEndpoint.id);
    await fireAlert();
    const second = await fireAlert('LOW', otherMonitor, otherProject);
    await patch(second.incidentId, { assigneeId: owner.id });

    const res = await list({ workspaceId, status: 'ACTIVE' });
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.items.map((i: { project: { name: string } }) => i.project.name)).toEqual([
      'Payments API',
      'Orders API',
    ]);
    const mine = await list({ workspaceId, assigneeId: owner.id });
    expect(mine.body.data.items.map((i: { id: string }) => i.id)).toEqual([second.incidentId]);
  });

  it('requires exactly one scope and hides other workspaces', async () => {
    expect((await list({})).status).toBe(400);
    expect((await list({ projectId, workspaceId })).status).toBe(400);

    const outsider = await createTestUser(app, 'Oscar Outsider');
    expect((await list({ projectId }, outsider)).status).toBe(404);
    expect((await list({ workspaceId }, outsider)).status).toBe(404);

    // A monitor of another workspace is reported, not silently filtered to nothing.
    const theirWorkspace = (
      await request(app).post('/api/workspaces').set(outsider.auth).send({ name: 'Theirs' })
    ).body.data.id;
    const theirProject = await createProject('Theirs', theirWorkspace, outsider);
    const theirEndpoint = await prisma.endpoint.create({
      data: { projectId: theirProject, name: 'E', method: 'GET', url: 'https://x.test/' },
    });
    const theirMonitor = await createMonitor('Theirs', theirProject, theirEndpoint.id);
    expect((await list({ projectId, monitorId: theirMonitor })).status).toBe(404);
  });
});

describe('GET /api/incidents/:id', () => {
  it('returns the incident with its alerts and an ordered timeline, to viewers too', async () => {
    const { incidentId, alertId } = await fireAlert('MEDIUM');
    await fireAlert('CRITICAL');
    const viewer = await userWithRole('Vera Viewer', 'VIEWER');

    const res = await request(app).get(`/api/incidents/${incidentId}`).set(viewer.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      number: 1,
      severity: 'CRITICAL',
      monitor: { id: monitorId, name: 'Orders health' },
      firingAlerts: 2,
    });
    expect(res.body.data.alerts).toHaveLength(2);
    expect(res.body.data.alerts[0]).toMatchObject({ id: alertId, status: 'FIRING' });
    expect(
      res.body.data.events.map((e: { type: string; actor: unknown }) => [e.type, e.actor]),
    ).toEqual([
      ['DETECTED', null],
      ['ALERT_FIRED', null],
      ['ALERT_FIRED', null],
      ['SEVERITY_CHANGED', null],
    ]);
  });

  it('is 404 for outsiders and malformed ids', async () => {
    const { incidentId } = await fireAlert();
    const outsider = await createTestUser(app, 'Oscar Outsider');
    expect((await request(app).get(`/api/incidents/${incidentId}`).set(outsider.auth)).status).toBe(
      404,
    );
    expect((await request(app).get('/api/incidents/not-a-uuid').set(owner.auth)).status).toBe(404);
  });
});

describe('PATCH /api/incidents/:id', () => {
  it('acknowledges, assigns, investigates, resolves and reopens, recording who did what', async () => {
    const { incidentId } = await fireAlert();
    const member = await userWithRole('Mia Member', 'MEMBER');

    const ack = await patch(incidentId, { status: 'ACKNOWLEDGED', assigneeId: member.id }, member);
    expect(ack.status).toBe(200);
    expect(ack.body.data).toMatchObject({
      status: 'ACKNOWLEDGED',
      assignee: { id: member.id, name: 'Mia Member' },
    });
    expect(ack.body.data.acknowledgedAt).not.toBeNull();

    await patch(incidentId, { status: 'INVESTIGATING', severity: 'CRITICAL' });
    const resolved = await patch(incidentId, { status: 'RESOLVED' });
    expect(resolved.body.data).toMatchObject({
      status: 'RESOLVED',
      resolvedBy: { id: owner.id, name: 'Olivia Owner' },
    });
    // Acknowledgement time is the first response and is kept.
    expect(resolved.body.data.acknowledgedAt).toBe(ack.body.data.acknowledgedAt);

    const reopened = await patch(incidentId, { status: 'OPEN', assigneeId: null });
    expect(reopened.body.data).toMatchObject({
      status: 'OPEN',
      resolvedAt: null,
      resolvedBy: null,
      assignee: null,
    });

    const manual = reopened.body.data.events
      .filter((e: { actor: unknown }) => e.actor)
      .map((e: { type: string; actor: { name: string }; fromValue: string; toValue: string }) => [
        e.type,
        e.actor.name,
        e.fromValue,
        e.toValue,
      ]);
    expect(manual).toEqual([
      ['STATUS_CHANGED', 'Mia Member', 'OPEN', 'ACKNOWLEDGED'],
      ['ASSIGNED', 'Mia Member', null, 'Mia Member'],
      ['STATUS_CHANGED', 'Olivia Owner', 'ACKNOWLEDGED', 'INVESTIGATING'],
      ['SEVERITY_CHANGED', 'Olivia Owner', 'HIGH', 'CRITICAL'],
      ['STATUS_CHANGED', 'Olivia Owner', 'INVESTIGATING', 'RESOLVED'],
      ['STATUS_CHANGED', 'Olivia Owner', 'RESOLVED', 'OPEN'],
      ['ASSIGNED', 'Olivia Owner', 'Mia Member', null],
    ]);
  });

  it('records nothing when nothing changes', async () => {
    const { incidentId } = await fireAlert();
    const res = await patch(incidentId, { status: 'OPEN', severity: 'HIGH', assigneeId: null });
    expect(res.status).toBe(200);
    expect(
      await prisma.incidentEvent.count({ where: { incidentId, actorId: { not: null } } }),
    ).toBe(0);
    expect((await patch(incidentId, {})).status).toBe(400);
    expect((await patch(incidentId, { status: 'CLOSED' })).status).toBe(400);
  });

  it('only assigns members who can work on incidents', async () => {
    const { incidentId } = await fireAlert();
    const viewer = await userWithRole('Vera Viewer', 'VIEWER');
    const outsider = await createTestUser(app, 'Oscar Outsider');

    const toViewer = await patch(incidentId, { assigneeId: viewer.id });
    expect(toViewer.status).toBe(400);
    expect(toViewer.body.error.details).toEqual([
      { path: 'assigneeId', message: 'Viewers cannot be assigned incidents' },
    ]);
    const toOutsider = await patch(incidentId, { assigneeId: outsider.id });
    expect(toOutsider.status).toBe(404);
    expect(toOutsider.body.error.details[0].path).toBe('assigneeId');
  });

  it('lets viewers read but not change incidents', async () => {
    const { incidentId } = await fireAlert();
    const viewer = await userWithRole('Vera Viewer', 'VIEWER');
    expect((await patch(incidentId, { status: 'ACKNOWLEDGED' }, viewer)).status).toBe(403);
    expect((await comment(incidentId, 'Looking', viewer)).status).toBe(403);
  });

  it('does not double-resolve when a person resolves while the monitor recovers', async () => {
    const { incidentId, alertId } = await fireAlert();

    // Hold the incident so the automatic resolution queues first and the person's second.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const blocker = prisma.$transaction(
      async (tx) => {
        await lockIncident(tx, incidentId);
        await held;
      },
      { timeout: 20_000 },
    );
    const waitingOnLocks = async (n: number) => {
      for (let i = 0; i < 100; i++) {
        const [row] = await prisma.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND datname = current_database()`;
        if ((row?.n ?? 0) >= n) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('queries never queued on the lock');
    };

    const automatic = recover(alertId);
    await waitingOnLocks(1);
    const manual = patch(incidentId, { status: 'RESOLVED' }).then((r) => r);
    await waitingOnLocks(2);
    release();
    await blocker;
    await automatic;
    expect((await manual).status).toBe(200);

    const incident = await prisma.incident.findUniqueOrThrow({ where: { id: incidentId } });
    expect(incident).toMatchObject({ status: 'RESOLVED', resolvedById: null });
    expect(
      await prisma.incidentEvent.count({
        where: { incidentId, type: 'STATUS_CHANGED', toValue: 'RESOLVED' },
      }),
    ).toBe(1);
  });
});

describe('POST /api/incidents/:id/events', () => {
  it('adds a comment to the timeline', async () => {
    const { incidentId } = await fireAlert();
    const member = await userWithRole('Mia Member', 'MEMBER');
    const res = await comment(incidentId, '  Rolled back the deploy.  ', member);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      type: 'COMMENT',
      message: 'Rolled back the deploy.',
      actor: { id: member.id, name: 'Mia Member' },
    });
    const detail = await request(app).get(`/api/incidents/${incidentId}`).set(owner.auth);
    expect(detail.body.data.events.at(-1)).toMatchObject({ type: 'COMMENT' });

    expect((await comment(incidentId, '   ')).status).toBe(400);
    expect((await comment(incidentId, 'x'.repeat(2001))).status).toBe(400);
  });
});

describe('incidents and alert rules', () => {
  it('keeps the incident open when its rule is changed, noting why the alert closed', async () => {
    const rule = await prisma.alertRule.create({
      data: {
        projectId,
        monitorId,
        name: 'Error spike',
        metric: 'ERROR_RATE',
        threshold: 5,
        durationMinutes: 5,
        severity: 'HIGH',
        state: 'FIRING',
      },
    });
    const { incidentId, alertId } = await fireAlert();
    await prisma.alert.update({ where: { id: alertId }, data: { ruleId: rule.id } });

    const fired = await request(app).get('/api/alerts/fired').query({ projectId }).set(owner.auth);
    expect(fired.body.data[0].incident).toEqual({ id: incidentId, number: 1 });

    const res = await request(app)
      .patch(`/api/alerts/${rule.id}`)
      .set(owner.auth)
      .send({ threshold: 10 });
    expect(res.status).toBe(200);

    const detail = await request(app).get(`/api/incidents/${incidentId}`).set(owner.auth);
    expect(detail.body.data).toMatchObject({ status: 'OPEN', firingAlerts: 0 });
    expect(detail.body.data.events.at(-1)).toMatchObject({
      type: 'ALERT_RESOLVED',
      message: 'Error spike: closed because the rule was changed',
    });
  });
});
