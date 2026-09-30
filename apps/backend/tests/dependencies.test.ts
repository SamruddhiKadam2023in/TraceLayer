import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { WorkspaceRole } from '@tracelayer/shared';

jest.mock('../src/lib/monitor-queue', () => ({
  syncMonitorSchedule: jest.fn(),
  unscheduleMonitor: jest.fn(),
  enqueueMonitorRun: jest.fn(),
  closeMonitorQueue: jest.fn(),
}));

import { createApp } from '../src/app';
import { lockRow } from '../src/lib/locks';
import { prisma } from '../src/lib/prisma';
import { createTestUser, resetDatabase, type TestUser } from './helpers';

let app: ReturnType<typeof createApp>;
let owner: TestUser;
let workspaceId: string;
let projectId: string;

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
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function userWithRole(name: string, role: WorkspaceRole): Promise<TestUser> {
  const user = await createTestUser(app, name);
  await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role } });
  return user;
}

const node = (label: string, extra: object = {}) => ({
  id: randomUUID(),
  label,
  kind: 'SERVICE',
  origin: 'MANUAL',
  host: null,
  x: 0,
  y: 0,
  ...extra,
});
const edge = (sourceId: string, targetId: string, extra: object = {}) => ({
  id: randomUUID(),
  sourceId,
  targetId,
  origin: 'MANUAL',
  label: null,
  ...extra,
});

const getMap = (user = owner, project = projectId) =>
  request(app).get('/api/dependencies').query({ projectId: project }).set(user.auth);
const save = (body: object, user = owner) =>
  request(app)
    .put('/api/dependencies')
    .set(user.auth)
    .send({ projectId, version: 0, nodes: [], edges: [], ...body });

/** An environment, endpoint and monitor calling `baseUrl`, with runs of the given outcomes. */
async function monitoredHost(baseUrl: string, outcomes: boolean[], name = 'Health') {
  const environment = await prisma.environment.create({
    data: { projectId, name: `${name} env`, baseUrl },
  });
  const endpoint = await prisma.endpoint.create({
    data: { projectId, name, method: 'GET', url: '/health', environmentId: environment.id },
  });
  const monitor = await prisma.monitor.create({
    data: {
      projectId,
      endpointId: endpoint.id,
      environmentId: environment.id,
      name,
      type: 'STATUS',
      intervalSeconds: 60,
      timeoutMs: 5000,
    },
  });
  await prisma.monitorRun.createMany({
    data: outcomes.map((success, i) => ({
      monitorId: monitor.id,
      projectId,
      endpointId: endpoint.id,
      startedAt: new Date(Date.now() - (outcomes.length - i) * 60_000),
      success,
      statusCode: success ? 200 : 503,
      durationMs: 100,
    })),
  });
}

describe('GET /api/dependencies', () => {
  it('starts empty at version 0', async () => {
    const res = await getMap();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ projectId, version: 0, nodes: [], edges: [] });
  });

  it('shows each node’s health from the monitors calling its host', async () => {
    await monitoredHost('https://api.example.com', [true, true, false], 'Orders');
    await monitoredHost('https://api.example.com', [false, false, false], 'Search');
    const gateway = node('Gateway', { kind: 'GATEWAY' });
    const orders = node('Orders', { host: 'API.example.com', x: 0, y: 160 });
    const db = node('Orders DB', { kind: 'DATABASE', y: 320 });
    await save({ nodes: [gateway, orders, db], edges: [edge(gateway.id, orders.id)] }).expect(200);

    const res = await getMap();
    const byLabel = Object.fromEntries(
      res.body.data.nodes.map((n: { label: string }) => [n.label, n]),
    );
    // Hosts are stored lowercased; the worst of the two monitors wins.
    expect(byLabel.Orders).toMatchObject({
      host: 'api.example.com',
      health: 'FAILING',
      monitorCount: 2,
    });
    expect(byLabel['Orders DB']).toMatchObject({ health: null, monitorCount: 0 });
  });

  it('is readable by viewers and hidden from outsiders', async () => {
    const viewer = await userWithRole('Vera Viewer', 'VIEWER');
    expect((await getMap(viewer)).status).toBe(200);
    const outsider = await createTestUser(app, 'Oscar Outsider');
    expect((await getMap(outsider)).status).toBe(404);
    expect((await request(app).get('/api/dependencies').set(owner.auth)).status).toBe(400);
  });
});

describe('PUT /api/dependencies', () => {
  it('saves the whole diagram and bumps the version; later saves replace it', async () => {
    const frontend = node('Frontend', { kind: 'FRONTEND', x: 10.4, y: -20.6 });
    const gateway = node('API Gateway', { kind: 'GATEWAY' });
    const first = await save({
      nodes: [frontend, gateway],
      edges: [edge(frontend.id, gateway.id, { label: 'HTTPS' })],
    });
    expect(first.status).toBe(200);
    expect(first.body.data.version).toBe(1);
    expect(first.body.data.nodes).toHaveLength(2);
    // Positions are stored as whole pixels.
    expect(first.body.data.nodes.find((n: { id: string }) => n.id === frontend.id)).toMatchObject({
      x: 10,
      y: -21,
    });
    expect(first.body.data.edges).toEqual([
      expect.objectContaining({ sourceId: frontend.id, targetId: gateway.id, label: 'HTTPS' }),
    ]);

    // Rename one, remove the other (its connections go with it).
    const second = await save({
      version: 1,
      nodes: [{ ...frontend, label: 'Web app' }],
      edges: [],
    });
    expect(second.body.data).toMatchObject({ version: 2, edges: [] });
    expect(second.body.data.nodes.map((n: { label: string }) => n.label)).toEqual(['Web app']);
  });

  it('refuses a save based on an outdated version, keeping the newer map', async () => {
    await save({ nodes: [node('Theirs')] }).expect(200);
    const stale = await save({ version: 0, nodes: [node('Mine')] });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toMatch(/Reload/);
    expect((await getMap()).body.data.nodes.map((n: { label: string }) => n.label)).toEqual([
      'Theirs',
    ]);
  });

  it('validates the diagram', async () => {
    const a = node('A');
    const b = node('B');
    const cases: object[] = [
      { nodes: [a], edges: [edge(a.id, randomUUID())] }, // unknown node
      { nodes: [a], edges: [edge(a.id, a.id)] }, // self-dependency
      { nodes: [a, b], edges: [edge(a.id, b.id), edge(a.id, b.id)] }, // duplicate connection
      { nodes: [a, { ...a, label: 'A again' }] }, // duplicate node id
      { nodes: [node('')] },
      { nodes: [node('Bad host', { host: 'https://x.io/path' })] },
      { nodes: Array.from({ length: 101 }, (_, i) => node(`N${i}`)) },
      { nodes: [node('Far', { x: 1e9 })] },
    ];
    for (const body of cases) {
      const res = await save(body);
      expect(res.status).toBe(400);
    }
    expect((await getMap()).body.data.version).toBe(0);
  });

  it('never reuses an id that belongs to another project', async () => {
    const other = (
      await request(app).post('/api/projects').set(owner.auth).send({ workspaceId, name: 'Other' })
    ).body.data.id;
    const theirs = node('Theirs');
    await request(app)
      .put('/api/dependencies')
      .set(owner.auth)
      .send({ projectId: other, version: 0, nodes: [theirs], edges: [] })
      .expect(200);

    const res = await save({ nodes: [{ ...theirs, label: 'Hijacked' }] });
    expect(res.status).toBe(400);
    expect((await getMap(owner, other)).body.data.nodes[0].label).toBe('Theirs');
  });

  it('lets members edit but not viewers', async () => {
    const member = await userWithRole('Mia Member', 'MEMBER');
    expect((await save({ nodes: [node('A')] }, member)).status).toBe(200);
    const viewer = await userWithRole('Vera Viewer', 'VIEWER');
    expect((await save({ version: 1, nodes: [] }, viewer)).status).toBe(403);
  });

  it('accepts only one of two saves made from the same version at the same moment', async () => {
    // Hold the project row so both saves queue up, then let them race.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const blocker = prisma.$transaction(
      async (tx) => {
        await lockRow(tx, 'projects', projectId);
        await held;
      },
      { timeout: 20_000 },
    );
    const waiting = async (n: number) => {
      for (let i = 0; i < 100; i++) {
        const [row] = await prisma.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND datname = current_database()`;
        if ((row?.n ?? 0) >= n) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('saves never queued on the lock');
    };

    const first = save({ nodes: [node('First')] }).then((r) => r);
    const second = save({ nodes: [node('Second')] }).then((r) => r);
    await waiting(2);
    release();
    await blocker;
    const statuses = [(await first).status, (await second).status].sort();
    expect(statuses).toEqual([200, 409]);
    expect((await getMap()).body.data.version).toBe(1);
  });
});

describe('GET /api/dependencies/suggestions', () => {
  const suggestions = (user = owner) =>
    request(app).get('/api/dependencies/suggestions').query({ projectId }).set(user.auth);

  it('infers a node per called host, connected from a suggested Clients node', async () => {
    await monitoredHost('https://api.example.com', [true, false], 'Orders');
    await prisma.endpoint.create({
      data: { projectId, name: 'Pay', method: 'POST', url: 'https://pay.example.com/charge' },
    });
    // Relative with no environment, or templated: cannot be resolved, so skipped.
    await prisma.endpoint.create({
      data: { projectId, name: 'Relative', method: 'GET', url: '/nowhere' },
    });

    const res = await suggestions();
    expect(res.status).toBe(200);
    const { nodes, edges } = res.body.data;
    expect(
      nodes.map((n: { label: string; kind: string; origin: string; health: string | null }) => [
        n.label,
        n.kind,
        n.origin,
        n.health,
      ]),
    ).toEqual([
      ['Clients', 'FRONTEND', 'INFERRED', null],
      ['api.example.com', 'SERVICE', 'INFERRED', 'FAILING'],
      ['pay.example.com', 'SERVICE', 'INFERRED', null],
    ]);
    expect(edges).toHaveLength(2);
    expect(
      edges.every((e: { sourceId: string; origin: string }) => e.sourceId === nodes[0].id),
    ).toBe(true);
    expect(edges.every((e: { origin: string }) => e.origin === 'INFERRED')).toBe(true);

    // Suggestions can be saved as they are.
    expect((await save({ nodes, edges })).status).toBe(200);
    // Once on the map, they are not suggested again.
    expect((await suggestions()).body.data).toEqual({ nodes: [], edges: [] });
  });

  it('connects new hosts from the existing entry point instead', async () => {
    await monitoredHost('https://api.example.com', [true]);
    const gateway = node('Gateway', { kind: 'GATEWAY' });
    await save({ nodes: [gateway] }).expect(200);

    const { nodes, edges } = (await suggestions()).body.data;
    expect(nodes.map((n: { label: string }) => n.label)).toEqual(['api.example.com']);
    expect(edges).toEqual([
      expect.objectContaining({ sourceId: gateway.id, targetId: nodes[0].id, origin: 'INFERRED' }),
    ]);
  });

  it('suggests nothing for a project without endpoints, and only to editors', async () => {
    expect((await suggestions()).body.data).toEqual({ nodes: [], edges: [] });
    const viewer = await userWithRole('Vera Viewer', 'VIEWER');
    expect((await suggestions(viewer)).status).toBe(403);
  });
});
