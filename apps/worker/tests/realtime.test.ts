import { createPrismaClient } from '@tracelayer/db';
import type { RealtimeEventName } from '@tracelayer/shared';
import type { RuleEvaluationResult } from '../src/alerts/evaluate-rules';
import { publishCheckEvents } from '../src/realtime/check-events';
import type { RealtimePublish } from '../src/realtime/publisher';

const prisma = createPrismaClient();
afterAll(() => prisma.$disconnect());

let workspaceId: string;
let projectId: string;
let endpointId: string;
let monitorId: string;
let published: { workspaceId: string; event: RealtimeEventName; payload: unknown }[];
const publish: RealtimePublish = (ws, event, payload) =>
  void published.push({ workspaceId: ws, event, payload });

beforeEach(async () => {
  published = [];
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE users, workspaces, projects, endpoints, monitors, monitor_runs, alert_rules, alerts, incidents, incident_events CASCADE',
  );
  const workspace = await prisma.workspace.create({ data: { name: 'Acme' } });
  workspaceId = workspace.id;
  const project = await prisma.project.create({ data: { workspaceId, name: 'Orders API' } });
  projectId = project.id;
  endpointId = (
    await prisma.endpoint.create({
      data: { projectId, name: 'Orders', method: 'GET', url: '/orders' },
    })
  ).id;
  monitorId = (
    await prisma.monitor.create({
      data: {
        projectId,
        endpointId,
        name: 'Orders health',
        type: 'STATUS',
        intervalSeconds: 60,
        timeoutMs: 2000,
      },
    })
  ).id;
});

let clock = Date.now();
async function run(success: boolean, evaluations: RuleEvaluationResult[] = []) {
  clock += 60_000;
  const row = await prisma.monitorRun.create({
    data: {
      monitorId,
      projectId,
      endpointId,
      startedAt: new Date(clock),
      success,
      statusCode: success ? 200 : 503,
      durationMs: 120,
      failureReason: success ? null : 'UNEXPECTED_STATUS',
    },
  });
  published = [];
  await publishCheckEvents(prisma, publish, monitorId, row.id, evaluations);
  return row;
}
const events = () => published.map((p) => p.event);

describe('monitor events', () => {
  it('announces the first failure, stays quiet while it keeps failing, and announces recovery', async () => {
    const first = await run(false);
    expect(events()).toEqual(['monitor.checked', 'monitor.failed', 'monitor.status_changed']);
    expect(published[0]).toEqual({
      workspaceId,
      event: 'monitor.checked',
      payload: {
        workspaceId,
        projectId,
        monitor: { id: monitorId, name: 'Orders health' },
        run: {
          id: first.id,
          startedAt: first.startedAt.toISOString(),
          success: false,
          statusCode: 503,
          durationMs: 120,
          failureReason: 'UNEXPECTED_STATUS',
        },
        health: 'FAILING',
        previousHealth: 'NO_DATA',
      },
    });

    await run(false);
    expect(events()).toEqual(['monitor.checked']);

    await run(true);
    // 2 of 3 runs failed: still FAILING by the half-failed rule, so no status change yet.
    expect(events()).toEqual(['monitor.checked', 'monitor.recovered']);
  });

  it('announces health changes computed from the latest runs', async () => {
    for (let i = 0; i < 5; i++) await run(true);
    expect(events()).toEqual(['monitor.checked']);
    await run(false);
    expect(events()).toEqual(['monitor.checked', 'monitor.failed', 'monitor.status_changed']);
    expect(published.at(-1)?.payload).toMatchObject({
      previousHealth: 'HEALTHY',
      health: 'DEGRADED',
    });
  });
});

describe('incident events', () => {
  async function incident(number: number, status: 'OPEN' | 'RESOLVED' = 'OPEN') {
    return prisma.incident.create({
      data: {
        projectId,
        monitorId,
        number,
        title: `Incident ${number}`,
        severity: 'HIGH',
        status,
        resolvedAt: status === 'RESOLVED' ? new Date() : null,
      },
    });
  }
  const evaluation = (
    id: string,
    flags: { created?: boolean; resolved?: boolean },
  ): RuleEvaluationResult => ({
    ruleId: 'r',
    transition: flags.resolved ? 'resolved' : 'fired',
    alertId: 'a',
    incident: { id, created: flags.created ?? false, resolved: flags.resolved ?? false },
  });

  it('announces opened, joined and automatically resolved incidents, once each', async () => {
    const opened = await incident(1);
    const joined = await incident(2);
    const resolved = await incident(3, 'RESOLVED');

    await run(false, [
      evaluation(opened.id, { created: true }),
      evaluation(joined.id, {}),
      evaluation(resolved.id, {}),
      evaluation(resolved.id, { resolved: true }),
    ]);

    const incidentEvents = published.filter((p) => p.event.startsWith('incident.'));
    expect(incidentEvents).toHaveLength(3);
    const byId = Object.fromEntries(
      incidentEvents.map((p) => {
        const payload = p.payload as { incident: { id: string }; change: string };
        return [payload.incident.id, [p.event, payload.change]];
      }),
    );
    expect(byId).toEqual({
      [opened.id]: ['incident.created', 'opened'],
      [joined.id]: ['incident.updated', 'alert_added'],
      [resolved.id]: ['incident.updated', 'resolved_automatically'],
    });
    expect(incidentEvents[0]?.payload).toMatchObject({
      workspaceId,
      projectId,
      actor: null,
    });
  });
});
