import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPrismaClient, type MonitorType } from '@tracelayer/db';
import { closeConnectionPools, createSecretBox } from '@tracelayer/executor';
import { runMonitorCheck, type CheckDependencies } from '../src/checks/run-check';

const prisma = createPrismaClient();
const secrets = createSecretBox(process.env.ENCRYPTION_KEY!);
// Test targets run on 127.0.0.1; SSRF blocking has its own tests in the executor package.
const deps: CheckDependencies = { prisma, secrets, allowPrivateNetwork: true };

// A small upstream API with controllable behaviour.
let received: { url?: string; authorization?: string }[] = [];
let upstream: Server;
let origin: string;
beforeAll(async () => {
  upstream = createServer((req, res) => {
    received.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url === '/slow') {
      setTimeout(() => res.end('{}'), 1500);
      return;
    }
    if (req.url === '/broken') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"status":"down"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"healthy","items":[1,2]}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  await prisma.$disconnect();
  await closeConnectionPools();
});

let ids: { projectId: string; environmentId: string; endpointId: string };
beforeEach(async () => {
  received = [];
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE users, workspaces, projects, environments, environment_variables, endpoints, monitors, monitor_runs CASCADE',
  );
  const workspace = await prisma.workspace.create({ data: { name: 'Acme' } });
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Orders API' },
  });
  const environment = await prisma.environment.create({
    data: {
      projectId: project.id,
      name: 'Production',
      baseUrl: origin,
      variables: {
        create: [
          { key: 'API_TOKEN', isSecret: true, encryptedValue: secrets.encrypt('sk_worker_secret') },
          { key: 'PATH_PART', value: 'health' },
        ],
      },
    },
  });
  const endpoint = await prisma.endpoint.create({
    data: {
      projectId: project.id,
      name: 'Health',
      method: 'GET',
      url: '/{{PATH_PART}}',
      auth: { type: 'bearer', token: '{{API_TOKEN}}' },
    },
  });
  ids = { projectId: project.id, environmentId: environment.id, endpointId: endpoint.id };
});

async function monitor(
  overrides: Partial<{
    type: MonitorType;
    url: string;
    enabled: boolean;
    timeoutMs: number;
    expectedStatus: number | null;
    latencyThresholdMs: number | null;
    assertions: object[];
    environmentId: string | null;
  }> = {},
) {
  const { url, ...rest } = overrides;
  if (url) await prisma.endpoint.update({ where: { id: ids.endpointId }, data: { url } });
  return prisma.monitor.create({
    data: {
      projectId: ids.projectId,
      endpointId: ids.endpointId,
      environmentId: ids.environmentId,
      name: `Monitor ${Math.random()}`,
      type: 'STATUS',
      intervalSeconds: 60,
      timeoutMs: 1000,
      ...rest,
    },
  });
}

describe('runMonitorCheck', () => {
  it('executes the real request with variables and secrets, and stores the run', async () => {
    const m = await monitor();
    const outcome = await runMonitorCheck(m.id, deps);

    expect(outcome).toMatchObject({ status: 'completed', success: true });
    // The upstream really was called, with the substituted path and decrypted secret.
    expect(received).toEqual([{ url: '/health', authorization: 'Bearer sk_worker_secret' }]);

    const [run] = await prisma.monitorRun.findMany();
    expect(run).toMatchObject({
      monitorId: m.id,
      projectId: ids.projectId,
      endpointId: ids.endpointId,
      environmentId: ids.environmentId,
      success: true,
      statusCode: 200,
      timedOut: false,
      failureReason: null,
    });
    expect(run?.durationMs).toBeGreaterThanOrEqual(0);
    expect(run?.sizeBytes).toBe(34);

    const updated = await prisma.monitor.findUniqueOrThrow({ where: { id: m.id } });
    expect(updated).toMatchObject({ lastRunSuccess: true, consecutiveFailures: 0 });
    expect(updated.lastRunAt).toEqual(run?.startedAt);
  });

  it('counts consecutive failures and resets them on success', async () => {
    const m = await monitor({ url: '/broken' });
    await runMonitorCheck(m.id, deps);
    await runMonitorCheck(m.id, deps);
    let state = await prisma.monitor.findUniqueOrThrow({ where: { id: m.id } });
    expect(state).toMatchObject({ lastRunSuccess: false, consecutiveFailures: 2 });
    const [latest] = await prisma.monitorRun.findMany({ orderBy: { startedAt: 'desc' } });
    expect(latest).toMatchObject({ statusCode: 503, failureReason: 'UNEXPECTED_STATUS' });

    await prisma.endpoint.update({ where: { id: ids.endpointId }, data: { url: '/health' } });
    await runMonitorCheck(m.id, deps);
    state = await prisma.monitor.findUniqueOrThrow({ where: { id: m.id } });
    expect(state).toMatchObject({ lastRunSuccess: true, consecutiveFailures: 0 });
  });

  it('records timeouts using the monitor’s own timeout', async () => {
    const m = await monitor({ url: '/slow', timeoutMs: 1000 });
    await runMonitorCheck(m.id, deps);
    const [run] = await prisma.monitorRun.findMany();
    expect(run).toMatchObject({
      success: false,
      timedOut: true,
      failureReason: 'TIMEOUT',
      statusCode: null,
    });
  });

  it('applies the monitor type: performance and response validation', async () => {
    const perf = await monitor({ type: 'PERFORMANCE', latencyThresholdMs: 5000 });
    expect(await runMonitorCheck(perf.id, deps)).toMatchObject({ success: true });

    const validation = await monitor({
      type: 'RESPONSE_VALIDATION',
      assertions: [{ path: 'status', operator: 'equals', value: 'degraded' }],
    });
    expect(await runMonitorCheck(validation.id, deps)).toMatchObject({ success: false });
    const run = await prisma.monitorRun.findFirstOrThrow({ where: { monitorId: validation.id } });
    expect(run.failureMessage).toBe('status: expected "degraded", got "healthy"');
  });

  it('records configuration problems as CONFIG_ERROR runs without sending anything', async () => {
    const missingVar = await monitor({ url: '/{{NOPE}}' });
    await runMonitorCheck(missingVar.id, deps);
    const noEnv = await monitor({ environmentId: null });
    await runMonitorCheck(noEnv.id, deps);

    const runs = await prisma.monitorRun.findMany({ orderBy: { startedAt: 'asc' } });
    expect(runs.map((r) => [r.failureReason, r.failureMessage])).toEqual([
      ['CONFIG_ERROR', 'Not defined in Production: NOPE'],
      ['CONFIG_ERROR', 'The monitor has no environment (it may have been deleted)'],
    ]);
    expect(received).toHaveLength(0);
  });

  it('skips deleted monitors, and paused ones unless run manually', async () => {
    expect(await runMonitorCheck('00000000-0000-4000-8000-000000000000', deps)).toEqual({
      status: 'skipped',
      reason: 'monitor-deleted',
    });
    const paused = await monitor({ enabled: false });
    expect(await runMonitorCheck(paused.id, deps)).toEqual({
      status: 'skipped',
      reason: 'monitor-paused',
    });
    expect(await runMonitorCheck(paused.id, deps, { manual: true })).toMatchObject({
      status: 'completed',
    });
  });
});
