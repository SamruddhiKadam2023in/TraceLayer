import { createPrismaClient, onAlertResolved, type Severity } from '@tracelayer/db';
import { evaluateMonitorRules } from '../src/alerts/evaluate-rules';

const prisma = createPrismaClient();
afterAll(() => prisma.$disconnect());

let projectId: string;
let endpointId: string;
let monitorId: string;

async function createMonitor(name: string) {
  const monitor = await prisma.monitor.create({
    data: { projectId, endpointId, name, type: 'STATUS', intervalSeconds: 60, timeoutMs: 2000 },
  });
  return monitor.id;
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE users, workspaces, projects, endpoints, monitors, monitor_runs, alert_rules, alerts, incidents, incident_events CASCADE',
  );
  const workspace = await prisma.workspace.create({ data: { name: 'Acme' } });
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Orders API' },
  });
  projectId = project.id;
  const endpoint = await prisma.endpoint.create({
    data: { projectId, name: 'Orders', method: 'POST', url: '/orders' },
  });
  endpointId = endpoint.id;
  monitorId = await createMonitor('Orders health');
});

/** A rule on the latest status code: breached while the last run returned `code`. */
function statusRule(severity: Severity, code = 503, monitor = monitorId) {
  return prisma.alertRule.create({
    data: {
      projectId,
      monitorId: monitor,
      name: `${severity} on ${code}`,
      metric: 'STATUS_CODE',
      threshold: code,
      durationMinutes: 0,
      severity,
    },
  });
}

let clock = Date.now();
/** Records a run and evaluates the monitor's rules, as the worker does after each check. */
async function check(statusCode: number, monitor = monitorId) {
  clock += 60_000;
  const now = new Date(clock);
  await prisma.monitorRun.create({
    data: {
      monitorId: monitor,
      projectId,
      endpointId,
      startedAt: now,
      success: statusCode < 400,
      statusCode,
      durationMs: 120,
    },
  });
  return evaluateMonitorRules(prisma, monitor, now);
}

const timeline = async (incidentId: string) =>
  (
    await prisma.incidentEvent.findMany({
      where: { incidentId },
      orderBy: { createdAt: 'asc' },
    })
  ).map((e) => [e.type, e.fromValue, e.toValue]);

describe('incident lifecycle', () => {
  it('opens an incident when an alert fires and resolves it when the monitor recovers', async () => {
    await statusRule('HIGH');
    const [fired] = await check(503);
    expect(fired?.incident).toMatchObject({ created: true, resolved: false });

    const incident = await prisma.incident.findFirstOrThrow({ include: { alerts: true } });
    expect(incident).toMatchObject({
      number: 1,
      monitorId,
      severity: 'HIGH',
      status: 'OPEN',
      resolvedAt: null,
      title: 'Orders health: Status code 503 — rule: Status code = 503',
    });
    expect(incident.alerts.map((a) => a.id)).toEqual([fired!.alertId]);

    // Still failing: nothing new.
    expect((await check(503))[0]?.incident).toBeNull();

    const [recovered] = await check(200);
    expect(recovered?.incident).toMatchObject({ id: incident.id, resolved: true });
    const resolved = await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(resolved).toMatchObject({ status: 'RESOLVED', resolvedById: null });
    expect(resolved.resolvedAt).not.toBeNull();
    expect(await timeline(incident.id)).toEqual([
      ['DETECTED', null, null],
      ['ALERT_FIRED', null, null],
      ['ALERT_RESOLVED', null, null],
      ['STATUS_CHANGED', 'OPEN', 'RESOLVED'],
    ]);
  });

  it('groups alerts of one monitor, raises severity, and resolves only when all recover', async () => {
    await statusRule('MEDIUM', 503);
    await prisma.alertRule.create({
      data: {
        projectId,
        monitorId,
        name: 'Two failures',
        metric: 'CONSECUTIVE_FAILURES',
        threshold: 1,
        durationMinutes: 0,
        severity: 'CRITICAL',
      },
    });

    await check(503); // the status rule fires; one failure is not > 1
    const incident = await prisma.incident.findFirstOrThrow();
    expect(incident.severity).toBe('MEDIUM');

    await prisma.monitor.update({ where: { id: monitorId }, data: { consecutiveFailures: 2 } });
    await check(503); // the failure-count rule fires and joins
    expect(await prisma.incident.count()).toBe(1);
    expect(await prisma.alert.count({ where: { incidentId: incident.id } })).toBe(2);
    expect(await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).toMatchObject({
      severity: 'CRITICAL',
      status: 'OPEN',
    });

    // The status recovers but failures still count: the incident stays open.
    await check(200);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).status).toBe(
      'OPEN',
    );

    await prisma.monitor.update({ where: { id: monitorId }, data: { consecutiveFailures: 0 } });
    await check(200);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).status).toBe(
      'RESOLVED',
    );
    expect(await timeline(incident.id)).toEqual([
      ['DETECTED', null, null],
      ['ALERT_FIRED', null, null],
      ['ALERT_FIRED', null, null],
      ['SEVERITY_CHANGED', 'MEDIUM', 'CRITICAL'],
      ['ALERT_RESOLVED', null, null],
      ['ALERT_RESOLVED', null, null],
      ['STATUS_CHANGED', 'OPEN', 'RESOLVED'],
    ]);
  });

  it('opens a new incident, with the next number, after the previous one resolved', async () => {
    await statusRule('HIGH');
    await check(503);
    await check(200);
    await check(503);
    const incidents = await prisma.incident.findMany({ orderBy: { number: 'asc' } });
    expect(incidents.map((i) => [i.number, i.status])).toEqual([
      [1, 'RESOLVED'],
      [2, 'OPEN'],
    ]);
  });

  it('keeps a manual resolution: a later recovery is only noted on the timeline', async () => {
    await statusRule('HIGH');
    await check(503);
    const incident = await prisma.incident.findFirstOrThrow();
    const person = await prisma.user.create({
      data: { name: 'Ada', email: 'ada@example.com', passwordHash: 'x' },
    });
    await prisma.incident.update({
      where: { id: incident.id },
      data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedById: person.id },
    });

    await check(200);
    const after = await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(after.resolvedById).toBe(person.id);
    expect((await timeline(incident.id)).at(-1)).toEqual(['ALERT_RESOLVED', null, null]);
  });

  it('leaves the incident open when an alert closes because its rule changed', async () => {
    await statusRule('HIGH');
    const [fired] = await check(503);
    await prisma.$transaction(async (tx) => {
      await tx.alert.update({
        where: { id: fired!.alertId! },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      });
      const outcome = await onAlertResolved(tx, {
        alertId: fired!.alertId!,
        now: new Date(),
        autoResolve: false,
        reason: 'HIGH on 503: rule changed',
      });
      expect(outcome).toMatchObject({ autoResolved: false });
    });
    expect((await prisma.incident.findFirstOrThrow()).status).toBe('OPEN');
  });

  it('numbers incidents uniquely when monitors of one project fail at the same moment', async () => {
    const monitors = [monitorId, await createMonitor('Payments'), await createMonitor('Search')];
    for (const m of monitors) await statusRule('HIGH', 503, m);
    await Promise.all(monitors.map((m) => check(503, m)));

    const numbers = (await prisma.incident.findMany()).map((i) => i.number).sort();
    expect(numbers).toEqual([1, 2, 3]);
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).incidentCounter,
    ).toBe(3);
  });

  it('never opens two incidents when two checks of one monitor race', async () => {
    await statusRule('HIGH');
    await statusRule('LOW');
    clock += 60_000;
    const now = new Date(clock);
    await prisma.monitorRun.create({
      data: { monitorId, projectId, endpointId, startedAt: now, success: false, statusCode: 503 },
    });
    await Promise.all([
      evaluateMonitorRules(prisma, monitorId, now),
      evaluateMonitorRules(prisma, monitorId, now),
    ]);
    expect(await prisma.incident.count()).toBe(1);
    expect(await prisma.alert.count()).toBe(2);
  });
});
