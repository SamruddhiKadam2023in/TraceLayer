import request from 'supertest';
import { MAX_ENDPOINTS_PER_PROJECT, type WorkspaceRole } from '@tracelayer/shared';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { createTestUser, resetDatabase, type TestUser } from './helpers';

let app: ReturnType<typeof createApp>;
let owner: TestUser;
let workspaceId: string;
let projectId: string;
let environmentIds: Record<string, string>;

beforeEach(async () => {
  await resetDatabase();
  app = createApp();
  owner = await createTestUser(app, 'Olivia Owner');
  const ws = await request(app).post('/api/workspaces').set(owner.auth).send({ name: 'Acme' });
  workspaceId = ws.body.data.id;
  const project = await request(app)
    .post('/api/projects')
    .set(owner.auth)
    .send({ workspaceId, name: 'Orders API' });
  projectId = project.body.data.id;
  const envs = await request(app).get(`/api/projects/${projectId}/environments`).set(owner.auth);
  environmentIds = Object.fromEntries(
    (envs.body.data as { id: string; name: string }[]).map((e) => [e.name, e.id]),
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function userWithRole(name: string, role: WorkspaceRole): Promise<TestUser> {
  const user = await createTestUser(app, name);
  await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role } });
  return user;
}

function create(body: object, user = owner) {
  return request(app)
    .post('/api/endpoints')
    .set(user.auth)
    .send({ projectId, name: 'List orders', method: 'GET', url: '/orders', ...body });
}

describe('creating endpoints', () => {
  it('creates an endpoint with defaults for everything optional', async () => {
    const res = await create({});

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      projectId,
      name: 'List orders',
      description: null,
      method: 'GET',
      url: '/orders',
      environmentId: null,
      headers: [],
      queryParams: [],
      body: { type: 'none' },
      auth: { type: 'none' },
      timeoutMs: 10000,
      expectedStatus: null,
      tags: [],
      createdBy: { id: owner.id, name: 'Olivia Owner' },
    });
  });

  it('stores the full request configuration', async () => {
    const res = await create({
      name: 'Create order',
      method: 'POST',
      url: 'https://api.example.com/orders/{{TENANT}}',
      description: 'Places an order',
      environmentId: environmentIds.Production,
      headers: [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'Authorization', value: 'Bearer {{API_TOKEN}}', enabled: false },
      ],
      queryParams: [{ key: 'dryRun', value: 'true' }],
      body: { type: 'json', content: '{"sku": "{{SKU}}", "qty": {{QTY}}}' },
      auth: { type: 'apiKey', in: 'header', name: 'X-Api-Key', value: '{{API_KEY}}' },
      timeoutMs: 5000,
      expectedStatus: 201,
      tags: ['Orders', 'orders', 'write'],
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      environmentId: environmentIds.Production,
      headers: [
        { key: 'Content-Type', value: 'application/json', enabled: true },
        { key: 'Authorization', value: 'Bearer {{API_TOKEN}}', enabled: false },
      ],
      queryParams: [{ key: 'dryRun', value: 'true', enabled: true }],
      body: { type: 'json', content: '{"sku": "{{SKU}}", "qty": {{QTY}}}' },
      auth: { type: 'apiKey', in: 'header', name: 'X-Api-Key', value: '{{API_KEY}}' },
      timeoutMs: 5000,
      expectedStatus: 201,
      tags: ['orders', 'write'],
    });

    // Reading it back returns the same configuration.
    const read = await request(app).get(`/api/endpoints/${res.body.data.id}`).set(owner.auth);
    expect(read.body.data).toEqual(res.body.data);
  });

  it.each([
    ['a literal bearer token', { auth: { type: 'bearer', token: 'sk_live_123' } }, 'auth.token'],
    [
      'a literal basic-auth password',
      { auth: { type: 'basic', username: 'svc', password: 'hunter2' } },
      'auth.password',
    ],
    [
      'a literal Authorization header',
      { headers: [{ key: 'authorization', value: 'Bearer sk_live_123' }] },
      'headers.0.value',
    ],
    ['a query string in the URL', { url: '/orders?limit=5' }, 'url'],
    ['a URL that is neither a path nor http(s)', { url: 'ftp://files.example.com' }, 'url'],
    ['a body on a GET request', { body: { type: 'json', content: '{}' } }, 'body'],
    ['invalid JSON', { method: 'POST', body: { type: 'json', content: '{"a":' } }, 'body.content'],
    ['a timeout above 30s', { timeoutMs: 60_000 }, 'timeoutMs'],
    ['an impossible status code', { expectedStatus: 700 }, 'expectedStatus'],
    ['an unknown method', { method: 'TRACE' }, 'method'],
  ])('rejects %s', async (_label, body, path) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(path);
    expect(await prisma.endpoint.count()).toBe(0);
  });

  it('rejects duplicate names within a project, ignoring case', async () => {
    await create({});
    const dup = await create({ name: 'LIST ORDERS' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details[0].path).toBe('name');
  });

  it('only accepts an environment from the same project', async () => {
    const other = await request(app)
      .post('/api/projects')
      .set(owner.auth)
      .send({ workspaceId, name: 'Other' });
    const otherEnvs = await request(app)
      .get(`/api/projects/${other.body.data.id}/environments`)
      .set(owner.auth);

    const res = await create({ environmentId: otherEnvs.body.data[0].id });
    expect(res.status).toBe(404);
    expect(res.body.error.details[0].path).toBe('environmentId');
  });

  it(`enforces the limit of ${MAX_ENDPOINTS_PER_PROJECT} endpoints per project`, async () => {
    await prisma.endpoint.createMany({
      data: Array.from({ length: MAX_ENDPOINTS_PER_PROJECT }, (_, i) => ({
        projectId,
        name: `Endpoint ${i}`,
        method: 'GET' as const,
        url: `/e/${i}`,
      })),
    });
    const res = await create({ name: 'One too many' });
    expect(res.status).toBe(409);
  });
});

describe('listing endpoints', () => {
  beforeEach(async () => {
    await create({ name: 'List orders', url: '/orders', tags: ['orders'] });
    await create({
      name: 'Create order',
      method: 'POST',
      url: '/orders',
      tags: ['orders', 'write'],
    });
    await create({ name: 'health check', url: '/health' });
  });

  const list = (query: object = {}) =>
    request(app)
      .get('/api/endpoints')
      .query({ projectId, ...query })
      .set(owner.auth);

  it('lists by name', async () => {
    const res = await list();
    expect(res.body.data.map((e: { name: string }) => e.name)).toEqual([
      'Create order',
      'health check',
      'List orders',
    ]);
  });

  it('filters by method, tag and search text (name or URL)', async () => {
    const names = async (query: object) =>
      (await list(query)).body.data.map((e: { name: string }) => e.name);

    expect(await names({ method: 'POST' })).toEqual(['Create order']);
    expect(await names({ tag: 'orders' })).toEqual(['Create order', 'List orders']);
    expect(await names({ search: 'HEALTH' })).toEqual(['health check']);
    expect(await names({ search: '/orders', method: 'GET' })).toEqual(['List orders']);
  });

  it('requires a project id', async () => {
    const res = await request(app).get('/api/endpoints').set(owner.auth);
    expect(res.status).toBe(400);
  });
});

describe('updating endpoints', () => {
  let id: string;
  beforeEach(async () => {
    id = (await create({ environmentId: environmentIds.Staging })).body.data.id;
  });

  const patch = (body: object, user = owner) =>
    request(app).patch(`/api/endpoints/${id}`).set(user.auth).send(body);

  it('changes only the fields sent', async () => {
    const res = await patch({ url: '/v2/orders', tags: ['v2'] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'List orders',
      method: 'GET',
      url: '/v2/orders',
      environmentId: environmentIds.Staging,
      tags: ['v2'],
    });
  });

  it('validates the merged result, so cross-field rules hold across requests', async () => {
    // Adding a body to the existing GET is refused...
    expect((await patch({ body: { type: 'text', content: 'hi' } })).status).toBe(400);
    // ...but switching method and body together is fine...
    expect((await patch({ method: 'POST', body: { type: 'text', content: 'hi' } })).status).toBe(
      200,
    );
    // ...and switching back to GET while the body remains is refused.
    const back = await patch({ method: 'GET' });
    expect(back.status).toBe(400);
    expect(back.body.error.details[0].path).toBe('body');
  });

  it('clears the default environment when that environment is deleted', async () => {
    await request(app)
      .delete(`/api/projects/${projectId}/environments/${environmentIds.Staging}`)
      .set(owner.auth);
    const res = await request(app).get(`/api/endpoints/${id}`).set(owner.auth);
    expect(res.body.data.environmentId).toBeNull();
  });

  it('deletes an endpoint, and project deletion removes its endpoints', async () => {
    expect((await request(app).delete(`/api/endpoints/${id}`).set(owner.auth)).status).toBe(204);
    await create({ name: 'Another' });
    await request(app).delete(`/api/projects/${projectId}`).set(owner.auth);
    expect(await prisma.endpoint.count()).toBe(0);
  });
});

describe('endpoint authorization', () => {
  it('lets members manage endpoints and viewers only read them', async () => {
    const member = await userWithRole('Mia Member', 'MEMBER');
    const viewer = await userWithRole('Vic Viewer', 'VIEWER');

    const created = await create({ name: 'Member endpoint' }, member);
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    expect((await request(app).get(`/api/endpoints/${id}`).set(viewer.auth)).status).toBe(200);
    expect((await create({ name: 'Viewer endpoint' }, viewer)).status).toBe(403);
    expect(
      (await request(app).patch(`/api/endpoints/${id}`).set(viewer.auth).send({ url: '/x' }))
        .status,
    ).toBe(403);
    expect((await request(app).delete(`/api/endpoints/${id}`).set(viewer.auth)).status).toBe(403);
  });

  it('hides endpoints from outsiders as not found', async () => {
    const id = (await create({})).body.data.id;
    const outsider = await createTestUser(app, 'Eve Outsider');

    const get = await request(app).get(`/api/endpoints/${id}`).set(outsider.auth);
    expect(get.status).toBe(404);
    expect(get.body.error.message).toBe('Endpoint not found');
    expect(
      (await request(app).get('/api/endpoints').query({ projectId }).set(outsider.auth)).status,
    ).toBe(404);
    expect((await create({ name: 'Intruder' }, outsider)).status).toBe(404);
    expect((await request(app).get('/api/endpoints/not-a-uuid').set(owner.auth)).status).toBe(404);
  });
});
