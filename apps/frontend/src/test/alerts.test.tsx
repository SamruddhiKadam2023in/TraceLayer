import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import type {
  AlertRuleView,
  FiredAlertView,
  MonitorView,
  NotificationChannelView,
  ProjectView,
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

const MONITOR_ID = '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const CHANNEL_ID = '6b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e';
const OFF_CHANNEL_ID = '7c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f';
const RULE_ID = '8d4e5f6a-7b8c-4d9e-9f0a-2b3c4d5e6f7a';

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

const MONITOR: MonitorView = {
  id: MONITOR_ID,
  projectId: 'proj-1',
  name: 'Production health',
  endpointId: '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a',
  environmentId: '7f3e2a10-4b5c-4d6e-8f90-a1b2c3d4e5f6',
  type: 'STATUS',
  intervalSeconds: 300,
  timeoutMs: 4000,
  expectedStatus: 200,
  latencyThresholdMs: null,
  assertions: [],
  enabled: true,
  endpoint: {
    id: '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a',
    name: 'Health',
    method: 'GET',
    url: '/health',
  },
  environment: { id: '7f3e2a10-4b5c-4d6e-8f90-a1b2c3d4e5f6', name: 'Production' },
  lastRunAt: null,
  lastRunSuccess: null,
  consecutiveFailures: 0,
  health: 'NO_DATA',
  createdBy: null,
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
};

function channel(overrides: Partial<NotificationChannelView> = {}): NotificationChannelView {
  return {
    id: CHANNEL_ID,
    workspaceId: 'ws-1',
    name: 'On-call',
    type: 'EMAIL',
    config: { recipients: ['oncall@example.com'] },
    enabled: true,
    lastDelivery: null,
    createdAt: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
}

function rule(overrides: Partial<AlertRuleView> = {}): AlertRuleView {
  return {
    id: RULE_ID,
    projectId: 'proj-1',
    monitorId: MONITOR_ID,
    monitor: { id: MONITOR_ID, name: 'Production health' },
    name: 'Error spike',
    metric: 'ERROR_RATE',
    threshold: 5,
    durationMinutes: 10,
    severity: 'HIGH',
    enabled: true,
    channelIds: [CHANNEL_ID],
    state: 'FIRING',
    pendingSince: null,
    lastValue: 12.5,
    lastEvaluatedAt: new Date(Date.now() - 60_000).toISOString(),
    description: 'error rate > 5% over 10 min',
    createdAt: '2026-09-29T10:00:00.000Z',
    updatedAt: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
}

function api(role: WorkspaceRole, extra: Record<string, Handler | FakeResponse> = {}) {
  return installFakeApi({
    'POST /auth/refresh': [200, ok(makeSession())],
    'GET /workspaces': [200, ok([makeWorkspace({ role })])],
    'GET /workspaces/ws-1/members': [200, ok([])],
    'GET /projects/proj-1': [200, ok(PROJECT)],
    [`GET /monitors/${MONITOR_ID}`]: [200, ok(MONITOR)],
    [`GET /monitors/${MONITOR_ID}/runs`]: [200, ok([])],
    'GET /alerts': [200, ok([rule()])],
    'GET /notification-channels': [
      200,
      ok([
        channel(),
        channel({
          id: OFF_CHANNEL_ID,
          name: 'Archive',
          enabled: false,
          config: { recipients: ['old@example.com'] },
        }),
      ]),
    ],
    ...metricsHandlers(),
    ...extra,
  });
}

function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('alert rules on a monitor', () => {
  it('shows each rule with its state, condition and last observed value', async () => {
    const fake = api('VIEWER');
    renderApp(`/projects/proj-1/monitors/${MONITOR_ID}`);

    const row = await screen.findByTestId('rule-Error spike');
    expect(within(row).getByText('Firing')).toBeInTheDocument();
    expect(within(row).getByText('HIGH')).toBeInTheDocument();
    expect(
      within(row).getByText(/error rate > 5% over 10 min · notifies 1 channel/),
    ).toBeInTheDocument();
    expect(within(row).getByText('12.5%')).toBeInTheDocument();
    // Viewers can look but not change.
    expect(screen.queryByRole('button', { name: 'New rule' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Edit Error spike' })).not.toBeInTheDocument();
    expect(fake.callsTo('GET', '/alerts')[0]?.params).toEqual({ monitorId: MONITOR_ID });
  });

  it('creates a rule, hiding the duration for consecutive failures and preselecting enabled channels', async () => {
    const created = rule({
      id: '9e5f6a7b-8c9d-4e0f-8a1b-3c4d5e6f7a8b',
      name: 'Keeps failing',
      metric: 'CONSECUTIVE_FAILURES',
      threshold: 3,
      durationMinutes: 0,
      severity: 'CRITICAL',
      state: 'OK',
      lastValue: null,
      lastEvaluatedAt: null,
      description: '3 consecutive failed checks',
    });
    const fake = api('MEMBER', { 'POST /alerts': [201, ok(created)] });
    renderApp(`/projects/proj-1/monitors/${MONITOR_ID}`);

    await userEvent.click(await screen.findByRole('button', { name: 'New rule' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Keeps failing');
    await userEvent.selectOptions(within(dialog).getByLabelText('When'), 'CONSECUTIVE_FAILURES');
    expect(within(dialog).queryByLabelText(/minutes/)).not.toBeInTheDocument();
    const threshold = within(dialog).getByLabelText(/Threshold/);
    await userEvent.clear(threshold);
    await userEvent.type(threshold, '3');
    expect(within(dialog).getByText(/Fires when/)).toHaveTextContent('Consecutive failures > 3');
    await userEvent.selectOptions(within(dialog).getByLabelText('Severity'), 'CRITICAL');
    expect(within(dialog).getByRole('checkbox', { name: /On-call/ })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /Archive/ })).not.toBeChecked();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create rule' }));

    expect(await screen.findByTestId('rule-Keeps failing')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fake.callsTo('POST', '/alerts')[0]?.body).toEqual({
      monitorId: MONITOR_ID,
      name: 'Keeps failing',
      metric: 'CONSECUTIVE_FAILURES',
      threshold: 3,
      durationMinutes: 0,
      severity: 'CRITICAL',
      enabled: true,
      channelIds: [CHANNEL_ID],
    });
  });

  it('rejects an out-of-range threshold before calling the API', async () => {
    const fake = api('OWNER');
    renderApp(`/projects/proj-1/monitors/${MONITOR_ID}`);

    await userEvent.click(await screen.findByRole('button', { name: 'New rule' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Bad');
    await userEvent.selectOptions(within(dialog).getByLabelText('When'), 'UPTIME');
    const threshold = within(dialog).getByLabelText(/Threshold/);
    await userEvent.clear(threshold);
    await userEvent.type(threshold, '150');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create rule' }));

    expect(await within(dialog).findByText(/100/)).toBeInTheDocument();
    expect(fake.callsTo('POST', '/alerts')).toHaveLength(0);
  });

  it('edits and deletes a rule', async () => {
    const fake = api('ADMIN', {
      [`PATCH /alerts/${RULE_ID}`]: (config) => [
        200,
        ok(
          rule({
            ...JSON.parse(config.data as string),
            state: 'OK',
            description: 'error rate > 2% over 10 min',
          }),
        ),
      ],
      [`DELETE /alerts/${RULE_ID}`]: [204, null],
    });
    renderApp(`/projects/proj-1/monitors/${MONITOR_ID}`);

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Error spike' }));
    const dialog = await screen.findByRole('dialog');
    const threshold = within(dialog).getByLabelText(/Threshold/);
    await userEvent.clear(threshold);
    await userEvent.type(threshold, '2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    const row = await screen.findByTestId('rule-Error spike');
    expect(await within(row).findByText('OK')).toBeInTheDocument();
    expect(fake.callsTo('PATCH', `/alerts/${RULE_ID}`)[0]?.body).toMatchObject({ threshold: 2 });

    await userEvent.click(within(row).getByRole('button', { name: 'Delete Error spike' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete rule' }));
    expect(await screen.findByText(/No alert rules/)).toBeInTheDocument();
  });
});

describe('project alerts', () => {
  const firing: FiredAlertView = {
    id: 'a1',
    rule: { id: RULE_ID, name: 'Error spike' },
    monitor: { id: MONITOR_ID, name: 'Production health' },
    severity: 'HIGH',
    status: 'FIRING',
    value: 12.5,
    threshold: 5,
    message: 'Error rate is 12.5% (threshold 5%)',
    firedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    resolvedAt: null,
  };
  const resolved: FiredAlertView = {
    ...firing,
    id: 'a2',
    rule: null,
    status: 'RESOLVED',
    severity: 'LOW',
    message: 'Old breach',
    firedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    resolvedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  };

  it('lists firing alerts first with links to their monitors', async () => {
    const fake = api('VIEWER', { 'GET /alerts/fired': [200, ok([firing, resolved])] });
    renderApp('/projects/proj-1/alerts');

    expect(await screen.findByText('1 alert firing.')).toBeInTheDocument();
    const [first, second] = screen.getAllByTestId('alert-row');
    expect(within(first!).getByText('Firing')).toBeInTheDocument();
    expect(within(first!).getByText('Error rate is 12.5% (threshold 5%)')).toBeInTheDocument();
    expect(within(first!).getByRole('link', { name: 'Production health' })).toHaveAttribute(
      'href',
      `/projects/proj-1/monitors/${MONITOR_ID}`,
    );
    expect(within(second!).getByText('Resolved')).toBeInTheDocument();
    expect(within(second!).getByText(/deleted rule/)).toBeInTheDocument();
    expect(within(second!).getByText(/lasted 1h/)).toBeInTheDocument();
    expect(fake.callsTo('GET', '/alerts/fired')[0]?.params).toEqual({ projectId: 'proj-1' });
  });

  it('explains the empty state', async () => {
    api('VIEWER', { 'GET /alerts/fired': [200, ok([])] });
    renderApp('/projects/proj-1/alerts');
    expect(await screen.findByText('No alerts yet')).toBeInTheDocument();
  });
});

describe('notification channels', () => {
  it('adds an email channel from a list of recipients', async () => {
    const fake = api('OWNER', {
      'GET /notification-channels': [200, ok([])],
      'POST /notification-channels': (config) => [
        201,
        ok(channel({ name: 'Platform', config: JSON.parse(config.data as string).config })),
      ],
    });
    renderApp('/settings');

    await userEvent.click(await screen.findByRole('button', { name: 'Add email channel' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Platform');
    await userEvent.type(within(dialog).getByLabelText('Recipients'), 'not-an-email');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add channel' }));
    expect(await within(dialog).findByText('Check the email addresses')).toBeInTheDocument();
    expect(fake.callsTo('POST', '/notification-channels')).toHaveLength(0);

    await userEvent.clear(within(dialog).getByLabelText('Recipients'));
    await userEvent.type(
      within(dialog).getByLabelText('Recipients'),
      'a@example.com, b@example.com',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add channel' }));

    const row = await screen.findByTestId('channel-Platform');
    expect(within(row).getByText('a@example.com, b@example.com')).toBeInTheDocument();
    expect(fake.callsTo('POST', '/notification-channels')[0]?.body).toEqual({
      workspaceId: 'ws-1',
      name: 'Platform',
      type: 'EMAIL',
      config: { recipients: ['a@example.com', 'b@example.com'] },
    });
  });

  it('sends a test and reports queue failures', async () => {
    let attempt = 0;
    const fake = api('ADMIN', {
      [`POST /notification-channels/${CHANNEL_ID}/test`]: () =>
        ++attempt === 1
          ? [202, ok({ queued: true })]
          : [
              502,
              apiError('NOTIFICATION_QUEUE_UNAVAILABLE', 'Could not queue the test notification'),
            ],
    });
    renderApp('/settings');

    await userEvent.click(await screen.findByRole('button', { name: 'Send test to On-call' }));
    expect(await screen.findByText('Test notification queued for On-call.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send test to On-call' }));
    expect(await screen.findByText('Could not queue the test notification')).toBeInTheDocument();
    expect(fake.callsTo('POST', `/notification-channels/${CHANNEL_ID}/test`)).toHaveLength(2);
  });

  it('shows the last delivery and is read-only for members', async () => {
    api('MEMBER', {
      'GET /notification-channels': [
        200,
        ok([
          channel({
            lastDelivery: { status: 'FAILED', at: new Date().toISOString(), error: 'ECONNREFUSED' },
          }),
        ]),
      ],
    });
    renderApp('/settings');

    const row = await screen.findByTestId('channel-On-call');
    expect(within(row).getByText('Failed')).toBeInTheDocument();
    expect(
      within(row).queryByRole('button', { name: 'Send test to On-call' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add email channel' })).not.toBeInTheDocument();
  });
});
