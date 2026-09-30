import { act, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import type {
  IncidentRealtimePayload,
  IncidentSummary,
  MonitorRealtimePayload,
} from '@tracelayer/shared';
import { routes } from '@/routes/router';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { installFakeApi, makeSession, makeWorkspace, metricsHandlers, ok } from './fake-api';
import { fakeSockets, latestSocket } from './fake-socket';

const INCIDENT: IncidentSummary = {
  id: 'inc-1',
  projectId: 'proj-1',
  number: 12,
  title: 'Orders health: Error rate 8.7% > 5% over 5 min',
  severity: 'HIGH',
  status: 'OPEN',
  project: { id: 'proj-1', name: 'Orders API' },
  monitor: { id: 'mon-1', name: 'Orders health' },
  assignee: null,
  firingAlerts: 1,
  detectedAt: new Date().toISOString(),
  acknowledgedAt: null,
  resolvedAt: null,
  resolvedBy: null,
};

function incidentEvent(
  change: IncidentRealtimePayload['change'],
  extra: Partial<IncidentRealtimePayload> = {},
): IncidentRealtimePayload {
  return {
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    incident: { id: 'inc-1', number: 12, title: INCIDENT.title, severity: 'HIGH', status: 'OPEN' },
    change,
    actor: null,
    ...extra,
  };
}

function api(extra = {}) {
  return installFakeApi({
    'POST /auth/refresh': [200, ok(makeSession())],
    'GET /workspaces': [200, ok([makeWorkspace(), makeWorkspace({ id: 'ws-2', name: 'Globex' })])],
    'GET /incidents': [200, ok({ items: [], total: 0, page: 1, pageSize: 5 })],
    ...metricsHandlers(),
    ...extra,
  });
}

function renderApp(path = '/') {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

/** Waits for the app to open its socket, then lets the fake server accept it. */
async function goLive() {
  await waitFor(() => expect(fakeSockets.length).toBeGreaterThan(0));
  const socket = latestSocket();
  act(() => socket.serverAccept());
  return socket;
}

describe('live connection', () => {
  it('connects with the access token, subscribes to the current workspace and follows switches', async () => {
    api();
    renderApp();
    const socket = await goLive();

    expect(socket.authPayload()).toEqual({ token: 'access-token-1' });
    expect(socket.subscriptions).toEqual(['ws-1']);
    expect(await screen.findByText('Live')).toBeInTheDocument();

    act(() => useWorkspaceStore.getState().select('ws-2'));
    await waitFor(() => expect(socket.subscriptions).toEqual(['ws-1', 'ws-2']));
    expect(fakeSockets).toHaveLength(1); // one connection, re-subscribed
  });

  it('shows when live updates are unavailable', async () => {
    api();
    renderApp();
    const socket = await goLive();
    expect(await screen.findByText('Live')).toBeInTheDocument();
    act(() => socket.serverDrop());
    expect(await screen.findByText('Connecting…')).toBeInTheDocument();
  });

  it('renews an expired token and reconnects with the new one', async () => {
    let refreshes = 0;
    const fake = api({
      'POST /auth/refresh': () => [
        200,
        ok(makeSession({ accessToken: `access-token-${++refreshes}` })),
      ],
    });
    renderApp();
    await waitFor(() => expect(fakeSockets.length).toBe(1));
    const socket = latestSocket();
    const startupRefreshes = fake.callsTo('POST', '/auth/refresh').length;

    act(() => socket.serverReject('UNAUTHENTICATED'));
    await waitFor(() =>
      expect(fake.callsTo('POST', '/auth/refresh').length).toBe(startupRefreshes + 1),
    );
    await waitFor(() => expect(socket.connectCalls).toBe(1), { timeout: 3000 });
    expect(socket.authPayload()).toEqual({ token: `access-token-${refreshes}` });
  });

  it('reconnects by itself when the server closes a socket whose token expired', async () => {
    api();
    renderApp();
    const socket = await goLive();
    act(() => socket.serverDrop('io server disconnect'));
    expect(socket.connectCalls).toBe(1);
  });
});

describe('incident notifications', () => {
  it('announces incidents opened and resolved by TraceLayer or other people', async () => {
    api();
    const router = renderApp();
    const socket = await goLive();

    act(() => socket.serverEmit('incident.created', incidentEvent('opened')));
    const notifications = screen.getByRole('region', { name: 'Notifications' });
    const link = await within(notifications).findByRole('link', { name: 'Incident #12 opened' });
    expect(link).toHaveAttribute('href', '/projects/proj-1/incidents/inc-1');
    expect(within(notifications).getByText(INCIDENT.title)).toBeInTheDocument();

    act(() =>
      socket.serverEmit(
        'incident.updated',
        incidentEvent('status', {
          incident: { ...incidentEvent('status').incident, status: 'RESOLVED' },
          actor: { id: 'user-2', name: 'Grace Hopper' },
        }),
      ),
    );
    expect(
      await within(notifications).findByText('Incident #12 resolved by Grace Hopper'),
    ).toBeInTheDocument();

    act(() => socket.serverEmit('incident.updated', incidentEvent('resolved_automatically')));
    expect(await within(notifications).findByText('The monitor recovered.')).toBeInTheDocument();

    // Dismissing removes it.
    act(() =>
      within(notifications).getAllByRole('button', { name: 'Dismiss notification' })[0]!.click(),
    );
    expect(within(notifications).queryByText('The monitor recovered.')).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });

  it('does not notify people about their own changes, or about comments', async () => {
    api();
    renderApp();
    const socket = await goLive();
    act(() => {
      socket.serverEmit(
        'incident.updated',
        incidentEvent('status', {
          incident: { ...incidentEvent('status').incident, status: 'RESOLVED' },
          actor: { id: 'user-1', name: 'Ada Lovelace' },
        }),
      );
      socket.serverEmit(
        'incident.updated',
        incidentEvent('comment', { actor: { id: 'user-2', name: 'Grace Hopper' } }),
      );
    });
    await new Promise((r) => setTimeout(r, 50));
    const notifications = screen.getByRole('region', { name: 'Notifications' });
    expect(within(notifications).queryAllByRole('status')).toHaveLength(0);
  });
});

describe('live page updates', () => {
  it('refreshes the dashboard’s active incidents when an incident changes, and after a reconnect', async () => {
    let calls = 0;
    const fake = api({
      'GET /incidents': () => {
        calls++;
        return [
          200,
          ok({
            items: calls > 1 ? [INCIDENT] : [],
            total: calls > 1 ? 1 : 0,
            page: 1,
            pageSize: 5,
          }),
        ];
      },
    });
    renderApp();
    expect(await screen.findByText(/No active incidents/)).toBeInTheDocument();
    const socket = await goLive();

    act(() => socket.serverEmit('incident.created', incidentEvent('opened')));
    const panel = screen.getByRole('region', { name: /Active incidents/ });
    expect(await within(panel).findByText(INCIDENT.title)).toBeInTheDocument();

    const before = fake.callsTo('GET', '/incidents').length;
    act(() => {
      socket.serverDrop();
      socket.serverAccept();
    });
    await waitFor(() => expect(fake.callsTo('GET', '/incidents').length).toBeGreaterThan(before), {
      timeout: 5000,
    });
  });

  it('refreshes a monitor’s runs when it is checked', async () => {
    const MONITOR_ID = '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const fake = api({
      'GET /projects/proj-1': [
        200,
        ok({
          id: 'proj-1',
          workspaceId: 'ws-1',
          name: 'Orders API',
          description: null,
          createdBy: null,
          environmentCount: 0,
          createdAt: '',
          updatedAt: '',
        }),
      ],
      'GET /projects/proj-1/environments': [200, ok([])],
      'GET /endpoints': [200, ok([])],
      [`GET /monitors/${MONITOR_ID}`]: [
        200,
        ok({
          id: MONITOR_ID,
          projectId: 'proj-1',
          name: 'Orders health',
          endpointId: 'e',
          environmentId: null,
          type: 'STATUS',
          intervalSeconds: 300,
          timeoutMs: 4000,
          expectedStatus: 200,
          latencyThresholdMs: null,
          assertions: [],
          enabled: true,
          endpoint: { id: 'e', name: 'Health', method: 'GET', url: '/health' },
          environment: null,
          lastRunAt: null,
          lastRunSuccess: null,
          consecutiveFailures: 0,
          health: 'NO_DATA',
          createdBy: null,
          createdAt: '',
          updatedAt: '',
        }),
      ],
      [`GET /monitors/${MONITOR_ID}/runs`]: [200, ok([])],
      'GET /alerts': [200, ok([])],
      'GET /notification-channels': [200, ok([])],
    });
    renderApp(`/projects/proj-1/monitors/${MONITOR_ID}`);
    expect(await screen.findByRole('heading', { name: 'Orders health' })).toBeInTheDocument();
    const socket = await goLive();
    const before = fake.callsTo('GET', `/monitors/${MONITOR_ID}/runs`).length;

    const checked: MonitorRealtimePayload = {
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      monitor: { id: MONITOR_ID, name: 'Orders health' },
      run: {
        id: 'r1',
        startedAt: new Date().toISOString(),
        success: false,
        statusCode: 503,
        durationMs: 120,
        failureReason: 'UNEXPECTED_STATUS',
      },
      health: 'FAILING',
      previousHealth: 'NO_DATA',
    };
    act(() => socket.serverEmit('monitor.checked', checked));
    await waitFor(
      () =>
        expect(fake.callsTo('GET', `/monitors/${MONITOR_ID}/runs`).length).toBeGreaterThan(before),
      { timeout: 3000 },
    );
    // Events for other monitors are ignored.
    const after = fake.callsTo('GET', `/monitors/${MONITOR_ID}/runs`).length;
    act(() =>
      socket.serverEmit('monitor.checked', { ...checked, monitor: { id: 'other', name: 'x' } }),
    );
    await new Promise((r) => setTimeout(r, 1500));
    expect(fake.callsTo('GET', `/monitors/${MONITOR_ID}/runs`)).toHaveLength(after);
  });
});
