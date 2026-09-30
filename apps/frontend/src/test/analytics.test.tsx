import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { EndpointView, MonitorMetrics, ProjectView } from '@tracelayer/shared';
import { routes } from '@/routes/router';
import {
  apiError,
  installFakeApi,
  makeSession,
  makeWorkspace,
  metricsHandlers,
  ok,
  type FakeResponse,
  type Handler,
} from './fake-api';

function monitorMetrics(
  name: string,
  health: MonitorMetrics['health'],
  overrides: Partial<MonitorMetrics> = {},
): MonitorMetrics {
  return {
    monitor: { id: `m-${name}`, name, enabled: true },
    project: { id: 'proj-1', name: 'Orders API' },
    endpoint: { id: 'ep-1', name: 'Health', method: 'GET' },
    environment: { id: 'env-1', name: 'Production' },
    health,
    totals: { total: 96, successful: 95, failed: 1, uptime: 98.96, errorRate: 1.04 },
    latency: { avg: 188, p95: 640 },
    ...overrides,
  };
}

const MONITORS = [
  monitorMetrics('Orders health', 'HEALTHY'),
  monitorMetrics('Checkout', 'FAILING', { project: { id: 'proj-2', name: 'Payments' } }),
  monitorMetrics('New one', 'NO_DATA'),
];

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

function api(extra: Record<string, Handler | FakeResponse> = {}) {
  return installFakeApi({
    'POST /auth/refresh': [200, ok(makeSession())],
    'GET /workspaces': [200, ok([makeWorkspace({ name: 'Acme' })])],
    'GET /projects/proj-1': [200, ok(PROJECT)],
    'GET /projects/proj-1/environments': [200, ok([])],
    'GET /incidents': [200, ok({ items: [], total: 0, page: 1, pageSize: 5 })],
    ...metricsHandlers({ monitors: MONITORS }),
    ...extra,
  });
}

function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('dashboard', () => {
  it('is the home page and aggregates the whole workspace', async () => {
    const fake = api();
    renderApp('/');

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Reliability of every monitored API in Acme.')).toBeInTheDocument();
    const metrics = await screen.findByRole('region', { name: 'Key metrics' });
    expect(await within(metrics).findByText('99.79%')).toBeInTheDocument();
    expect(within(metrics).getByText('184ms')).toBeInTheDocument();
    // Monitors card: count and how many are failing.
    expect(within(metrics).getByText('1 failing')).toBeInTheDocument();

    for (const path of ['/metrics', '/metrics/summary', '/metrics/latency', '/metrics/errors']) {
      expect(fake.callsTo('GET', path)[0]?.params).toEqual({ workspaceId: 'ws-1', range: '24h' });
    }
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
  });

  it('lists monitor health across projects, with counts per state', async () => {
    api();
    renderApp('/');

    const rows = await screen.findAllByTestId('monitor-health-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText(/Payments ·/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Failing')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('link', { name: 'Orders health' })).toHaveAttribute(
      'href',
      '/projects/proj-1/monitors/m-Orders health',
    );
    const counts = screen.getByRole('list', { name: 'Monitors by health' });
    expect(within(counts).getByLabelText('Healthy: 1')).toBeInTheDocument();
    expect(within(counts).getByLabelText('Failing: 1')).toBeInTheDocument();
    expect(within(counts).getByLabelText('No data: 1')).toBeInTheDocument();
  });

  it('draws the four charts with text summaries', async () => {
    api();
    renderApp('/');

    expect(
      await screen.findByRole('img', {
        name: /Latency last 24 hours: average 184 ms, P95 641 ms, P99 1.20 s/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', {
        name: /Error rate last 24 hours: 0.21% \(3 of 1440 checks failed\)/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /1440 checks last 24 hours: 1437 passed, 3 failed/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Status codes last 24 hours/ })).toBeInTheDocument();
  });

  it('guides a workspace with no monitors to create one', async () => {
    api(metricsHandlers({ monitors: [] }));
    renderApp('/');

    expect(await screen.findByText('No monitors configured yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create your first monitor →' })).toHaveAttribute(
      'href',
      '/projects',
    );
  });

  it('shows an error with retry in the chart that failed, keeping the rest', async () => {
    let fail = true;
    api({
      'GET /metrics/latency': () =>
        fail
          ? [500, apiError('INTERNAL_ERROR', 'Could not load latency')]
          : [
              200,
              ok({
                range: '24h',
                from: '',
                to: '',
                bucketMs: 900_000,
                points: [
                  { t: '2026-09-30T09:00:00.000Z', avg: 184, p50: 170, p95: 641, p99: 1200 },
                ],
              }),
            ],
    });
    renderApp('/');

    const latencyCard = (await screen.findByRole('heading', { name: 'Latency' })).closest(
      'section',
    )!;
    expect(await within(latencyCard).findByRole('alert')).toHaveTextContent(
      'Could not load latency',
    );
    // Other panels still show their data.
    expect(
      await screen.findByRole('img', { name: /Error rate last 24 hours/ }),
    ).toBeInTheDocument();

    fail = false;
    await userEvent.click(within(latencyCard).getByRole('button', { name: 'Retry' }));
    expect(
      await within(latencyCard).findByRole('img', { name: /Latency last 24 hours/ }),
    ).toBeInTheDocument();
  });

  it('says so when a period has no responses instead of drawing an empty chart', async () => {
    api({
      'GET /metrics/latency': [
        200,
        ok({
          range: '1h',
          from: '',
          to: '',
          bucketMs: 60_000,
          points: [{ t: '2026-09-30T09:00:00.000Z', avg: null, p50: null, p95: null, p99: null }],
        }),
      ],
    });
    renderApp('/');
    expect(await screen.findByText('No responses in this period.')).toBeInTheDocument();
  });
});

describe('project and endpoint analytics', () => {
  it('scopes the Analytics tab to the project', async () => {
    const fake = api();
    renderApp('/projects/proj-1/analytics');

    expect(await screen.findByRole('link', { name: 'Analytics' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await screen.findAllByTestId('monitor-health-row');
    expect(fake.callsTo('GET', '/metrics/summary')[0]?.params).toEqual({
      projectId: 'proj-1',
      range: '24h',
    });
  });

  it('shows analytics for the endpoint on its page', async () => {
    const endpoint: EndpointView = {
      id: 'ep-1',
      projectId: 'proj-1',
      name: 'Health',
      description: null,
      method: 'GET',
      url: '/health',
      environmentId: null,
      headers: [],
      queryParams: [],
      body: { type: 'none' },
      auth: { type: 'none' },
      timeoutMs: 10000,
      expectedStatus: null,
      tags: [],
      createdBy: null,
      createdAt: '2026-09-29T10:00:00.000Z',
      updatedAt: '2026-09-29T10:00:00.000Z',
    };
    const fake = api({ 'GET /endpoints/ep-1': [200, ok(endpoint)] });
    renderApp('/projects/proj-1/endpoints/ep-1');

    expect(await screen.findByRole('heading', { name: 'Analytics' })).toBeInTheDocument();
    await screen.findAllByTestId('monitor-health-row');
    expect(fake.callsTo('GET', '/metrics/summary')[0]?.params).toEqual({
      projectId: 'proj-1',
      endpointId: 'ep-1',
      range: '24h',
    });
  });
});
