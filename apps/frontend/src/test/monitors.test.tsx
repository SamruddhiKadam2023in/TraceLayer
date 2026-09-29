import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import type {
  EndpointView,
  EnvironmentView,
  MetricsSummary,
  MonitorRunView,
  MonitorView,
  ProjectView,
  WorkspaceRole,
} from '@tracelayer/shared';
import { formatAssertionValue, parseAssertionValue } from '@/components/monitors/assertion-values';
import { routes } from '@/routes/router';
import {
  installFakeApi,
  makeSession,
  makeWorkspace,
  ok,
  type FakeResponse,
  type Handler,
} from './fake-api';

const ENV_ID = '7f3e2a10-4b5c-4d6e-8f90-a1b2c3d4e5f6';
const ENDPOINT_ID = '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a';

const PROJECT: ProjectView = {
  id: 'proj-1',
  workspaceId: 'ws-1',
  name: 'Orders API',
  description: null,
  createdBy: null,
  environmentCount: 1,
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
};

const ENVIRONMENT: EnvironmentView = {
  id: ENV_ID,
  projectId: 'proj-1',
  name: 'Production',
  baseUrl: 'https://api.example.com',
  variables: [],
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
};

const ENDPOINT: EndpointView = {
  id: ENDPOINT_ID,
  projectId: 'proj-1',
  name: 'Health',
  description: null,
  method: 'GET',
  url: '/health',
  environmentId: ENV_ID,
  headers: [],
  queryParams: [],
  body: { type: 'none' },
  auth: { type: 'none' },
  timeoutMs: 4000,
  expectedStatus: null,
  tags: [],
  createdBy: null,
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
};

function monitor(overrides: Partial<MonitorView> = {}): MonitorView {
  return {
    id: 'mon-1',
    projectId: 'proj-1',
    name: 'Production health',
    endpointId: ENDPOINT_ID,
    environmentId: ENV_ID,
    type: 'STATUS',
    intervalSeconds: 300,
    timeoutMs: 4000,
    expectedStatus: 200,
    latencyThresholdMs: null,
    assertions: [],
    enabled: true,
    endpoint: { id: ENDPOINT_ID, name: 'Health', method: 'GET', url: '/health' },
    environment: { id: ENV_ID, name: 'Production' },
    lastRunAt: new Date(Date.now() - 120_000).toISOString(),
    lastRunSuccess: true,
    consecutiveFailures: 0,
    health: 'HEALTHY',
    createdBy: null,
    createdAt: '2026-09-29T10:00:00.000Z',
    updatedAt: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
}

function run(id: string, overrides: Partial<MonitorRunView> = {}): MonitorRunView {
  return {
    id,
    monitorId: 'mon-1',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    success: true,
    statusCode: 200,
    durationMs: 142,
    sizeBytes: 2048,
    timedOut: false,
    failureReason: null,
    failureMessage: null,
    ...overrides,
  };
}

const SUMMARY: MetricsSummary = {
  range: '24h',
  from: '2026-09-29T10:00:00.000Z',
  to: '2026-09-30T10:00:00.000Z',
  totals: { total: 1440, successful: 1437, failed: 3, uptime: 99.79, errorRate: 0.21 },
  latency: { avg: 184, min: 90, max: 1210, p50: 170, p95: 641, p99: 1200 },
  statusCodes: { '2xx': 1437, '3xx': 0, '4xx': 1, '5xx': 1, noResponse: 1 },
};

function api(role: WorkspaceRole, extra: Record<string, Handler | FakeResponse> = {}) {
  return installFakeApi({
    'POST /auth/refresh': [200, ok(makeSession())],
    'GET /workspaces': [200, ok([makeWorkspace({ role })])],
    'GET /projects/proj-1': [200, ok(PROJECT)],
    'GET /projects/proj-1/environments': [200, ok([ENVIRONMENT])],
    'GET /endpoints': [200, ok([ENDPOINT])],
    'GET /monitors': [
      200,
      ok([
        monitor(),
        monitor({
          id: 'mon-2',
          name: 'Paused one',
          enabled: false,
          lastRunAt: null,
          lastRunSuccess: null,
          health: 'NO_DATA',
        }),
      ]),
    ],
    'GET /monitors/mon-1': [200, ok(monitor())],
    'GET /monitors/mon-1/runs': [
      200,
      ok([
        run('r1'),
        run('r2', {
          success: false,
          statusCode: 500,
          failureReason: 'UNEXPECTED_STATUS',
          failureMessage: 'Expected 200, received 500',
        }),
      ]),
    ],
    'GET /metrics/summary': [200, ok(SUMMARY)],
    ...extra,
  });
}

function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('monitor list', () => {
  it('shows each monitor with its latest result, and paused ones as paused', async () => {
    api('VIEWER');
    renderApp('/projects/proj-1/monitors');

    const list = await screen.findByRole('list', { name: 'Monitors' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(within(first!).getByText('Production health')).toBeInTheDocument();
    expect(within(first!).getByText('Healthy')).toBeInTheDocument();
    expect(within(first!).getByText(/Status · every 5 min/)).toBeInTheDocument();
    expect(within(first!).getByText('2 min ago')).toBeInTheDocument();
    expect(within(second!).getByText('Paused')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 running')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New monitor' })).not.toBeInTheDocument();
  });

  it('offers creation to members when there are none', async () => {
    api('MEMBER', { 'GET /monitors': [200, ok([])] });
    renderApp('/projects/proj-1/monitors');
    expect(await screen.findByText('No monitors yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New monitor' })).toBeInTheDocument();
  });
});

describe('creating a monitor', () => {
  it('creates a response validation monitor, typing check values as JSON', async () => {
    const fake = api('MEMBER', {
      'POST /monitors': [201, ok(monitor({ id: 'mon-new' }))],
      'GET /monitors/mon-new': [200, ok(monitor({ id: 'mon-new' }))],
      'GET /monitors/mon-new/runs': [200, ok([])],
    });
    renderApp('/projects/proj-1/monitors/new');

    await userEvent.type(await screen.findByLabelText('Name'), 'Health payload');
    await userEvent.selectOptions(screen.getByLabelText('Endpoint'), ENDPOINT_ID);
    // The timeout follows the chosen endpoint.
    expect(screen.getByLabelText('Timeout (ms)')).toHaveValue(4000);
    await userEvent.selectOptions(screen.getByLabelText('Check every'), '60');
    await userEvent.click(screen.getByLabelText(/Response validation/));

    await userEvent.click(screen.getByRole('button', { name: 'Add check' }));
    await userEvent.type(screen.getByLabelText('Check 1 path'), 'status');
    await userEvent.type(screen.getByLabelText('Check 1 value'), 'healthy');
    await userEvent.click(screen.getByRole('button', { name: 'Add check' }));
    await userEvent.type(screen.getByLabelText('Check 2 path'), 'version');
    await userEvent.type(screen.getByLabelText('Check 2 value'), '3');
    await userEvent.click(screen.getByRole('button', { name: 'Create monitor' }));

    expect(await screen.findByRole('heading', { name: 'Production health' })).toBeInTheDocument();
    expect(fake.callsTo('POST', '/monitors')[0]?.body).toEqual({
      projectId: 'proj-1',
      name: 'Health payload',
      endpointId: ENDPOINT_ID,
      environmentId: ENV_ID,
      type: 'RESPONSE_VALIDATION',
      intervalSeconds: 60,
      timeoutMs: 4000,
      expectedStatus: null,
      latencyThresholdMs: null,
      assertions: [
        { path: 'status', operator: 'equals', value: 'healthy' },
        { path: 'version', operator: 'equals', value: 3 },
      ],
      enabled: true,
    });
  });

  it('requires a latency threshold below the timeout for performance monitors', async () => {
    const fake = api('OWNER');
    renderApp('/projects/proj-1/monitors/new');

    await userEvent.type(await screen.findByLabelText('Name'), 'Fast enough');
    await userEvent.selectOptions(screen.getByLabelText('Endpoint'), ENDPOINT_ID);
    await userEvent.click(screen.getByLabelText(/Performance/));
    await userEvent.click(screen.getByRole('button', { name: 'Create monitor' }));
    expect(await screen.findByText('Enter a latency threshold')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Latency threshold (ms)'), '5000');
    await userEvent.click(screen.getByRole('button', { name: 'Create monitor' }));
    expect(
      await screen.findByText('The threshold must be lower than the timeout'),
    ).toBeInTheDocument();
    expect(fake.callsTo('POST', '/monitors')).toHaveLength(0);
  });

  it('points to endpoints when the project has none', async () => {
    api('OWNER', { 'GET /endpoints': [200, ok([])] });
    renderApp('/projects/proj-1/monitors/new');
    expect(await screen.findByText('Add an endpoint first')).toBeInTheDocument();
  });
});

describe('monitor detail', () => {
  it('shows the configuration and recent runs with failure reasons', async () => {
    api('VIEWER');
    renderApp('/projects/proj-1/monitors/mon-1');

    expect(await screen.findByRole('heading', { name: 'Production health' })).toBeInTheDocument();
    expect(screen.getByText('every 5 min')).toBeInTheDocument();
    const rows = await screen.findAllByTestId('monitor-run');
    expect(within(rows[0]!).getByText('Pass')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('142ms')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Fail')).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/Expected 200, received 500/)).toBeInTheDocument();
    // Viewers get no controls.
    expect(
      screen.queryByRole('button', { name: /Run now|Pause|Edit|Delete/ }),
    ).not.toBeInTheDocument();
  });

  it('queues a run on demand and pauses or resumes the monitor', async () => {
    const fake = api('MEMBER', {
      'POST /monitors/mon-1/run': [202, ok({ queued: true })],
      'PATCH /monitors/mon-1': [200, ok(monitor({ enabled: false }))],
    });
    renderApp('/projects/proj-1/monitors/mon-1');

    await userEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    expect(fake.callsTo('POST', '/monitors/mon-1/run')).toHaveLength(1);
    expect(await screen.findByRole('button', { name: 'Running…' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(fake.callsTo('PATCH', '/monitors/mon-1')[0]?.body).toEqual({ enabled: false });
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });
});

describe('monitor metrics', () => {
  it('shows uptime, latency percentiles and status codes, and refetches for another range', async () => {
    const fake = api('VIEWER');
    renderApp('/projects/proj-1/monitors/mon-1');

    const metrics = await screen.findByRole('region', { name: /Metrics/ });
    expect(await within(metrics).findByText('99.79%')).toBeInTheDocument();
    expect(within(metrics).getByText('641ms')).toBeInTheDocument(); // P95
    expect(within(metrics).getByText('1.20s')).toBeInTheDocument(); // P99
    expect(within(metrics).getByText('3 failed')).toBeInTheDocument();
    const codes = within(metrics).getByRole('list', { name: 'Status code distribution' });
    expect(within(codes).getByText('1437')).toBeInTheDocument();

    expect(fake.callsTo('GET', '/metrics/summary')[0]?.params).toEqual({
      projectId: 'proj-1',
      monitorId: 'mon-1',
      range: '24h',
    });
    await userEvent.click(within(metrics).getByRole('radio', { name: '7d' }));
    expect(within(metrics).getByRole('radio', { name: '7d' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(fake.callsTo('GET', '/metrics/summary').at(-1)?.params).toMatchObject({ range: '7d' });
  });

  it('shows a dash, not a made-up number, when there is no data', async () => {
    api('VIEWER', {
      'GET /metrics/summary': [
        200,
        ok({
          ...SUMMARY,
          totals: { total: 0, successful: 0, failed: 0, uptime: null, errorRate: null },
          latency: { avg: null, min: null, max: null, p50: null, p95: null, p99: null },
          statusCodes: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, noResponse: 0 },
        }),
      ],
    });
    renderApp('/projects/proj-1/monitors/mon-1');

    const metrics = await screen.findByRole('region', { name: /Metrics/ });
    expect(await within(metrics).findByText('No runs in this period.')).toBeInTheDocument();
    const uptime = within(metrics).getByText('Uptime').parentElement!;
    expect(within(uptime).getByText('—')).toBeInTheDocument();
  });
});

describe('assertion values', () => {
  it('reads JSON and keeps the type when edited and saved again', () => {
    expect(parseAssertionValue('200')).toBe(200);
    expect(parseAssertionValue('true')).toBe(true);
    expect(parseAssertionValue('healthy')).toBe('healthy');
    expect(parseAssertionValue('"200"')).toBe('200');
    for (const value of ['healthy', '200', 200, null, { a: 1 }, ['x']]) {
      expect(parseAssertionValue(formatAssertionValue(value))).toEqual(value);
    }
  });
});
