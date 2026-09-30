import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Emitter } from '@socket.io/redis-emitter';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import {
  REALTIME_PATH,
  realtimeRedisKey,
  workspaceRoom,
  type IncidentRealtimePayload,
  type SubscribeAck,
} from '@tracelayer/shared';

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
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { setRealtimeServer, type RealtimeServer } from '../src/lib/realtime';
import { createRealtimeServer, type RealtimeServerOptions } from '../src/sockets/realtime-server';
import { createTestUser, resetDatabase, type TestUser } from './helpers';

let app: ReturnType<typeof createApp>;
let httpServer: HttpServer;
let io: RealtimeServer;
let url: string;
const sockets: Socket[] = [];

async function startServer(options: RealtimeServerOptions = {}) {
  app = createApp();
  httpServer = createServer(app);
  io = createRealtimeServer(httpServer, options);
  setRealtimeServer(io);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
}

async function stopServer() {
  for (const s of sockets.splice(0)) s.disconnect();
  setRealtimeServer(null);
  await new Promise<void>((resolve) => void io.close(() => resolve()));
}

function client(token: string | undefined): Socket {
  const socket = connect(url, {
    path: REALTIME_PATH,
    auth: token === undefined ? {} : { token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  return socket;
}

async function connected(token: string): Promise<Socket> {
  const socket = client(token);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

const subscribe = (socket: Socket, workspaceId: string) =>
  socket.timeout(5000).emitWithAck('subscribe', workspaceId) as Promise<SubscribeAck>;

function next<T>(socket: Socket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no ${event} within ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Resolves true if the event arrives within the window, false otherwise. */
function arrives(socket: Socket, event: string, windowMs = 400): Promise<boolean> {
  return next(socket, event, windowMs).then(
    () => true,
    () => false,
  );
}

let owner: TestUser;
let workspaceId: string;

async function seed() {
  await resetDatabase();
  owner = await createTestUser(app, 'Olivia Owner');
  workspaceId = (await request(app).post('/api/workspaces').set(owner.auth).send({ name: 'Acme' }))
    .body.data.id;
}

async function createIncident() {
  const projectId = (
    await request(app).post('/api/projects').set(owner.auth).send({ workspaceId, name: 'Orders' })
  ).body.data.id as string;
  return prisma.incident.create({
    data: { projectId, number: 1, title: 'Orders health: down', severity: 'HIGH' },
  });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Socket.IO server', () => {
  beforeEach(async () => {
    await startServer();
    await seed();
  });
  afterEach(stopServer);

  it('rejects connections without a valid access token', async () => {
    for (const token of [undefined, 'not-a-token']) {
      const socket = client(token);
      const err = await new Promise<Error>((resolve) => socket.once('connect_error', resolve));
      expect(err.message).toBe('UNAUTHENTICATED');
    }
  });

  it('subscribes members to their workspace only', async () => {
    const socket = await connected(owner.token);
    expect(await subscribe(socket, workspaceId)).toEqual({ ok: true });

    const stranger = await createTestUser(app, 'Sam Stranger');
    const theirs = (
      await request(app).post('/api/workspaces').set(stranger.auth).send({ name: 'Theirs' })
    ).body.data.id;
    expect(await subscribe(socket, theirs)).toEqual({ ok: false, error: 'Workspace not found' });
    expect(await subscribe(socket, 'not-a-uuid')).toEqual({
      ok: false,
      error: 'Workspace not found',
    });
  });

  it('delivers incident changes made through the API to subscribers of that workspace', async () => {
    const incident = await createIncident();
    const socket = await connected(owner.token);
    await subscribe(socket, workspaceId);

    const stranger = await createTestUser(app, 'Sam Stranger');
    const theirs = (
      await request(app).post('/api/workspaces').set(stranger.auth).send({ name: 'Theirs' })
    ).body.data.id;
    const other = await connected(stranger.token);
    await subscribe(other, theirs);
    const leaked = arrives(other, 'incident.updated', 1500);

    const received = next<IncidentRealtimePayload>(socket, 'incident.updated');
    await request(app)
      .patch(`/api/incidents/${incident.id}`)
      .set(owner.auth)
      .send({ status: 'ACKNOWLEDGED' })
      .expect(200);
    expect(await received).toEqual({
      workspaceId,
      projectId: incident.projectId,
      incident: {
        id: incident.id,
        number: 1,
        title: 'Orders health: down',
        severity: 'HIGH',
        status: 'ACKNOWLEDGED',
      },
      change: 'status',
      actor: { id: owner.id, name: 'Olivia Owner' },
    });

    const comment = next<IncidentRealtimePayload>(socket, 'incident.updated');
    await request(app)
      .post(`/api/incidents/${incident.id}/events`)
      .set(owner.auth)
      .send({ message: 'On it' })
      .expect(201);
    expect((await comment).change).toBe('comment');

    expect(await leaked).toBe(false);
  });

  it('stops delivering to a member as soon as they are removed', async () => {
    const incident = await createIncident();
    const member = await createTestUser(app, 'Mia Member');
    await prisma.workspaceMember.create({
      data: { workspaceId, userId: member.id, role: 'MEMBER' },
    });
    const socket = await connected(member.token);
    await subscribe(socket, workspaceId);

    const before = next(socket, 'incident.updated');
    await request(app)
      .patch(`/api/incidents/${incident.id}`)
      .set(owner.auth)
      .send({ severity: 'LOW' });
    await before;

    await request(app)
      .delete(`/api/workspaces/${workspaceId}/members/${member.id}`)
      .set(owner.auth)
      .expect(204);
    const after = arrives(socket, 'incident.updated', 1500);
    await request(app)
      .patch(`/api/incidents/${incident.id}`)
      .set(owner.auth)
      .send({ severity: 'HIGH' });
    expect(await after).toBe(false);
    // And they cannot subscribe again.
    expect(await subscribe(socket, workspaceId)).toMatchObject({ ok: false });
  });

  it('disconnects a socket when its access token expires', async () => {
    const shortLived = jwt.sign({}, env.JWT_SECRET, {
      subject: owner.id,
      issuer: 'tracelayer',
      audience: 'tracelayer-api',
      expiresIn: 2,
    });
    const socket = await connected(shortLived);
    const reason = await next<string>(socket, 'disconnect', 5000);
    expect(reason).toBe('io server disconnect');
  });
});

describe('events from the worker through Redis', () => {
  const pub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const workerRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });

  beforeEach(async () => {
    await startServer({ redis: { pub, sub } });
    await seed();
  });
  afterEach(stopServer);
  afterAll(async () => {
    await Promise.all([pub.quit(), sub.quit(), workerRedis.quit()]);
  });

  it('reaches subscribed browsers without any connection from the worker to the API', async () => {
    const socket = await connected(owner.token);
    await subscribe(socket, workspaceId);

    // Exactly what the worker's publisher does.
    const emitter = new Emitter(workerRedis, { key: realtimeRedisKey(env.QUEUE_PREFIX) });
    const received = next<{ monitor: { name: string } }>(socket, 'monitor.failed');
    emitter.to(workspaceRoom(workspaceId)).emit('monitor.failed', {
      workspaceId,
      monitor: { id: 'm', name: 'Orders health' },
    });
    expect((await received).monitor.name).toBe('Orders health');
  });
});
