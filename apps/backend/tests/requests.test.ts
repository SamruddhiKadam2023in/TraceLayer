import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { WorkspaceRole } from '@tracelayer/shared';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { createTestUser, resetDatabase, type TestUser } from './helpers';

const SECRET = 'sk_live_super_secret_42';

// A throwaway upstream API that echoes what it receives.
let upstream: Server;
let upstreamOrigin: string;
beforeAll(async () => {
  upstream = createServer((req, res) => {
    if (req.url?.startsWith('/missing')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization ?? null }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  await prisma.$disconnect();
});

let app: ReturnType<typeof createApp>;
let owner: TestUser;
let workspaceId: string;
let projectId: string;
let productionId: string;

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
    .send({ baseUrl: upstreamOrigin });
  await request(app)
    .post(`/api/projects/${projectId}/environments/${productionId}/variables`)
    .set(owner.auth)
    .send({ key: 'API_TOKEN', value: SECRET, isSecret: true });
  await request(app)
    .post(`/api/projects/${projectId}/environments/${productionId}/variables`)
    .set(owner.auth)
    .send({ key: 'ORDER_ID', value: '42' });
});

function baseRequest(overrides: object = {}) {
  return {
    method: 'GET',
    url: '/orders/{{ORDER_ID}}',
    headers: [],
    queryParams: [],
    body: { type: 'none' },
    auth: { type: 'bearer', token: '{{API_TOKEN}}' },
    timeoutMs: 5000,
    ...overrides,
  };
}

function execute(body: object = {}, user = owner) {
  return request(app)
    .post('/api/requests/execute')
    .set(user.auth)
    .send({ projectId, environmentId: productionId, request: baseRequest(), ...body });
}

async function userWithRole(name: string, role: WorkspaceRole): Promise<TestUser> {
  const user = await createTestUser(app, name);
  await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role } });
  return user;
}

describe('POST /api/requests/execute', () => {
  it('runs the request with variables and secrets resolved on the server', async () => {
    const res = await execute();

    expect(res.status).toBe(200);
    const { result, historyId } = res.body.data;
    expect(result.error).toBeNull();
    expect(result.response.status).toBe(200);
    // The upstream really received the decrypted secret and the substituted path...
    expect(JSON.parse(result.response.body.replaceAll('••••••', 'MASKED'))).toEqual({
      path: '/orders/42',
      auth: 'Bearer MASKED',
    });
    // ...but the secret never comes back to the client.
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(historyId).toEqual(expect.any(String));
  });

  it('records history without secrets, and can skip recording', async () => {
    await execute({
      request: baseRequest({
        auth: { type: 'apiKey', in: 'query', name: 'key', value: '{{API_TOKEN}}' },
      }),
    });
    const [entry] = await prisma.requestHistory.findMany();
    expect(entry).toMatchObject({
      projectId,
      environmentId: productionId,
      userId: owner.id,
      status: 200,
      method: 'GET',
    });
    expect(entry?.url).toContain('/orders/42?key=');
    expect(entry?.url).not.toContain(SECRET);

    const skipped = await execute({ saveToHistory: false });
    expect(skipped.body.data.historyId).toBeNull();
    expect(await prisma.requestHistory.count()).toBe(1);
  });

  it('reports missing variables as a validation error without sending anything', async () => {
    const res = await execute({ request: baseRequest({ url: '/orders/{{NOPE}}' }) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Not defined in Production: NOPE');
    expect(await prisma.requestHistory.count()).toBe(0);
  });

  it('refuses to send a secret anywhere but the environment’s base URL', async () => {
    const res = await execute({ request: baseRequest({ url: 'http://127.0.0.1:1/collect' }) });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('url');
    expect(res.body.error.message).toContain('Secret variables can only be sent to');
  });

  it('records network failures as results, not API errors', async () => {
    const res = await execute({
      request: baseRequest({ url: 'http://127.0.0.1:1/', auth: { type: 'none' } }),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.result.error.code).toBe('CONNECTION_REFUSED');
    const [entry] = await prisma.requestHistory.findMany();
    expect(entry).toMatchObject({ status: null, errorCode: 'CONNECTION_REFUSED' });
  });

  it('checks that the environment and endpoint belong to the project', async () => {
    const other = await request(app)
      .post('/api/projects')
      .set(owner.auth)
      .send({ workspaceId, name: 'Other' });
    const otherEnvs = await request(app)
      .get(`/api/projects/${other.body.data.id}/environments`)
      .set(owner.auth);

    const wrongEnv = await execute({ environmentId: otherEnvs.body.data[0].id });
    expect(wrongEnv.status).toBe(404);
    expect(wrongEnv.body.error.details[0].path).toBe('environmentId');

    const wrongEndpoint = await execute({ endpointId: '00000000-0000-4000-8000-000000000000' });
    expect(wrongEndpoint.status).toBe(404);
    expect(wrongEndpoint.body.error.details[0].path).toBe('endpointId');
  });

  it('lets members run requests but not viewers or outsiders', async () => {
    const member = await userWithRole('Mia Member', 'MEMBER');
    const viewer = await userWithRole('Vic Viewer', 'VIEWER');
    const outsider = await createTestUser(app, 'Eve Outsider');

    expect((await execute({}, member)).status).toBe(200);
    expect((await execute({}, viewer)).status).toBe(403);
    expect((await execute({}, outsider)).status).toBe(404);
  });
});

describe('GET /api/requests/history', () => {
  let endpointId: string;
  beforeEach(async () => {
    endpointId = (
      await request(app)
        .post('/api/endpoints')
        .set(owner.auth)
        .send({ projectId, name: 'Get order', method: 'GET', url: '/orders/{{ORDER_ID}}' })
    ).body.data.id;
    await execute({ endpointId });
    await execute({ request: baseRequest({ url: '/missing' }) });
    await execute({ request: baseRequest({ method: 'DELETE', url: '/orders/1' }) });
    await execute({ request: baseRequest({ url: 'http://127.0.0.1:1/', auth: { type: 'none' } }) });
  });

  const history = (query: object = {}, user = owner) =>
    request(app)
      .get('/api/requests/history')
      .query({ projectId, ...query })
      .set(user.auth);

  it('lists newest first with endpoint, environment and user', async () => {
    const res = await history();
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(4);
    const items = res.body.data.items;
    expect(items.map((i: { status: number | null }) => i.status)).toEqual([null, 200, 404, 200]);
    expect(items[3]).toMatchObject({
      endpoint: { id: endpointId, name: 'Get order' },
      environment: { id: productionId, name: 'Production' },
      user: { id: owner.id, name: 'Olivia Owner' },
    });
  });

  it('filters by status class, method, endpoint and URL text', async () => {
    const statuses = async (query: object) =>
      (await history(query)).body.data.items.map(
        (i: { status: number | null; method: string }) => `${i.method} ${i.status}`,
      );

    expect(await statuses({ status: '4xx' })).toEqual(['GET 404']);
    expect(await statuses({ status: 'error' })).toEqual(['GET null']);
    expect(await statuses({ method: 'DELETE' })).toEqual(['DELETE 200']);
    expect(await statuses({ endpointId })).toEqual(['GET 200']);
    expect(await statuses({ search: 'MISSING' })).toEqual(['GET 404']);
  });

  it('filters by date range', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await history({ from: future })).body.data.total).toBe(0);
    expect((await history({ to: future })).body.data.total).toBe(4);
    const bad = await history({ from: future, to: new Date(0).toISOString() });
    expect(bad.status).toBe(400);
  });

  it('sorts and paginates stably', async () => {
    const page1 = (await history({ sort: 'status', order: 'asc', pageSize: 2, page: 1 })).body.data;
    const page2 = (await history({ sort: 'status', order: 'asc', pageSize: 2, page: 2 })).body.data;
    expect(page1).toMatchObject({ total: 4, page: 1, pageSize: 2 });
    const all = [...page1.items, ...page2.items];
    expect(all.map((i: { status: number | null }) => i.status)).toEqual([null, 200, 200, 404]);
    expect(new Set(all.map((i: { id: string }) => i.id)).size).toBe(4);
  });

  it('is readable by viewers, hidden from outsiders, and validates the query', async () => {
    const viewer = await userWithRole('Vic Viewer', 'VIEWER');
    expect((await history({}, viewer)).status).toBe(200);
    const outsider = await createTestUser(app, 'Eve Outsider');
    expect((await history({}, outsider)).status).toBe(404);
    expect((await history({ pageSize: 500 })).status).toBe(400);
    expect((await history({ status: '6xx' })).status).toBe(400);
  });
});
