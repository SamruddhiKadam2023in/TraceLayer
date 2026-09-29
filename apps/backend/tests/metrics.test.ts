import request from 'supertest';
import { computeHealth, type WorkspaceRole } from '@tracelayer/shared';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { createTestUser, resetDatabase, type TestUser } from './helpers';

jest.mock('../src/lib/monitor-queue', () => ({
  syncMonitorSchedule: jest.fn(),
  unscheduleMonitor: jest.fn(),
  enqueueMonitorRun: jest.fn(),
  closeMonitorQueue: jest.fn(),
}));

let app: ReturnType<typeof createApp>;
let owner: TestUser;
let workspaceId: string;
let projectId: string;
let environmentId: string;
let endpointA: string;
let endpointB: string;
let monitorA: string;
let monitorB: string;
let monitorC: string;

const MINUTE = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

interface RunSpec {
  monitorId: string;
  endpointId: string;
  minutesAgo: number;
  success: boolean;
  statusCode: number | null;
  durationMs: number | null;
}

async function insertRuns(runs: RunSpec[]) {
  await prisma.monitorRun.createMany({
    data: runs.map((r) => ({
      monitorId: r.monitorId,
      projectId,
      endpointId: r.endpointId,
      environmentId,
      startedAt: ago(r.minutesAgo * MINUTE),
      success: r.success,
      statusCode: r.statusCode,
      durationMs: r.durationMs,
      timedOut: r.statusCode === null,
    })),
  });
}

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
  environmentId = envs.body.data.find((e: { name: string }) => e.name === 'Production').id;

  const endpoint = (name: string) =>
    prisma.endpoint.create({
      data: { projectId, name, method: 'GET', url: 'https://api.example.com/' },
    });
  endpointA = (await endpoint('Orders')).id;
  endpointB = (await endpoint('Payments')).id;
  const monitor = (name: string, endpointId: string) =>
    prisma.monitor.create({
      data: {
        projectId,
        endpointId,
        environmentId,
        name,
        type: 'STATUS',
        intervalSeconds: 60,
        timeoutMs: 5000,
      },
    });
  monitorA = (await monitor('A orders', endpointA)).id;
  monitorB = (await monitor('B payments', endpointB)).id;
  monitorC = (await monitor('C never ran', endpointA)).id;

  const a = { monitorId: monitorA, endpointId: endpointA };
  const b = { monitorId: monitorB, endpointId: endpointB };
  await insertRuns([
    // Monitor A: five good responses and one timeout (the most recent run).
    { ...a, minutesAgo: 50, success: true, statusCode: 200, durationMs: 100 },
    { ...a, minutesAgo: 40, success: true, statusCode: 200, durationMs: 200 },
    { ...a, minutesAgo: 30, success: true, statusCode: 200, durationMs: 300 },
    { ...a, minutesAgo: 20, success: true, statusCode: 200, durationMs: 400 },
    { ...a, minutesAgo: 10, success: true, statusCode: 200, durationMs: 1000 },
    { ...a, minutesAgo: 5, success: false, statusCode: null, durationMs: 5000 },
    // Monitor B: two failed responses.
    { ...b, minutesAgo: 45, success: false, statusCode: 500, durationMs: 50 },
    { ...b, minutesAgo: 15, success: false, statusCode: 404, durationMs: 60 },
    // Outside 24h, inside 7d.
    { ...a, minutesAgo: 2 * 24 * 60, success: true, statusCode: 200, durationMs: 150 },
  ]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const get = (path: string, query: object = {}, user = owner) =>
  request(app)
    .get(`/api/metrics${path}`)
    .query({ projectId, ...query })
    .set(user.auth);

describe('GET /api/metrics/summary', () => {
  it('computes totals, uptime, error rate and status distribution from real runs', async () => {
    const res = await get('/summary', { range: '24h' });

    expect(res.status).toBe(200);
    expect(res.body.data.range).toBe('24h');
    expect(res.body.data.totals).toEqual({
      total: 8,
      successful: 5,
      failed: 3,
      uptime: 62.5,
      errorRate: 37.5,
    });
    expect(res.body.data.statusCodes).toEqual({
      '2xx': 5,
      '3xx': 0,
      '4xx': 1,
      '5xx': 1,
      noResponse: 1,
    });
  });

  it('computes latency over responses only, with interpolated percentiles', async () => {
    // Durations with a response: 50, 60, 100, 200, 300, 400, 1000 (the 5000 ms timeout is excluded).
    // p50 is the 4th value; p95 sits at rank 5.7 → 400 + 0.7 × 600; p99 at rank 5.94.
    const res = await get('/summary', { range: '24h' });
    expect(res.body.data.latency).toEqual({
      avg: 301,
      min: 50,
      max: 1000,
      p50: 200,
      p95: 820,
      p99: 964,
    });
  });

  it('respects the time range', async () => {
    expect((await get('/summary', { range: '1h' })).body.data.totals.total).toBe(8);
    expect((await get('/summary', { range: '7d' })).body.data.totals.total).toBe(9);
  });

  it('filters by monitor, endpoint and environment', async () => {
    const byMonitor = await get('/summary', { monitorId: monitorA });
    // Monitor A: 5 of 6 succeeded; latency over 100, 200, 300, 400, 1000.
    expect(byMonitor.body.data.totals).toMatchObject({
      total: 6,
      successful: 5,
      uptime: 83.33,
      errorRate: 16.67,
    });
    expect(byMonitor.body.data.latency).toMatchObject({ avg: 400, p50: 300, p95: 880, p99: 976 });

    expect((await get('/summary', { endpointId: endpointB })).body.data.totals.total).toBe(2);
    expect((await get('/summary', { environmentId })).body.data.totals.total).toBe(8);
  });

  it('returns nulls, not zeros, when there is no data', async () => {
    const res = await get('/summary', { monitorId: monitorC });
    expect(res.body.data.totals).toEqual({
      total: 0,
      successful: 0,
      failed: 0,
      uptime: null,
      errorRate: null,
    });
    expect(res.body.data.latency).toEqual({
      avg: null,
      min: null,
      max: null,
      p50: null,
      p95: null,
      p99: null,
    });
  });
});

describe('time series', () => {
  it('buckets volume and errors per minute over the last hour, including empty buckets', async () => {
    const res = await get('/errors', { range: '1h' });
    const { points, bucketMs } = res.body.data;

    expect(bucketMs).toBe(60_000);
    expect(points.length).toBeGreaterThanOrEqual(60);
    expect(points.length).toBeLessThanOrEqual(62);
    // Buckets are contiguous and one minute apart.
    for (let i = 1; i < points.length; i++) {
      expect(Date.parse(points[i].t) - Date.parse(points[i - 1].t)).toBe(60_000);
    }
    const sum = (key: 'total' | 'failed') =>
      points.reduce((acc: number, p: { total: number; failed: number }) => acc + p[key], 0);
    expect(sum('total')).toBe(8);
    expect(sum('failed')).toBe(3);
    const empty = points.find((p: { total: number }) => p.total === 0);
    expect(empty).toMatchObject({ failed: 0, errorRate: null });
    const withFailure = points.find((p: { failed: number }) => p.failed > 0);
    expect(withFailure.errorRate).toBe(100);
  });

  it('reports latency per bucket, null where there were no responses', async () => {
    const res = await get('/latency', { range: '1h', monitorId: monitorA });
    const values = res.body.data.points
      .filter((p: { avg: number | null }) => p.avg !== null)
      .map((p: { avg: number }) => p.avg);
    expect(values.sort((x: number, y: number) => x - y)).toEqual([100, 200, 300, 400, 1000]);
  });

  it('uses coarser buckets for longer ranges', async () => {
    const res = await get('/errors', { range: '7d' });
    expect(res.body.data.bucketMs).toBe(3_600_000);
    expect(res.body.data.points.length).toBeGreaterThanOrEqual(168);
    expect(
      res.body.data.points.reduce((acc: number, p: { total: number }) => acc + p.total, 0),
    ).toBe(9);
  });
});

describe('GET /api/metrics (per monitor)', () => {
  it('lists each monitor with its numbers and health, and counts health states', async () => {
    const res = await get('', { range: '24h' });
    const byName = Object.fromEntries(
      res.body.data.monitors.map((m: { monitor: { name: string } }) => [m.monitor.name, m]),
    );

    // A: latest run failed, others fine → degraded. B: every run failed → failing.
    expect(byName['A orders']).toMatchObject({
      health: 'DEGRADED',
      totals: { total: 6, uptime: 83.33 },
      latency: { avg: 400, p95: 880 },
      endpoint: { name: 'Orders' },
      environment: { name: 'Production' },
    });
    expect(byName['B payments']).toMatchObject({
      health: 'FAILING',
      totals: { total: 2, uptime: 0 },
    });
    expect(byName['C never ran']).toMatchObject({
      health: 'NO_DATA',
      totals: { total: 0, uptime: null },
    });
    expect(res.body.data.health).toEqual({ HEALTHY: 0, DEGRADED: 1, FAILING: 1, NO_DATA: 1 });
  });

  it('exposes health on the monitor list too', async () => {
    const res = await request(app).get('/api/monitors').query({ projectId }).set(owner.auth);
    expect(res.body.data.map((m: { name: string; health: string }) => [m.name, m.health])).toEqual([
      ['A orders', 'DEGRADED'],
      ['B payments', 'FAILING'],
      ['C never ran', 'NO_DATA'],
    ]);
  });
});

describe('workspace scope (the dashboard)', () => {
  async function projectWithRun(wsId: string, name: string, success: boolean) {
    const project = await prisma.project.create({ data: { workspaceId: wsId, name } });
    const endpoint = await prisma.endpoint.create({
      data: { projectId: project.id, name: 'E', method: 'GET', url: 'https://x.example.com/' },
    });
    const monitor = await prisma.monitor.create({
      data: {
        projectId: project.id,
        endpointId: endpoint.id,
        name: `${name} monitor`,
        type: 'STATUS',
        intervalSeconds: 60,
        timeoutMs: 5000,
      },
    });
    await prisma.monitorRun.create({
      data: {
        monitorId: monitor.id,
        projectId: project.id,
        endpointId: endpoint.id,
        startedAt: ago(3 * MINUTE),
        success,
        statusCode: success ? 200 : 503,
        durationMs: 250,
      },
    });
  }

  it('aggregates every project in the workspace, and nothing outside it', async () => {
    await projectWithRun(workspaceId, 'Second project', true);
    const otherWorkspace = await prisma.workspace.create({ data: { name: 'Elsewhere' } });
    await projectWithRun(otherWorkspace.id, 'Not ours', false);

    const res = await request(app)
      .get('/api/metrics/summary')
      .query({ workspaceId, range: '24h' })
      .set(owner.auth);
    // The 8 runs of the first project plus 1 from the second; the other workspace's run is excluded.
    expect(res.body.data.totals).toMatchObject({ total: 9, successful: 6, failed: 3 });

    const overview = await request(app).get('/api/metrics').query({ workspaceId }).set(owner.auth);
    expect(
      overview.body.data.monitors.map(
        (m: { project: { name: string }; monitor: { name: string } }) =>
          `${m.project.name} / ${m.monitor.name}`,
      ),
    ).toEqual([
      'Orders API / A orders',
      'Orders API / B payments',
      'Orders API / C never ran',
      'Second project / Second project monitor',
    ]);
  });

  it('requires exactly one of projectId and workspaceId, and membership', async () => {
    const neither = await request(app).get('/api/metrics/summary').set(owner.auth);
    expect(neither.status).toBe(400);
    const both = await request(app)
      .get('/api/metrics/summary')
      .query({ projectId, workspaceId })
      .set(owner.auth);
    expect(both.status).toBe(400);

    const outsider = await createTestUser(app, 'Eve Outsider');
    const res = await request(app)
      .get('/api/metrics/summary')
      .query({ workspaceId })
      .set(outsider.auth);
    expect(res.status).toBe(404);
  });
});

describe('metrics access and validation', () => {
  it('is readable by viewers and hidden from outsiders', async () => {
    const viewer = await createTestUser(app, 'Vic Viewer');
    await prisma.workspaceMember.create({
      data: { workspaceId, userId: viewer.id, role: 'VIEWER' as WorkspaceRole },
    });
    expect((await get('/summary', {}, viewer)).status).toBe(200);

    const outsider = await createTestUser(app, 'Eve Outsider');
    expect((await get('/summary', {}, outsider)).status).toBe(404);
  });

  it('rejects unknown ranges and monitors from other projects', async () => {
    expect((await get('/summary', { range: '90d' })).status).toBe(400);
    const other = await request(app)
      .post('/api/projects')
      .set(owner.auth)
      .send({ workspaceId, name: 'Other' });
    const otherEndpoint = await prisma.endpoint.create({
      data: {
        projectId: other.body.data.id,
        name: 'X',
        method: 'GET',
        url: 'https://x.example.com/',
      },
    });
    const otherMonitor = await prisma.monitor.create({
      data: {
        projectId: other.body.data.id,
        endpointId: otherEndpoint.id,
        name: 'Elsewhere',
        type: 'STATUS',
        intervalSeconds: 60,
        timeoutMs: 5000,
      },
    });
    expect((await get('/summary', { monitorId: otherMonitor.id })).status).toBe(404);
  });
});

describe('computeHealth', () => {
  const runs = (pattern: string) => [...pattern].map((c) => ({ success: c === '✓' }));

  it.each([
    ['', 'NO_DATA'],
    ['✓✓✓✓✓✓✓✓✓✓', 'HEALTHY'],
    ['✗✓✓✓✓✓✓✓✓✓', 'DEGRADED'], // a single recent failure is intermittent
    ['✓✓✓✓✓✓✓✓✓✗', 'DEGRADED'],
    ['✗✗✓✓✓✓✓✓✓✓', 'DEGRADED'],
    ['✗✗✗✓✓✓✓✓✓✓', 'FAILING'], // three failures in a row
    ['✗✓✗✓✗✓✗✓✗✓', 'FAILING'], // half of the window failed
    ['✗✗', 'FAILING'],
    ['✓✗', 'FAILING'],
    ['✓', 'HEALTHY'],
    ['✓✓✓✓✓✓✓✓✓✓✗✗✗✗✗', 'HEALTHY'], // only the latest 10 runs count
  ])('%s → %s', (pattern, expected) => {
    expect(computeHealth(runs(pattern))).toBe(expected);
  });
});
