import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/routes/router';
import { installFakeApi, makeSession, makeWorkspace, metricsHandlers, ok } from './fake-api';

function renderDashboard(workspaces: ReturnType<typeof makeWorkspace>[]) {
  installFakeApi({
    'POST /auth/refresh': [200, ok(makeSession())],
    'GET /workspaces': [200, ok(workspaces)],
    'GET /incidents': [200, ok({ items: [], total: 0, page: 1, pageSize: 5 })],
    ...metricsHandlers(),
  });
  render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/'] })} />);
}

describe('demo data', () => {
  it('labels a demo workspace on every page and in the switcher', async () => {
    renderDashboard([
      makeWorkspace({ id: 'ws-1', name: 'Demo Workspace', isDemo: true }),
      makeWorkspace({ id: 'ws-2', name: 'Acme' }),
    ]);

    const banner = await screen.findByRole('note', { name: 'Demo workspace' });
    expect(banner).toHaveTextContent(/generated for exploring TraceLayer, not measured/);
    const switcher = screen.getByRole('button', {
      name: /Current workspace: Demo Workspace \(demo\)/,
    });
    expect(within(switcher).getByText('Demo')).toBeInTheDocument();

    await userEvent.click(switcher);
    const options = screen.getAllByRole('button').filter((b) => b.closest('ul'));
    const demoOption = options.find((b) => b.textContent?.includes('Demo Workspace'));
    const realOption = options.find((b) => b.textContent?.includes('Acme'));
    expect(demoOption).toHaveTextContent('Demo');
    expect(realOption).not.toHaveTextContent('Demo');
  });

  it('shows nothing of the sort for real workspaces', async () => {
    renderDashboard([makeWorkspace({ name: 'Acme' })]);
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('note', { name: 'Demo workspace' })).not.toBeInTheDocument();
  });
});
