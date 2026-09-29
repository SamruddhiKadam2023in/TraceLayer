import request from 'supertest';
import { MAX_MONITORS_PER_PROJECT, type WorkspaceRole } from '@tracelayer/shared';

// Scheduling is BullMQ's job; here we check the API asks for the right schedule changes.
// (The worker's tests run the real scheduler against Redis.)
const mockSync = jest.fn();
const mockUnschedule = jest.fn();
const mockEnqueue = jest.fn();
jest.mock('../src/lib/monitor-queue', () => ({
  syncMonitorSchedule: mockSync,
  unscheduleMonitor: mockUnschedule,
  enqueueMonitorRun: mockEnqueue,
  closeMonitorQueue: jest.fn(),
}));

import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { createTestUser, resetDatabase, type TestUser } from './helpers';

let app: ReturnType<typeof createApp>;
let owner: TestUser;
let workspaceId: string;
let projectId: string;
let productionId: string;
let endpointId: string;

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
  const envs = await request(app).get(`/api/projects/${projectId}/environments`).set(owner.auth);
  productionId = envs.body.data.find((e: { name: string }) => e.name === 'Production').id;
  await request(app)
    .patch(`/api/projects/${projectId}/environments/${productionId}`)
    .set(owner.auth)
    .send({ baseUrl: 'https://api.example.com' });
  endpointId = (
    await request(app)
      .post('/api/endpoints')
      .set(owner.auth)
      .send({ projectId, name: 'List orders', method: 'GET', url: '/orders', timeoutMs: 4000 })
  ).body.data.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function create(body: object = {}, user = owner) {
  return request(app)
    .post('/api/monitors')
    .set(user.auth)
    .send({
      projectId,
      endpointId,
      environmentId: productionId,
      name: 'Orders availability',
      type: 'AVAILABILITY',
      ...body,
    });
}

async function userWithRole(name: string, role: WorkspaceRole): Promise<TestUser> {
  const user = await createTestUser(app, name);
  await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role } });
  return user;
}

describe('creating monitors', () => {
  it('creates a monitor with defaults and schedules it', async () => {
    const res = await create();

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Orders availability',
      type: 'AVAILABILITY',
      intervalSeconds: 300,
      timeoutMs: 4000, // taken from the endpoint
      expectedStatus: null,
      enabled: true,
      endpoint: { id: endpointId, name: 'List orders', method: 'GET', url: '/orders' },
      environment: { id: productionId, name: 'Production' },
      lastRunAt: null,
      consecutiveFailures: 0,
    });
    expect(mockSync).toHaveBeenCalledWith(
      expect.objectContaining({ id: res.body.data.id, enabled: true, intervalSeconds: 300 }),
    );
  });

  it.each([
    ['a performance monitor without a threshold', { type: 'PERFORMANCE' }, 'latencyThresholdMs'],
    [
      'a threshold that is not below the timeout',
      { type: 'PERFORMANCE', latencyThresholdMs: 5000, timeoutMs: 5000 },
      'latencyThresholdMs',
    ],
    ['response validation with no checks', { type: 'RESPONSE_VALIDATION' }, 'assertions'],
    ['an interval that is not offered', { intervalSeconds: 10 }, 'intervalSeconds'],
    [
      'a comparison without a value',
      { type: 'RESPONSE_VALIDATION', assertions: [{ path: 'status', operator: 'equals' }] },
      'assertions.0.value',
    ],
  ])('rejects %s', async (_label, body, path) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(path);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('accepts each monitor type with its settings', async () => {
    expect((await create({ name: 'S', type: 'STATUS', expectedStatus: 200 })).status).toBe(201);
    expect((await create({ name: 'P', type: 'PERFORMANCE', latencyThresholdMs: 800 })).status).toBe(
      201,
    );
    const validation = await create({
      name: 'V',
      type: 'RESPONSE_VALIDATION',
      assertions: [
        { path: 'status', operator: 'equals', value: 'healthy' },
        { path: 'data.items', operator: 'exists' },
      ],
    });
    expect(validation.status).toBe(201);
    expect(validation.body.data.assertions).toHaveLength(2);
  });

  it('refuses a target that cannot run in the environment', async () => {
    await prisma.endpoint.update({
      where: { id: endpointId },
      data: { url: '/orders/{{MISSING}}' },
    });
    const res = await create();
    expect(res.status).toBe(400);
    expect(res.body.error.details[0]).toMatchObject({ path: 'environmentId' });
    expect(res.body.error.message).toContain('Not defined in Production: MISSING');
  });

  it('only accepts an endpoint and environment from the same project', async () => {
    const other = await request(app)
      .post('/api/projects')
      .set(owner.auth)
      .send({ workspaceId, name: 'Other' });
    const otherEnvs = await request(app)
      .get(`/api/projects/${other.body.data.id}/environments`)
      .set(owner.auth);
    expect((await create({ environmentId: otherEnvs.body.data[0].id })).status).toBe(404);
    expect((await create({ endpointId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
  });

  it('rejects duplicate names and enforces the per-project limit', async () => {
    await create();
    expect((await create({ name: 'ORDERS AVAILABILITY' })).status).toBe(409);

    await prisma.monitor.createMany({
      data: Array.from({ length: MAX_MONITORS_PER_PROJECT - 1 }, (_, i) => ({
        projectId,
        endpointId,
        environmentId: productionId,
        name: `Monitor ${i}`,
        type: 'AVAILABILITY' as const,
        intervalSeconds: 300,
        timeoutMs: 5000,
      })),
    });
    const res = await create({ name: 'One too many' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain(`at most ${MAX_MONITORS_PER_PROJECT} monitors`);
  });
});

describe('managing monitors', () => {
  let id: string;
  beforeEach(async () => {
    id = (await create()).body.data.id;
    mockSync.mockClear();
  });

  it('reschedules when the interval changes and unschedules when paused', async () => {
    const faster = await request(app)
      .patch(`/api/monitors/${id}`)
      .set(owner.auth)
      .send({ intervalSeconds: 60 });
    expect(faster.body.data.intervalSeconds).toBe(60);
    expect(mockSync).toHaveBeenLastCalledWith(
      expect.objectContaining({ id, intervalSeconds: 60, enabled: true }),
    );

    await request(app).patch(`/api/monitors/${id}`).set(owner.auth).send({ enabled: false });
    expect(mockSync).toHaveBeenLastCalledWith(expect.objectContaining({ id, enabled: false }));
  });

  it('validates the merged monitor on update', async () => {
    const res = await request(app)
      .patch(`/api/monitors/${id}`)
      .set(owner.auth)
      .send({ type: 'PERFORMANCE' });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('latencyThresholdMs');
  });

  it('deletes and unschedules; deleting the endpoint removes its monitors', async () => {
    expect((await request(app).delete(`/api/monitors/${id}`).set(owner.auth)).status).toBe(204);
    expect(mockUnschedule).toHaveBeenCalledWith(id);

    await create({ name: 'Second' });
    await request(app).delete(`/api/endpoints/${endpointId}`).set(owner.auth);
    expect(await prisma.monitor.count()).toBe(0);
  });

  it.each([
    ['endpoint', () => `/api/endpoints/${endpointId}`],
    ['project', () => `/api/projects/${projectId}`],
    ['workspace', () => `/api/workspaces/${workspaceId}`],
  ])('unschedules monitors at once when their %s is deleted', async (_label, path) => {
    const second = (await create({ name: 'Second' })).body.data.id;
    mockUnschedule.mockClear();

    expect((await request(app).delete(path()).set(owner.auth)).status).toBe(204);
    expect(await prisma.monitor.count()).toBe(0);
    expect(mockUnschedule.mock.calls.map(([monitorId]) => monitorId).sort()).toEqual(
      [id, second].sort(),
    );
  });

  it('queues a run on demand', async () => {
    const res = await request(app).post(`/api/monitors/${id}/run`).set(owner.auth);
    expect(res.status).toBe(202);
    expect(mockEnqueue).toHaveBeenCalledWith(id);
  });

  it('reports an unavailable queue instead of pretending the run was queued', async () => {
    mockEnqueue.mockRejectedValueOnce(new Error('Redis down'));
    const res = await request(app).post(`/api/monitors/${id}/run`).set(owner.auth);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_ERROR');
  });

  it('lists runs newest first with cursor paging', async () => {
    const base = Date.parse('2026-09-29T10:00:00.000Z');
    await prisma.monitorRun.createMany({
      data: [0, 1, 2].map((i) => ({
        monitorId: id,
        projectId,
        endpointId,
        environmentId: productionId,
        startedAt: new Date(base + i * 60_000),
        success: i !== 1,
        statusCode: i === 1 ? 500 : 200,
        durationMs: 100 + i,
        failureReason: i === 1 ? 'SERVER_ERROR' : null,
      })),
    });

    const first = await request(app)
      .get(`/api/monitors/${id}/runs`)
      .query({ limit: 2 })
      .set(owner.auth);
    expect(first.body.data.map((r: { durationMs: number }) => r.durationMs)).toEqual([102, 101]);
    expect(first.body.data[1]).toMatchObject({
      success: false,
      statusCode: 500,
      failureReason: 'SERVER_ERROR',
    });

    const next = await request(app)
      .get(`/api/monitors/${id}/runs`)
      .query({ limit: 2, before: first.body.data[1].startedAt })
      .set(owner.auth);
    expect(next.body.data.map((r: { durationMs: number }) => r.durationMs)).toEqual([100]);
  });
});

describe('monitor authorization', () => {
  it('lets members manage monitors and viewers only read them', async () => {
    const member = await userWithRole('Mia Member', 'MEMBER');
    const viewer = await userWithRole('Vic Viewer', 'VIEWER');
    const created = await create({}, member);
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    expect(
      (await request(app).get('/api/monitors').query({ projectId }).set(viewer.auth)).status,
    ).toBe(200);
    expect((await request(app).get(`/api/monitors/${id}/runs`).set(viewer.auth)).status).toBe(200);
    expect((await create({ name: 'Viewer' }, viewer)).status).toBe(403);
    expect((await request(app).post(`/api/monitors/${id}/run`).set(viewer.auth)).status).toBe(403);
    expect(
      (await request(app).patch(`/api/monitors/${id}`).set(viewer.auth).send({ enabled: false }))
        .status,
    ).toBe(403);
  });

  it('hides monitors from outsiders as not found', async () => {
    const id = (await create()).body.data.id;
    const outsider = await createTestUser(app, 'Eve Outsider');
    const res = await request(app).get(`/api/monitors/${id}`).set(outsider.auth);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Monitor not found');
    expect((await request(app).post(`/api/monitors/${id}/run`).set(outsider.auth)).status).toBe(
      404,
    );
  });
});
