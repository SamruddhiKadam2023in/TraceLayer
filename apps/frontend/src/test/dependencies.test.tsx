import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import type {
  DependencyMapView,
  DependencyNodeView,
  ProjectView,
  WorkspaceRole,
} from '@tracelayer/shared';
import { routes } from '@/routes/router';
import {
  apiError,
  installFakeApi,
  makeSession,
  makeWorkspace,
  ok,
  type FakeResponse,
  type Handler,
} from './fake-api';
import { latestSocket } from './fake-socket';

const PROJECT_ID = '99999999-9999-4999-8999-999999999999';

const PROJECT: ProjectView = {
  id: PROJECT_ID,
  workspaceId: 'ws-1',
  name: 'Orders API',
  description: null,
  createdBy: null,
  environmentCount: 1,
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
};

const GATEWAY = '11111111-1111-4111-8111-111111111111';
const ORDERS = '22222222-2222-4222-8222-222222222222';
const EDGE = '33333333-3333-4333-8333-333333333333';

const node = (id: string, label: string, extra: Partial<DependencyNodeView> = {}) => ({
  id,
  label,
  kind: 'SERVICE' as const,
  origin: 'MANUAL' as const,
  host: null,
  x: 0,
  y: 0,
  health: null,
  monitorCount: 0,
  ...extra,
});

const MAP: DependencyMapView = {
  projectId: PROJECT_ID,
  version: 3,
  nodes: [
    node(GATEWAY, 'API Gateway', { kind: 'GATEWAY' }),
    node(ORDERS, 'Orders', { host: 'api.example.com', y: 160, health: 'FAILING', monitorCount: 2 }),
  ],
  edges: [{ id: EDGE, sourceId: GATEWAY, targetId: ORDERS, origin: 'MANUAL', label: null }],
};

function api(role: WorkspaceRole, extra: Record<string, Handler | FakeResponse> = {}) {
  return installFakeApi({
    'POST /auth/refresh': [200, ok(makeSession())],
    'GET /workspaces': [200, ok([makeWorkspace({ role })])],
    [`GET /projects/${PROJECT_ID}`]: [200, ok(PROJECT)],
    'GET /dependencies': [200, ok(MAP)],
    ...extra,
  });
}

function renderApp() {
  const router = createMemoryRouter(routes, {
    initialEntries: [`/projects/${PROJECT_ID}/dependencies`],
  });
  render(<RouterProvider router={router} />);
}

const details = () => screen.getByRole('complementary', { name: 'Map details' });

describe('dependency map', () => {
  it('shows nodes with health, and connections labelled manual or inferred, read-only for viewers', async () => {
    api('VIEWER', {
      'GET /dependencies': [
        200,
        ok({
          ...MAP,
          nodes: [
            ...MAP.nodes,
            node('44444444-4444-4444-8444-444444444444', 'pay.example.com', {
              origin: 'INFERRED',
              y: 320,
            }),
          ],
          edges: [
            ...MAP.edges,
            {
              id: '55555555-5555-4555-8555-555555555555',
              sourceId: GATEWAY,
              targetId: '44444444-4444-4444-8444-444444444444',
              origin: 'INFERRED',
              label: null,
            },
          ],
        }),
      ],
    });
    renderApp();

    expect(
      await within(await screen.findByRole('complementary', { name: 'Map details' })).findByText(
        'Nodes (3)',
      ),
    ).toBeInTheDocument();
    const connections = within(details()).getByRole('list', { name: 'Connections' });
    const rows = within(connections).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      'API Gateway → OrdersManual',
      'API Gateway → pay.example.comInferred',
    ]);
    expect(within(details()).getByText('(inferred)')).toBeInTheDocument();

    // The canvas draws the nodes, with health spelled out.
    const orders = await screen.findByTestId('map-node-Orders');
    expect(within(orders).getByText(/Failing · 2 monitors/)).toBeInTheDocument();
    expect(
      within(await screen.findByTestId('map-node-pay.example.com')).getByText('Inferred'),
    ).toBeInTheDocument();

    // Viewers can inspect but not edit.
    await userEvent.click(within(details()).getByRole('button', { name: 'Orders' }));
    expect(within(details()).getByText('api.example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add node' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove node' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Legend')).toHaveTextContent('Manual');
    expect(screen.getByLabelText('Legend')).toHaveTextContent('Inferred');
  });

  it('adds, renames, connects and removes nodes, then saves the whole diagram', async () => {
    const fake = api('MEMBER', {
      'PUT /dependencies': (config) => {
        const body = JSON.parse(config.data as string);
        return [
          200,
          ok({
            projectId: PROJECT_ID,
            version: 4,
            nodes: body.nodes.map((n: object) => ({ ...n, health: null, monitorCount: 0 })),
            edges: body.edges,
          }),
        ];
      },
    });
    renderApp();
    const save = await screen.findByRole('button', { name: 'Save map' });
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Add node' }));
    const selected = within(details()).getByRole('region', { name: /Selected node/ });
    const name = within(selected).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Orders DB');
    await userEvent.selectOptions(within(selected).getByLabelText('Kind'), 'DATABASE');

    await userEvent.selectOptions(within(details()).getByLabelText('From (depends on…)'), ORDERS);
    const to = within(details()).getByLabelText('To');
    const dbOption = within(to).getByRole('option', { name: 'Orders DB' }) as HTMLOptionElement;
    await userEvent.selectOptions(to, dbOption.value);
    await userEvent.click(within(details()).getByRole('button', { name: 'Connect' }));
    // Connecting twice is refused.
    await userEvent.click(within(details()).getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('These nodes are already connected.')).toBeInTheDocument();

    await userEvent.click(within(details()).getByRole('button', { name: 'API Gateway' }));
    await userEvent.click(within(details()).getByRole('button', { name: 'Remove node' }));

    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save map' }));
    await waitFor(() => expect(fake.callsTo('PUT', '/dependencies')).toHaveLength(1));
    const body = fake.callsTo('PUT', '/dependencies')[0]!.body as {
      version: number;
      nodes: { id: string; label: string; kind: string; origin: string }[];
      edges: { sourceId: string; targetId: string; origin: string }[];
    };
    expect(body.version).toBe(3);
    expect(body.nodes.map((n) => [n.label, n.kind, n.origin])).toEqual([
      ['Orders', 'SERVICE', 'MANUAL'],
      ['Orders DB', 'DATABASE', 'MANUAL'],
    ]);
    // Removing the gateway removed its connection; the new one is manual.
    expect(body.edges).toEqual([
      expect.objectContaining({ sourceId: ORDERS, targetId: dbOption.value, origin: 'MANUAL' }),
    ]);
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('merges detected dependencies as inferred, unsaved additions', async () => {
    const CLIENTS = '66666666-6666-4666-8666-666666666666';
    const PAY = '77777777-7777-4777-8777-777777777777';
    api('OWNER', {
      'GET /dependencies/suggestions': [
        200,
        ok({
          nodes: [
            node(PAY, 'pay.example.com', { origin: 'INFERRED', host: 'pay.example.com', y: 320 }),
          ],
          edges: [
            { id: CLIENTS, sourceId: GATEWAY, targetId: PAY, origin: 'INFERRED', label: null },
          ],
        }),
      ],
    });
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Detect dependencies' }));
    expect(
      await screen.findByText('Added 1 inferred node and 1 connection. Review them, then save.'),
    ).toBeInTheDocument();
    expect(within(details()).getByText('Nodes (3)')).toBeInTheDocument();
    expect(within(details()).getByText('API Gateway → pay.example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save map' })).toBeEnabled();
  });

  it('says when there is nothing to detect', async () => {
    api('OWNER', { 'GET /dependencies/suggestions': [200, ok({ nodes: [], edges: [] })] });
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Detect dependencies' }));
    expect(await screen.findByText(/Nothing new to suggest/)).toBeInTheDocument();
  });

  it('checks names before saving, and offers a reload when someone else saved first', async () => {
    let reloads = 0;
    const fake = api('ADMIN', {
      'GET /dependencies': () => [200, ok({ ...MAP, version: 3 + reloads++ })],
      'PUT /dependencies': [
        409,
        apiError(
          'CONFLICT',
          'Someone else saved this map since you opened it. Reload to see their changes.',
        ),
      ],
    });
    renderApp();
    await userEvent.click(
      await within(await screen.findByRole('complementary', { name: 'Map details' })).findByRole(
        'button',
        { name: 'Orders' },
      ),
    );
    const name = within(details()).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.click(screen.getByRole('button', { name: 'Save map' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Name the node (unnamed node)');
    expect(fake.callsTo('PUT', '/dependencies')).toHaveLength(0);

    await userEvent.type(name, 'Orders v2');
    await userEvent.click(screen.getByRole('button', { name: 'Save map' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Someone else saved/);
    await userEvent.click(screen.getByRole('button', { name: 'Reload map' }));
    // The editor starts over from the latest saved map.
    expect(await within(details()).findByRole('button', { name: 'Orders' })).toBeInTheDocument();
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('refreshes node health when a monitor’s health changes', async () => {
    let calls = 0;
    const fake = api('VIEWER', {
      'GET /dependencies': () => {
        calls++;
        return [
          200,
          ok({
            ...MAP,
            nodes: MAP.nodes.map((n) =>
              n.id === ORDERS ? { ...n, health: calls > 1 ? 'HEALTHY' : 'FAILING' } : n,
            ),
          }),
        ];
      },
    });
    renderApp();
    expect(
      within(await screen.findByTestId('map-node-Orders')).getByText(/Failing/),
    ).toBeInTheDocument();

    const socket = latestSocket();
    act(() => socket.serverAccept());
    act(() =>
      socket.serverEmit('monitor.status_changed', {
        workspaceId: 'ws-1',
        projectId: PROJECT_ID,
        monitor: { id: 'm', name: 'Orders' },
        run: {
          id: 'r',
          startedAt: '',
          success: true,
          statusCode: 200,
          durationMs: 1,
          failureReason: null,
        },
        health: 'HEALTHY',
        previousHealth: 'FAILING',
      }),
    );
    await waitFor(() => expect(fake.callsTo('GET', '/dependencies').length).toBe(2));
    expect(
      within(await screen.findByTestId('map-node-Orders')).getByText(/Healthy/),
    ).toBeInTheDocument();
  });
});
