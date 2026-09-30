import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import type {
  IncidentDetail,
  IncidentEventView,
  IncidentSummary,
  ProjectView,
  WorkspaceMemberView,
  WorkspaceRole,
} from '@tracelayer/shared';
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

const INCIDENT_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const MONITOR_ID = '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

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

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function summary(overrides: Partial<IncidentSummary> = {}): IncidentSummary {
  return {
    id: INCIDENT_ID,
    projectId: 'proj-1',
    number: 12,
    title: 'Orders health: Error rate 8.7% > 5% over 5 min',
    severity: 'HIGH',
    status: 'OPEN',
    project: { id: 'proj-1', name: 'Orders API' },
    monitor: { id: MONITOR_ID, name: 'Orders health' },
    assignee: null,
    firingAlerts: 1,
    detectedAt: minutesAgo(30),
    acknowledgedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

const event = (
  id: string,
  type: IncidentEventView['type'],
  extra: Partial<IncidentEventView> = {},
): IncidentEventView => ({
  id,
  type,
  actor: null,
  message: null,
  fromValue: null,
  toValue: null,
  createdAt: minutesAgo(30),
  ...extra,
});

function detail(overrides: Partial<IncidentDetail> = {}): IncidentDetail {
  return {
    ...summary(),
    alerts: [
      {
        id: 'al-1',
        rule: { id: 'r-1', name: 'Error spike' },
        severity: 'HIGH',
        status: 'FIRING',
        message: 'Error rate 8.7% > 5% over 5 min',
        firedAt: minutesAgo(30),
        resolvedAt: null,
      },
    ],
    events: [
      event('e1', 'DETECTED'),
      event('e2', 'ALERT_FIRED', { message: 'Error spike: Error rate 8.7% > 5% over 5 min' }),
    ],
    ...overrides,
  };
}

const MEMBERS: WorkspaceMemberView[] = [
  { userId: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com', role: 'OWNER', joinedAt: '' },
  {
    userId: 'user-2',
    name: 'Grace Hopper',
    email: 'grace@example.com',
    role: 'MEMBER',
    joinedAt: '',
  },
  {
    userId: 'user-3',
    name: 'Vera Viewer',
    email: 'vera@example.com',
    role: 'VIEWER',
    joinedAt: '',
  },
];

function api(role: WorkspaceRole, extra: Record<string, Handler | FakeResponse> = {}) {
  return installFakeApi({
    'POST /auth/refresh': [200, ok(makeSession())],
    'GET /workspaces': [200, ok([makeWorkspace({ role })])],
    'GET /workspaces/ws-1/members': [200, ok(MEMBERS)],
    'GET /projects/proj-1': [200, ok(PROJECT)],
    'GET /incidents': [200, ok({ items: [summary()], total: 1, page: 1, pageSize: 20 })],
    [`GET /incidents/${INCIDENT_ID}`]: [200, ok(detail())],
    ...metricsHandlers(),
    ...extra,
  });
}

function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('project incidents', () => {
  it('lists active incidents by default and filters by severity and assignee', async () => {
    const fake = api('VIEWER');
    const router = renderApp('/projects/proj-1/incidents');

    const [row] = await screen.findAllByTestId('incident-row');
    expect(within(row!).getByText('#12')).toBeInTheDocument();
    expect(within(row!).getByText('Open')).toBeInTheDocument();
    expect(within(row!).getByText('HIGH')).toBeInTheDocument();
    expect(within(row!).getByText(/Orders health · 1 alert firing/)).toBeInTheDocument();
    expect(within(row!).getByText('Unassigned')).toBeInTheDocument();
    expect(within(row!).getByText(/open for 30m/)).toBeInTheDocument();
    expect(within(row!).getByRole('link')).toHaveAttribute(
      'href',
      `/projects/proj-1/incidents/${INCIDENT_ID}`,
    );
    expect(fake.callsTo('GET', '/incidents')[0]?.params).toEqual({
      projectId: 'proj-1',
      page: 1,
      pageSize: 20,
      status: 'ACTIVE',
    });

    await userEvent.selectOptions(screen.getByLabelText('Severity'), 'CRITICAL');
    await userEvent.click(screen.getByLabelText('Assigned to me'));
    expect(fake.callsTo('GET', '/incidents').at(-1)?.params).toEqual({
      projectId: 'proj-1',
      page: 1,
      pageSize: 20,
      status: 'ACTIVE',
      severity: 'CRITICAL',
      assigneeId: 'user-1',
    });
    expect(router.state.location.search).toBe('?severity=CRITICAL&assignee=me');

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'ALL');
    expect(fake.callsTo('GET', '/incidents').at(-1)?.params).not.toHaveProperty('status');
  });

  it('explains how incidents appear when there are none', async () => {
    api('VIEWER', { 'GET /incidents': [200, ok({ items: [], total: 0, page: 1, pageSize: 20 })] });
    renderApp('/projects/proj-1/incidents');
    expect(await screen.findByText('No active incidents')).toBeInTheDocument();
    expect(screen.getByText(/open automatically when an alert rule fires/)).toBeInTheDocument();
  });
});

describe('incident detail', () => {
  it('shows the timeline and alerts, read-only for viewers', async () => {
    api('VIEWER', {
      [`GET /incidents/${INCIDENT_ID}`]: [
        200,
        ok(
          detail({
            status: 'RESOLVED',
            firingAlerts: 0,
            resolvedAt: minutesAgo(10),
            events: [
              event('e1', 'DETECTED'),
              event('e2', 'ALERT_FIRED', { message: 'Error spike: Error rate 8.7%' }),
              event('e3', 'SEVERITY_CHANGED', { fromValue: 'HIGH', toValue: 'CRITICAL' }),
              event('e4', 'COMMENT', {
                actor: { id: 'user-2', name: 'Grace Hopper' },
                message: 'Rolled back the deploy.',
              }),
              event('e5', 'ALERT_RESOLVED', { message: 'Error spike: the condition cleared' }),
              event('e6', 'STATUS_CHANGED', { fromValue: 'OPEN', toValue: 'RESOLVED' }),
            ],
          }),
        ),
      ],
    });
    renderApp(`/projects/proj-1/incidents/${INCIDENT_ID}`);

    expect(await screen.findByRole('heading', { name: /#12 Orders health/ })).toBeInTheDocument();
    expect(screen.getByText(/lasted 20m/)).toBeInTheDocument();
    expect(screen.getByText(/automatically \(monitor recovered\)/)).toBeInTheDocument();

    const timeline = screen.getByRole('list', { name: 'Timeline' });
    expect(
      within(timeline)
        .getAllByTestId('timeline-event')
        .map((li) => li.querySelector('p:last-child')?.textContent),
    ).toEqual([
      'Incident detected',
      'Alert triggered: Error spike: Error rate 8.7%',
      'Severity changed from HIGH to CRITICAL (a more severe alert fired)',
      'Rolled back the deploy.',
      'Alert resolved: Error spike: the condition cleared',
      'Resolved automatically: the monitor recovered',
    ]);
    expect(within(timeline).getByText('Grace Hopper')).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Add a comment')).not.toBeInTheDocument();
  });

  it('acknowledges, assigns and comments', async () => {
    const fake = api('MEMBER', {
      [`PATCH /incidents/${INCIDENT_ID}`]: (config) => {
        const body = JSON.parse(config.data as string);
        if (body.status === 'ACKNOWLEDGED') {
          return [200, ok(detail({ status: 'ACKNOWLEDGED', acknowledgedAt: minutesAgo(0) }))];
        }
        return [
          200,
          ok(
            detail({
              status: 'ACKNOWLEDGED',
              assignee: { id: 'user-2', name: 'Grace Hopper' },
            }),
          ),
        ];
      },
      [`POST /incidents/${INCIDENT_ID}/events`]: (config) => [
        201,
        ok(
          event('e9', 'COMMENT', {
            actor: { id: 'user-1', name: 'Ada Lovelace' },
            message: JSON.parse(config.data as string).message,
            createdAt: new Date().toISOString(),
          }),
        ),
      ],
    });
    renderApp(`/projects/proj-1/incidents/${INCIDENT_ID}`);

    await userEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    expect(fake.callsTo('PATCH', `/incidents/${INCIDENT_ID}`)[0]?.body).toEqual({
      status: 'ACKNOWLEDGED',
    });
    expect(await screen.findByText('Acknowledged', { selector: 'dt' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();

    // Viewers cannot be assigned, so they are not offered.
    const assignee = screen.getByLabelText('Assignee');
    expect(within(assignee).queryByRole('option', { name: 'Vera Viewer' })).not.toBeInTheDocument();
    await userEvent.selectOptions(assignee, 'user-2');
    expect(fake.callsTo('PATCH', `/incidents/${INCIDENT_ID}`)[1]?.body).toEqual({
      assigneeId: 'user-2',
    });
    expect(await screen.findByText('Grace Hopper', { selector: 'dd' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(await screen.findByText('Write a comment')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Add a comment'), 'Looking into the database.');
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }));
    const timeline = screen.getByRole('list', { name: 'Timeline' });
    expect(await within(timeline).findByText('Looking into the database.')).toBeInTheDocument();
    expect(screen.getByLabelText('Add a comment')).toHaveValue('');
  });

  it('shows why a change was refused', async () => {
    api('ADMIN', {
      [`PATCH /incidents/${INCIDENT_ID}`]: [
        400,
        apiError('VALIDATION_ERROR', 'Viewers cannot be assigned incidents'),
      ],
    });
    renderApp(`/projects/proj-1/incidents/${INCIDENT_ID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Resolve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Viewers cannot be assigned incidents',
    );
  });
});

describe('dashboard', () => {
  it('shows active incidents across the workspace', async () => {
    const fake = api('VIEWER', {
      'GET /incidents': [
        200,
        ok({
          items: [
            summary(),
            summary({ id: 'other', number: 3, project: { id: 'p2', name: 'Payments' } }),
          ],
          total: 7,
          page: 1,
          pageSize: 5,
        }),
      ],
    });
    renderApp('/');

    const panel = await screen.findByRole('region', { name: /Active incidents/ });
    const rows = await within(panel).findAllByTestId('incident-row');
    expect(within(rows[1]!).getByText(/Payments · Orders health/)).toBeInTheDocument();
    expect(within(panel).getByText('7')).toBeInTheDocument();
    expect(within(panel).getByText(/Showing the 5 most recent of 7/)).toBeInTheDocument();
    expect(fake.callsTo('GET', '/incidents')[0]?.params).toEqual({
      workspaceId: 'ws-1',
      status: 'ACTIVE',
      pageSize: 5,
    });
  });
});
