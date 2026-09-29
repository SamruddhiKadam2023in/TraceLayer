import request from 'supertest';
import type { WorkspaceRole } from '@tracelayer/shared';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { createTestUser, resetDatabase, type TestUser } from './helpers';

let app: ReturnType<typeof createApp>;
let owner: TestUser;

beforeEach(async () => {
  await resetDatabase();
  app = createApp();
  owner = await createTestUser(app, 'Olivia Owner');
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createWorkspace(user: TestUser, name = 'Acme'): Promise<string> {
  const res = await request(app).post('/api/workspaces').set(user.auth).send({ name });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function addMember(workspaceId: string, user: TestUser, role: WorkspaceRole) {
  await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role } });
}

/** A workspace owned by `owner` with one user per other role. */
async function workspaceWithRoles() {
  const workspaceId = await createWorkspace(owner);
  const admin = await createTestUser(app, 'Adam Admin');
  const member = await createTestUser(app, 'Mia Member');
  const viewer = await createTestUser(app, 'Vic Viewer');
  await addMember(workspaceId, admin, 'ADMIN');
  await addMember(workspaceId, member, 'MEMBER');
  await addMember(workspaceId, viewer, 'VIEWER');
  return { workspaceId, admin, member, viewer };
}

describe('workspace CRUD', () => {
  it('creates a workspace with the creator as owner', async () => {
    const res = await request(app)
      .post('/api/workspaces')
      .set(owner.auth)
      .send({ name: '  Acme Inc  ' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Acme Inc', role: 'OWNER', memberCount: 1 });
    const membership = await prisma.workspaceMember.findFirstOrThrow();
    expect(membership).toMatchObject({ userId: owner.id, role: 'OWNER' });
  });

  it('validates the name', async () => {
    const res = await request(app).post('/api/workspaces').set(owner.auth).send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([
      { path: 'name', message: 'Workspace name is required' },
    ]);
  });

  it('lists only the workspaces the user belongs to, with their role', async () => {
    const other = await createTestUser(app, 'Oscar Other');
    await createWorkspace(owner, 'Zeta');
    const shared = await createWorkspace(other, 'Alpha');
    await createWorkspace(other, 'Not mine');
    await addMember(shared, owner, 'VIEWER');

    const res = await request(app).get('/api/workspaces').set(owner.auth);

    expect(res.status).toBe(200);
    expect(res.body.data.map((w: { name: string; role: string }) => [w.name, w.role])).toEqual([
      ['Alpha', 'VIEWER'],
      ['Zeta', 'OWNER'],
    ]);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/workspaces')).status).toBe(401);
    expect((await request(app).post('/api/workspaces').send({ name: 'x' })).status).toBe(401);
  });

  it('renames and deletes a workspace', async () => {
    const id = await createWorkspace(owner);

    const renamed = await request(app)
      .patch(`/api/workspaces/${id}`)
      .set(owner.auth)
      .send({ name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.name).toBe('Renamed');

    expect((await request(app).delete(`/api/workspaces/${id}`).set(owner.auth)).status).toBe(204);
    expect(await prisma.workspace.count()).toBe(0);
    expect(await prisma.workspaceMember.count()).toBe(0);
  });
});

describe('authorization', () => {
  it('hides workspaces from non-members with 404, including malformed ids', async () => {
    const id = await createWorkspace(owner);
    const outsider = await createTestUser(app, 'Eve Outsider');

    for (const path of [`/api/workspaces/${id}`, `/api/workspaces/${id}/members`]) {
      const res = await request(app).get(path).set(outsider.auth);
      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe('Workspace not found');
    }
    expect(
      (await request(app).patch(`/api/workspaces/${id}`).set(outsider.auth).send({ name: 'x' }))
        .status,
    ).toBe(404);
    expect((await request(app).delete(`/api/workspaces/${id}`).set(outsider.auth)).status).toBe(
      404,
    );
    expect((await request(app).get('/api/workspaces/not-a-uuid').set(owner.auth)).status).toBe(404);
  });

  it('lets every role read the workspace and its members', async () => {
    const { workspaceId, admin, member, viewer } = await workspaceWithRoles();
    for (const user of [owner, admin, member, viewer]) {
      expect((await request(app).get(`/api/workspaces/${workspaceId}`).set(user.auth)).status).toBe(
        200,
      );
      const members = await request(app)
        .get(`/api/workspaces/${workspaceId}/members`)
        .set(user.auth);
      expect(members.body.data.map((m: { role: string }) => m.role)).toEqual([
        'OWNER',
        'ADMIN',
        'MEMBER',
        'VIEWER',
      ]);
    }
  });

  it.each(['admin', 'member', 'viewer'] as const)(
    'forbids a %s from renaming or deleting the workspace',
    async (who) => {
      const ctx = await workspaceWithRoles();
      const user = ctx[who];
      const rename = await request(app)
        .patch(`/api/workspaces/${ctx.workspaceId}`)
        .set(user.auth)
        .send({ name: 'Hijacked' });
      expect(rename.status).toBe(403);
      expect(rename.body.error.code).toBe('FORBIDDEN');
      expect(
        (await request(app).delete(`/api/workspaces/${ctx.workspaceId}`).set(user.auth)).status,
      ).toBe(403);
      expect(await prisma.workspace.count()).toBe(1);
    },
  );
});

describe('members', () => {
  it('adds an existing user by email', async () => {
    const id = await createWorkspace(owner);
    const bob = await createTestUser(app, 'Bob Builder');

    const res = await request(app)
      .post(`/api/workspaces/${id}/members`)
      .set(owner.auth)
      .send({ email: 'BOB.builder@example.com', role: 'MEMBER' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ userId: bob.id, role: 'MEMBER', name: 'Bob Builder' });
    const list = await request(app).get('/api/workspaces').set(bob.auth);
    expect(list.body.data).toHaveLength(1);
  });

  it('reports unknown emails and existing members on the email field', async () => {
    const id = await createWorkspace(owner);
    const bob = await createTestUser(app, 'Bob Builder');
    await addMember(id, bob, 'VIEWER');

    const unknown = await request(app)
      .post(`/api/workspaces/${id}/members`)
      .set(owner.auth)
      .send({ email: 'nobody@example.com', role: 'MEMBER' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.details[0].path).toBe('email');

    const duplicate = await request(app)
      .post(`/api/workspaces/${id}/members`)
      .set(owner.auth)
      .send({ email: bob.email, role: 'MEMBER' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.details[0].path).toBe('email');
  });

  it('lets admins manage non-owners but not create, change or remove owners', async () => {
    const { workspaceId, admin, member } = await workspaceWithRoles();
    const newcomer = await createTestUser(app, 'Nina New');
    const base = `/api/workspaces/${workspaceId}/members`;

    const addOwner = await request(app)
      .post(base)
      .set(admin.auth)
      .send({ email: newcomer.email, role: 'OWNER' });
    expect(addOwner.status).toBe(403);
    const addAdmin = await request(app)
      .post(base)
      .set(admin.auth)
      .send({ email: newcomer.email, role: 'ADMIN' });
    expect(addAdmin.status).toBe(201);

    expect(
      (await request(app).patch(`${base}/${member.id}`).set(admin.auth).send({ role: 'VIEWER' }))
        .status,
    ).toBe(200);
    expect(
      (await request(app).patch(`${base}/${member.id}`).set(admin.auth).send({ role: 'OWNER' }))
        .status,
    ).toBe(403);
    expect(
      (await request(app).patch(`${base}/${owner.id}`).set(admin.auth).send({ role: 'VIEWER' }))
        .status,
    ).toBe(403);
    expect((await request(app).delete(`${base}/${owner.id}`).set(admin.auth)).status).toBe(403);
    expect((await request(app).delete(`${base}/${member.id}`).set(admin.auth)).status).toBe(204);
  });

  it.each(['member', 'viewer'] as const)('forbids a %s from managing members', async (who) => {
    const ctx = await workspaceWithRoles();
    const user = ctx[who];
    const newcomer = await createTestUser(app, 'Nina New');
    const base = `/api/workspaces/${ctx.workspaceId}/members`;

    expect(
      (await request(app).post(base).set(user.auth).send({ email: newcomer.email, role: 'VIEWER' }))
        .status,
    ).toBe(403);
    expect(
      (await request(app).patch(`${base}/${ctx.admin.id}`).set(user.auth).send({ role: 'VIEWER' }))
        .status,
    ).toBe(403);
    expect((await request(app).delete(`${base}/${ctx.admin.id}`).set(user.auth)).status).toBe(403);
  });

  it('lets an owner promote another owner, after which either can step down', async () => {
    const { workspaceId, admin } = await workspaceWithRoles();
    const base = `/api/workspaces/${workspaceId}/members`;

    expect(
      (await request(app).patch(`${base}/${admin.id}`).set(owner.auth).send({ role: 'OWNER' }))
        .status,
    ).toBe(200);
    expect(
      (await request(app).patch(`${base}/${owner.id}`).set(owner.auth).send({ role: 'MEMBER' }))
        .status,
    ).toBe(200);
    const members = await request(app).get(base).set(admin.auth);
    expect(members.body.data.filter((m: { role: string }) => m.role === 'OWNER')).toHaveLength(1);
  });

  it('never lets the last owner be demoted, removed or leave', async () => {
    const { workspaceId, admin } = await workspaceWithRoles();
    const base = `/api/workspaces/${workspaceId}/members`;

    const demote = await request(app)
      .patch(`${base}/${owner.id}`)
      .set(owner.auth)
      .send({ role: 'ADMIN' });
    expect(demote.status).toBe(409);
    expect(demote.body.error.message).toMatch(/at least one owner/);

    const leave = await request(app).delete(`${base}/${owner.id}`).set(owner.auth);
    expect(leave.status).toBe(409);
    expect(leave.body.error.message).toMatch(/only owner/);

    expect((await request(app).delete(`${base}/${owner.id}`).set(admin.auth)).status).toBe(403);
    expect(await prisma.workspaceMember.count({ where: { role: 'OWNER' } })).toBe(1);
  });

  it('keeps an owner when two owners demote each other at the same moment', async () => {
    const { workspaceId, admin } = await workspaceWithRoles();
    await prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: admin.id } },
      data: { role: 'OWNER' },
    });
    const base = `/api/workspaces/${workspaceId}/members`;

    // Force the race: hold the member rows locked so both demotions start and queue up
    // together, then let them go. Without the service's own row lock, both would read
    // "two owners", both would succeed, and the workspace would be left with none.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => (locked = resolve));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM workspace_members WHERE workspace_id = ${workspaceId}::uuid FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 15_000 },
    );
    await lockAcquired;

    const pending = Promise.all([
      request(app).patch(`${base}/${admin.id}`).set(owner.auth).send({ role: 'MEMBER' }),
      request(app).patch(`${base}/${owner.id}`).set(admin.auth).send({ role: 'MEMBER' }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await holder;
    const results = await pending;

    expect(await prisma.workspaceMember.count({ where: { workspaceId, role: 'OWNER' } })).toBe(1);
    // Exactly one wins. The loser re-reads the locked rows, finds it is now only a member, and
    // is refused for lack of permission rather than acting on its stale owner role.
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
  });

  it('lets any member leave', async () => {
    const { workspaceId, viewer } = await workspaceWithRoles();
    const res = await request(app)
      .delete(`/api/workspaces/${workspaceId}/members/${viewer.id}`)
      .set(viewer.auth);
    expect(res.status).toBe(204);
    expect((await request(app).get(`/api/workspaces/${workspaceId}`).set(viewer.auth)).status).toBe(
      404,
    );
  });

  it('returns 404 for a member that is not in the workspace', async () => {
    const id = await createWorkspace(owner);
    const stranger = await createTestUser(app, 'Sam Stranger');
    const res = await request(app)
      .delete(`/api/workspaces/${id}/members/${stranger.id}`)
      .set(owner.auth);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Member not found');
  });
});
