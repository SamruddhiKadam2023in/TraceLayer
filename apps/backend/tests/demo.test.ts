import request from 'supertest';
import { createSecretBox } from '@tracelayer/executor';

jest.mock('../src/lib/monitor-queue', () => ({
  syncMonitorSchedule: jest.fn(),
  unscheduleMonitor: jest.fn(),
  enqueueMonitorRun: jest.fn(),
  closeMonitorQueue: jest.fn(),
}));

import { createApp } from '../src/app';
import { DEMO_PROJECTS, DEMO_WORKSPACE_NAME } from '../src/demo/demo-data';
import { generateHistory } from '../src/demo/generate';
import { seedDemoWorkspace } from '../src/demo/seed';
import { prisma } from '../src/lib/prisma';
import { createTestUser, resetDatabase, type TestUser } from './helpers';

const secrets = createSecretBox(process.env.ENCRYPTION_KEY!);
// A fixed "now" keeps the generated history, and so these numbers, deterministic.
const NOW = new Date('2026-09-30T12:00:00.000Z');

let app: ReturnType<typeof createApp>;
let owner: TestUser;

beforeAll(async () => {
  await resetDatabase();
  app = createApp();
  owner = await createTestUser(app, 'Olivia Owner');
});

afterAll(async () => {
  await prisma.$disconnect();
});

const api = (path: string) => request(app).get(path).set(owner.auth);

describe('demo seed', () => {
  let workspaceId: string;
  const removed: string[][] = [];

  beforeAll(async () => {
    const summary = await seedDemoWorkspace(prisma, secrets, {
      ownerId: owner.id,
      now: NOW,
      onRemovedMonitors: async (ids) => void removed.push(ids),
    });
    workspaceId = summary.workspaceId;
    expect(summary).toMatchObject({
      projects: 3,
      endpoints: 9,
      monitors: 6,
      incidents: 5,
      activeIncidents: 1,
    });
    expect(summary.runs).toBeGreaterThan(10_000);
  });

  it('is clearly marked as demo data, with demo teammates', async () => {
    const workspaces = (await api('/api/workspaces')).body.data;
    expect(workspaces).toEqual([
      expect.objectContaining({
        name: DEMO_WORKSPACE_NAME,
        isDemo: true,
        role: 'OWNER',
        memberCount: 3,
      }),
    ]);
    const members = (await api(`/api/workspaces/${workspaceId}/members`)).body.data;
    expect(
      members.map((m: { name: string; role: string }) => `${m.name} ${m.role}`).sort(),
    ).toEqual(['Leo Martins VIEWER', 'Olivia Owner OWNER', 'Priya Shah MEMBER']);
  });

  it('creates projects, endpoints and paused monitors that the API serves normally', async () => {
    const projects = (await api(`/api/projects?workspaceId=${workspaceId}`)).body.data;
    expect(projects.map((p: { name: string }) => p.name)).toEqual(
      DEMO_PROJECTS.map((p) => p.name).sort(),
    );
    const payments = projects.find((p: { name: string }) => p.name === 'Payment API');
    const monitors = (await api(`/api/monitors?projectId=${payments.id}`)).body.data;
    expect(monitors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Charges API', enabled: false, health: 'FAILING' }),
        expect.objectContaining({ name: 'Refunds latency', enabled: false, health: 'HEALTHY' }),
      ]),
    );
  });

  it('stores secrets encrypted and never returns them', async () => {
    const variable = await prisma.environmentVariable.findFirstOrThrow({
      where: { key: 'API_KEY' },
    });
    expect(variable.value).toBeNull();
    expect(variable.encryptedValue).not.toContain('sk_test');
    expect(secrets.decrypt(variable.encryptedValue!)).toBe('sk_test_demo_4eC39HqLyjWDarjtT1zdp7dc');
  });

  it('produces believable metrics, computed from the stored runs like any real data', async () => {
    const summary = (await api(`/api/metrics/summary?workspaceId=${workspaceId}&range=7d`)).body
      .data;
    // Mostly healthy with a few incidents: well above 95%, but not a suspicious 100%.
    expect(summary.totals.uptime).toBeGreaterThan(97);
    expect(summary.totals.uptime).toBeLessThan(100);
    expect(summary.latency.p95).toBeGreaterThan(summary.latency.p50);
    expect(summary.statusCodes['5xx']).toBeGreaterThan(0);
  });

  it('has incidents with timelines: four resolved automatically, one still being investigated', async () => {
    const page = (await api(`/api/incidents?workspaceId=${workspaceId}&pageSize=20`)).body.data;
    expect(page.total).toBe(5);
    const active = page.items.filter((i: { status: string }) => i.status !== 'RESOLVED');
    expect(active).toEqual([
      expect.objectContaining({
        status: 'INVESTIGATING',
        severity: 'CRITICAL',
        monitor: expect.objectContaining({ name: 'Charges API' }),
        assignee: expect.objectContaining({ name: 'Olivia Owner' }),
        firingAlerts: 1,
      }),
    ]);

    const catalogue = page.items.find((i: { title: string }) =>
      i.title.startsWith('Product catalogue'),
    );
    const detail = (await api(`/api/incidents/${catalogue.id}`)).body.data;
    expect(detail).toMatchObject({ status: 'RESOLVED', resolvedBy: null });
    const types = detail.events.map((e: { type: string }) => e.type);
    // Acknowledged and assigned at the same moment: the status change reads first.
    expect(types.slice(0, 4)).toEqual(['DETECTED', 'ALERT_FIRED', 'STATUS_CHANGED', 'ASSIGNED']);
    expect(types).toContain('COMMENT');
    expect(types.slice(-3)).toEqual(['ALERT_RESOLVED', 'STATUS_CHANGED', 'COMMENT']);
  });

  it('draws a dependency map with manual and inferred parts and live health', async () => {
    const commerce = (await api(`/api/projects?workspaceId=${workspaceId}`)).body.data.find(
      (p: { name: string }) => p.name === 'E-Commerce API',
    );
    const map = (await api(`/api/dependencies?projectId=${commerce.id}`)).body.data;
    expect(map.nodes).toHaveLength(6);
    expect(map.edges.map((e: { origin: string }) => e.origin).sort()).toEqual([
      'INFERRED',
      'MANUAL',
      'MANUAL',
      'MANUAL',
      'MANUAL',
    ]);
    const catalog = map.nodes.find((n: { host: string | null }) => n.host === 'dummyjson.com');
    expect(catalog.health).not.toBeNull();
  });

  it('replaces the previous demo workspace when run again', async () => {
    const again = await seedDemoWorkspace(prisma, secrets, {
      ownerId: owner.id,
      now: NOW,
      onRemovedMonitors: async (ids) => void removed.push(ids),
    });
    expect(again.workspaceId).not.toBe(workspaceId);
    expect(await prisma.workspace.count({ where: { isDemo: true } })).toBe(1);
    // The old monitors were handed over for unscheduling.
    expect(removed.at(-1)).toHaveLength(6);
    workspaceId = again.workspaceId;
  });
});

describe('generated history', () => {
  const catalogue = DEMO_PROJECTS[0]!.monitors[0]!;

  it('is deterministic for the same moment', () => {
    const a = generateHistory(catalogue, NOW, 7);
    const b = generateHistory(catalogue, NOW, 7);
    expect(a.runs.length).toBe(b.runs.length);
    expect(a.runs.slice(0, 50)).toEqual(b.runs.slice(0, 50));
  });

  it('fires the rule exactly as the worker would: on the second consecutive failure', () => {
    const history = generateHistory(catalogue, NOW, 7);
    const [incident] = history.incidents;
    const index = history.runs.findIndex(
      (r) => r.startedAt.getTime() === incident!.firedAt.getTime(),
    );
    expect(history.runs[index]).toMatchObject({ success: false, statusCode: 503 });
    expect(history.runs[index - 1]).toMatchObject({ success: false });
    expect(history.runs[index - 2]).toMatchObject({ success: true });
    expect(incident!.message).toBe('Consecutive failures 2 — rule: Consecutive failures > 1');
    // Resolved by the first successful check after the outage.
    const recovery = history.runs.find(
      (r) => r.startedAt.getTime() === incident!.resolvedAt!.getTime(),
    );
    expect(recovery?.success).toBe(true);
  });
});
