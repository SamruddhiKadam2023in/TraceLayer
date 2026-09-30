import request from 'supertest';
import { MAX_PROJECTS_PER_WORKSPACE, type WorkspaceRole } from '@tracelayer/shared';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { decryptSecret } from '../src/utils/secret-box';
import { createTestUser, resetDatabase, type TestUser } from './helpers';

let app: ReturnType<typeof createApp>;
let owner: TestUser;
let workspaceId: string;

beforeEach(async () => {
  await resetDatabase();
  app = createApp();
  owner = await createTestUser(app, 'Olivia Owner');
  const ws = await request(app).post('/api/workspaces').set(owner.auth).send({ name: 'Acme' });
  workspaceId = ws.body.data.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function userWithRole(name: string, role: WorkspaceRole): Promise<TestUser> {
  const user = await createTestUser(app, name);
  await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role } });
  return user;
}

async function createProject(name = 'Payments API', user = owner): Promise<string> {
  const res = await request(app)
    .post('/api/projects')
    .set(user.auth)
    .send({ workspaceId, name, description: 'Card processing' });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function environments(projectId: string, user = owner) {
  const res = await request(app).get(`/api/projects/${projectId}/environments`).set(user.auth);
  expect(res.status).toBe(200);
  return res.body.data as { id: string; name: string; variables: unknown[] }[];
}

describe('projects', () => {
  // Regression (found by the Phase 15 E2E test): the web form sends null for an empty
  // description, which the API used to reject, so no project could be created from the UI
  // without one.
  it('accepts null as "no description", on create and on update', async () => {
    const created = await request(app)
      .post('/api/projects')
      .set(owner.auth)
      .send({ workspaceId, name: 'No description', description: null });
    expect(created.status).toBe(201);
    expect(created.body.data.description).toBeNull();

    const described = await request(app)
      .patch(`/api/projects/${created.body.data.id}`)
      .set(owner.auth)
      .send({ description: 'Now with one' });
    expect(described.body.data.description).toBe('Now with one');
    const cleared = await request(app)
      .patch(`/api/projects/${created.body.data.id}`)
      .set(owner.auth)
      .send({ description: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.description).toBeNull();
  });

  it('creates a project with the default environments', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set(owner.auth)
      .send({ workspaceId, name: '  Payments API ', description: '  ' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      workspaceId,
      name: 'Payments API',
      description: null,
      createdBy: { id: owner.id, name: 'Olivia Owner' },
      environmentCount: 3,
    });
    const envs = await environments(res.body.data.id);
    expect(envs.map((e) => e.name)).toEqual(['Development', 'Staging', 'Production']);
  });

  it('lists a workspace’s projects by name and requires a valid workspace id', async () => {
    await createProject('Zeta');
    await createProject('alpha');
    const res = await request(app).get('/api/projects').query({ workspaceId }).set(owner.auth);
    expect(res.body.data.map((p: { name: string }) => p.name)).toEqual(['alpha', 'Zeta']);

    const missing = await request(app).get('/api/projects').set(owner.auth);
    expect(missing.status).toBe(400);
    expect(missing.body.error.details[0].path).toBe('workspaceId');
  });

  it('rejects duplicate names within a workspace, ignoring case', async () => {
    await createProject('Payments API');
    const dup = await request(app)
      .post('/api/projects')
      .set(owner.auth)
      .send({ workspaceId, name: 'PAYMENTS api' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details[0].path).toBe('name');

    // The same name is fine in another workspace.
    const other = await request(app).post('/api/workspaces').set(owner.auth).send({ name: 'B' });
    const ok = await request(app)
      .post('/api/projects')
      .set(owner.auth)
      .send({ workspaceId: other.body.data.id, name: 'Payments API' });
    expect(ok.status).toBe(201);
  });

  it('updates name and description, and checks name clashes on rename', async () => {
    const id = await createProject('One');
    await createProject('Two');

    const renamed = await request(app)
      .patch(`/api/projects/${id}`)
      .set(owner.auth)
      .send({ name: 'Uno', description: 'First' });
    expect(renamed.body.data).toMatchObject({ name: 'Uno', description: 'First' });

    // Renaming to its own name in another case is allowed; to another project's name is not.
    expect(
      (await request(app).patch(`/api/projects/${id}`).set(owner.auth).send({ name: 'UNO' }))
        .status,
    ).toBe(200);
    expect(
      (await request(app).patch(`/api/projects/${id}`).set(owner.auth).send({ name: 'two' }))
        .status,
    ).toBe(409);
    expect((await request(app).patch(`/api/projects/${id}`).set(owner.auth).send({})).status).toBe(
      400,
    );
  });

  it('deletes a project with its environments and variables', async () => {
    const id = await createProject();
    const [env] = await environments(id);
    await request(app)
      .post(`/api/projects/${id}/environments/${env!.id}/variables`)
      .set(owner.auth)
      .send({ key: 'API_KEY', value: 'x', isSecret: true });

    expect((await request(app).delete(`/api/projects/${id}`).set(owner.auth)).status).toBe(204);
    expect(await prisma.environment.count()).toBe(0);
    expect(await prisma.environmentVariable.count()).toBe(0);
  });

  it(`enforces the limit of ${MAX_PROJECTS_PER_WORKSPACE} projects per workspace`, async () => {
    await prisma.project.createMany({
      data: Array.from({ length: MAX_PROJECTS_PER_WORKSPACE }, (_, i) => ({
        workspaceId,
        name: `Project ${i}`,
      })),
    });
    const res = await request(app)
      .post('/api/projects')
      .set(owner.auth)
      .send({ workspaceId, name: 'One too many' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/at most 50 projects/);
  });
});

describe('project authorization', () => {
  it('lets every role read, but only owners and admins manage', async () => {
    const id = await createProject();
    const admin = await userWithRole('Adam Admin', 'ADMIN');
    const member = await userWithRole('Mia Member', 'MEMBER');
    const viewer = await userWithRole('Vic Viewer', 'VIEWER');

    for (const user of [admin, member, viewer]) {
      expect((await request(app).get(`/api/projects/${id}`).set(user.auth)).status).toBe(200);
      expect(
        (await request(app).get('/api/projects').query({ workspaceId }).set(user.auth)).status,
      ).toBe(200);
    }
    for (const user of [member, viewer]) {
      const create = await request(app)
        .post('/api/projects')
        .set(user.auth)
        .send({ workspaceId, name: 'Nope' });
      expect(create.status).toBe(403);
      expect(
        (await request(app).patch(`/api/projects/${id}`).set(user.auth).send({ name: 'x' })).status,
      ).toBe(403);
      expect((await request(app).delete(`/api/projects/${id}`).set(user.auth)).status).toBe(403);
      expect(
        (
          await request(app)
            .post(`/api/projects/${id}/environments`)
            .set(user.auth)
            .send({ name: 'QA' })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await request(app)
          .patch(`/api/projects/${id}`)
          .set(admin.auth)
          .send({ name: 'Admin renamed' })
      ).status,
    ).toBe(200);
  });

  it('hides projects from outsiders as not found', async () => {
    const id = await createProject();
    const outsider = await createTestUser(app, 'Eve Outsider');

    const get = await request(app).get(`/api/projects/${id}`).set(outsider.auth);
    expect(get.status).toBe(404);
    expect(get.body.error.message).toBe('Project not found');
    expect(
      (await request(app).get(`/api/projects/${id}/environments`).set(outsider.auth)).status,
    ).toBe(404);
    expect(
      (await request(app).get('/api/projects').query({ workspaceId }).set(outsider.auth)).status,
    ).toBe(404);
    expect(
      (await request(app).post('/api/projects').set(outsider.auth).send({ workspaceId, name: 'x' }))
        .status,
    ).toBe(404);
    expect((await request(app).get('/api/projects/not-a-uuid').set(owner.auth)).status).toBe(404);
  });

  it('does not let an environment id from another project be used through this one', async () => {
    const mine = await createProject('Mine');
    const other = await createProject('Other');
    const [otherEnv] = await environments(other);

    const res = await request(app)
      .patch(`/api/projects/${mine}/environments/${otherEnv!.id}`)
      .set(owner.auth)
      .send({ name: 'Hijacked' });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Environment not found');
  });
});

describe('environments', () => {
  let projectId: string;
  beforeEach(async () => {
    projectId = await createProject();
  });

  it('creates, renames and sets a normalised base URL', async () => {
    const created = await request(app)
      .post(`/api/projects/${projectId}/environments`)
      .set(owner.auth)
      .send({ name: 'QA', baseUrl: 'HTTPS://QA.Example.com/v1/' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: 'QA', baseUrl: 'https://qa.example.com/v1' });
    expect((await environments(projectId)).map((e) => e.name)).toEqual([
      'Development',
      'Staging',
      'Production',
      'QA',
    ]);

    const cleared = await request(app)
      .patch(`/api/projects/${projectId}/environments/${created.body.data.id}`)
      .set(owner.auth)
      .send({ baseUrl: '' });
    expect(cleared.body.data.baseUrl).toBeNull();
  });

  it.each([
    ['ftp://example.com', 'Only http and https URLs are supported'],
    ['https://user:pass@example.com', 'Do not put credentials in the URL'],
    ['example.com', 'Enter a full URL'],
  ])('rejects the base URL %s', async (baseUrl, message) => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/environments`)
      .set(owner.auth)
      .send({ name: 'QA', baseUrl });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0]).toMatchObject({ path: 'baseUrl' });
    expect(res.body.error.details[0].message).toContain(message);
  });

  it('rejects duplicate environment names, ignoring case', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/environments`)
      .set(owner.auth)
      .send({ name: 'production' });
    expect(res.status).toBe(409);
  });

  it('keeps at least one environment', async () => {
    const envs = await environments(projectId);
    const del = (id: string) =>
      request(app).delete(`/api/projects/${projectId}/environments/${id}`).set(owner.auth);

    expect((await del(envs[0]!.id)).status).toBe(204);
    expect((await del(envs[1]!.id)).status).toBe(204);
    const last = await del(envs[2]!.id);
    expect(last.status).toBe(409);
    expect(last.body.error.message).toBe('A project must keep at least one environment');
  });
});

describe('environment variables', () => {
  let projectId: string;
  let base: string;
  beforeEach(async () => {
    projectId = await createProject();
    const [env] = await environments(projectId);
    base = `/api/projects/${projectId}/environments/${env!.id}/variables`;
  });

  const add = (body: object) => request(app).post(base).set(owner.auth).send(body);

  it('stores plain values readably and secrets encrypted, never returning a secret', async () => {
    const plain = await add({ key: 'CLIENT_ID', value: 'web-app' });
    const secret = await add({ key: 'API_KEY', value: 'sk_live_abc123', isSecret: true });

    expect(plain.body.data).toMatchObject({ key: 'CLIENT_ID', value: 'web-app', isSecret: false });
    expect(secret.body.data).toMatchObject({ key: 'API_KEY', value: null, isSecret: true });

    const row = await prisma.environmentVariable.findFirstOrThrow({ where: { key: 'API_KEY' } });
    expect(row.value).toBeNull();
    expect(row.encryptedValue).not.toContain('sk_live_abc123');
    expect(decryptSecret(row.encryptedValue!)).toBe('sk_live_abc123');

    // No endpoint anywhere returns the secret.
    for (const path of [`/api/projects/${projectId}/environments`, `/api/projects/${projectId}`]) {
      const res = await request(app).get(path).set(owner.auth);
      expect(JSON.stringify(res.body)).not.toContain('sk_live_abc123');
      expect(JSON.stringify(res.body)).not.toContain(row.encryptedValue!);
    }
  });

  it('validates keys and rejects duplicates', async () => {
    expect((await add({ key: '1BAD', value: 'x' })).status).toBe(400);
    expect((await add({ key: 'HAS SPACE', value: 'x' })).status).toBe(400);
    await add({ key: 'TOKEN', value: 'x' });
    const dup = await add({ key: 'TOKEN', value: 'y' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details[0].path).toBe('key');
  });

  it('keeps a secret when updated without a value, and replaces it when given one', async () => {
    const { body } = await add({ key: 'API_KEY', value: 'first', isSecret: true });
    const id = body.data.id;

    await request(app).patch(`${base}/${id}`).set(owner.auth).send({ key: 'SERVICE_KEY' });
    let row = await prisma.environmentVariable.findUniqueOrThrow({ where: { id } });
    expect(row.key).toBe('SERVICE_KEY');
    expect(decryptSecret(row.encryptedValue!)).toBe('first');

    await request(app).patch(`${base}/${id}`).set(owner.auth).send({ value: 'second' });
    row = await prisma.environmentVariable.findUniqueOrThrow({ where: { id } });
    expect(decryptSecret(row.encryptedValue!)).toBe('second');
  });

  it('encrypts a plain variable made secret, but needs a new value to un-secret', async () => {
    const { body } = await add({ key: 'TOKEN', value: 'visible' });
    const id = body.data.id;

    const toSecret = await request(app)
      .patch(`${base}/${id}`)
      .set(owner.auth)
      .send({ isSecret: true });
    expect(toSecret.body.data).toMatchObject({ isSecret: true, value: null });
    const row = await prisma.environmentVariable.findUniqueOrThrow({ where: { id } });
    expect(row.value).toBeNull();
    expect(decryptSecret(row.encryptedValue!)).toBe('visible');

    const reveal = await request(app)
      .patch(`${base}/${id}`)
      .set(owner.auth)
      .send({ isSecret: false });
    expect(reveal.status).toBe(400);
    expect(reveal.body.error.details[0].path).toBe('value');

    const replaced = await request(app)
      .patch(`${base}/${id}`)
      .set(owner.auth)
      .send({ isSecret: false, value: 'new-plain' });
    expect(replaced.body.data).toMatchObject({ isSecret: false, value: 'new-plain' });
  });

  it('is enforced by the database: a secret can never be stored in plaintext', async () => {
    const [env] = await environments(projectId);
    await expect(
      prisma.environmentVariable.create({
        data: { environmentId: env!.id, key: 'LEAK', isSecret: true, value: 'plaintext' },
      }),
    ).rejects.toThrow(/environment_variables_value_matches_secret_flag/);
  });

  it('deletes a variable, and 404s for one in another environment', async () => {
    const { body } = await add({ key: 'TOKEN', value: 'x' });
    const envs = await environments(projectId);
    const otherBase = `/api/projects/${projectId}/environments/${envs[1]!.id}/variables`;

    expect((await request(app).delete(`${otherBase}/${body.data.id}`).set(owner.auth)).status).toBe(
      404,
    );
    expect((await request(app).delete(`${base}/${body.data.id}`).set(owner.auth)).status).toBe(204);
    expect(await prisma.environmentVariable.count()).toBe(0);
  });
});
