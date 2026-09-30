import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { IncidentSummary } from '@tracelayer/shared';
import { routes } from '@/routes/router';
import {
  apiError,
  installFakeApi,
  makeSession,
  makeWorkspace,
  metricsHandlers,
  ok,
} from './fake-api';

const UNAUTHENTICATED = [401, apiError('UNAUTHENTICATED', 'No session')] as const;

function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('landing page', () => {
  it('greets signed-out visitors at the root, with the way in and the demo', async () => {
    installFakeApi({ 'POST /auth/refresh': [...UNAUTHENTICATED] });
    const router = renderApp('/');

    expect(
      await screen.findByRole('heading', { level: 1, name: /Know when your APIs fail/ }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/welcome');
    expect(screen.getAllByRole('link', { name: /Get started/ })[0]).toHaveAttribute(
      'href',
      '/register',
    );
    expect(screen.getByRole('link', { name: 'View demo' })).toHaveAttribute('href', '#demo');
    for (const feature of [
      'API monitoring',
      'Performance analytics',
      'Incident detection',
      'Real-time alerts',
      'Dependency mapping',
    ]) {
      expect(screen.getByRole('heading', { level: 3, name: feature })).toBeInTheDocument();
    }
    // Both preview images describe the real dashboard; only the one for the theme shows.
    expect(screen.getAllByRole('img', { name: /TraceLayer dashboard/ })).toHaveLength(2);

    const footer = screen.getByRole('navigation', { name: 'Footer' });
    await userEvent.click(within(footer).getByRole('link', { name: 'Privacy' }));
    expect(await screen.findByRole('heading', { name: 'Privacy' })).toBeInTheDocument();
    expect(screen.getByText(/No analytics, tracking or third-party scripts/)).toBeInTheDocument();
  });

  it('still sends signed-out visitors of deeper pages to sign in', async () => {
    installFakeApi({ 'POST /auth/refresh': [...UNAUTHENTICATED] });
    const router = renderApp('/projects');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('offers signed-in people their dashboard instead of sign-up', async () => {
    installFakeApi({
      'POST /auth/refresh': [200, ok(makeSession())],
      'GET /workspaces': [200, ok([makeWorkspace()])],
    });
    renderApp('/welcome');
    expect(await screen.findByRole('link', { name: 'Open dashboard' })).toHaveAttribute(
      'href',
      '/',
    );
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
  });
});

describe('workspace incidents', () => {
  it('lists incidents of every project, with the project on each row', async () => {
    const incident: IncidentSummary = {
      id: 'inc-1',
      projectId: 'proj-9',
      number: 4,
      title: 'Charges API: Consecutive failures 2',
      severity: 'CRITICAL',
      status: 'INVESTIGATING',
      project: { id: 'proj-9', name: 'Payment API' },
      monitor: { id: 'm', name: 'Charges API' },
      assignee: null,
      firingAlerts: 1,
      detectedAt: new Date().toISOString(),
      acknowledgedAt: null,
      resolvedAt: null,
      resolvedBy: null,
    };
    const fake = installFakeApi({
      'POST /auth/refresh': [200, ok(makeSession())],
      'GET /workspaces': [200, ok([makeWorkspace()])],
      'GET /incidents': [200, ok({ items: [incident], total: 1, page: 1, pageSize: 20 })],
      ...metricsHandlers(),
    });
    renderApp('/incidents');

    const row = await screen.findByTestId('incident-row');
    expect(row).toHaveTextContent('Payment API · Charges API');
    expect(within(row).getByRole('link')).toHaveAttribute(
      'href',
      '/projects/proj-9/incidents/inc-1',
    );
    expect(fake.callsTo('GET', '/incidents')[0]?.params).toMatchObject({
      workspaceId: 'ws-1',
      status: 'ACTIVE',
    });
    expect(screen.getByRole('link', { name: 'Incidents' })).toHaveAttribute('aria-current', 'page');
  });
});
