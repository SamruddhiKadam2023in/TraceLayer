import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { EndpointView, EnvironmentView, ProjectView, WorkspaceRole } from '@tracelayer/shared';
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

// Real UUIDs: the form validates ids exactly as the API does.
const ENV_ID = '7f3e2a10-4b5c-4d6e-8f90-a1b2c3d4e5f6';

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

const PRODUCTION: EnvironmentView = {
  id: ENV_ID,
  projectId: 'proj-1',
  name: 'Production',
  baseUrl: 'https://api.example.com',
  variables: [
    {
      id: 'v1',
      key: 'API_TOKEN',
      isSecret: true,
      value: null,
      updatedAt: '2026-09-29T10:00:00.000Z',
    },
  ],
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
};

function endpoint(overrides: Partial<EndpointView> = {}): EndpointView {
  return {
    id: 'ep-1',
    projectId: 'proj-1',
    name: 'List orders',
    description: null,
    method: 'GET',
    url: '/orders',
    environmentId: ENV_ID,
    headers: [],
    queryParams: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    timeoutMs: 10000,
    expectedStatus: null,
    tags: ['orders'],
    createdBy: null,
    createdAt: '2026-09-29T10:00:00.000Z',
    updatedAt: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
}

const ENDPOINTS = [
  endpoint(),
  endpoint({ id: 'ep-2', name: 'Create order', method: 'POST', tags: ['orders', 'write'] }),
  endpoint({ id: 'ep-3', name: 'Health', url: '/health', tags: [], environmentId: null }),
];

function api(role: WorkspaceRole, extra: Record<string, Handler | FakeResponse> = {}) {
  return installFakeApi({
    'POST /auth/refresh': [200, ok(makeSession())],
    'GET /workspaces': [200, ok([makeWorkspace({ role })])],
    'GET /projects/proj-1': [200, ok(PROJECT)],
    'GET /projects/proj-1/environments': [200, ok([PRODUCTION])],
    'GET /endpoints': [200, ok(ENDPOINTS)],
    'GET /endpoints/ep-1': [200, ok(ENDPOINTS[0])],
    ...extra,
  });
}

function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('endpoint list', () => {
  it('offers a first endpoint to members, not viewers', async () => {
    api('MEMBER', { 'GET /endpoints': [200, ok([])] });
    renderApp('/projects/proj-1/endpoints');
    expect(await screen.findByText('No endpoints yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New endpoint' })).toBeInTheDocument();
  });

  it('hides the create action from viewers', async () => {
    api('VIEWER', { 'GET /endpoints': [200, ok([])] });
    renderApp('/projects/proj-1/endpoints');
    expect(await screen.findByText(/Endpoints added by your team/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New endpoint' })).not.toBeInTheDocument();
  });

  it('filters by search text, method and tag', async () => {
    api('OWNER');
    renderApp('/projects/proj-1/endpoints');
    const list = await screen.findByRole('list', { name: 'Endpoints' });
    const names = () =>
      within(list)
        .queryAllByRole('link')
        .map((l) => within(l).getAllByText(/.+/)[1]?.textContent);

    expect(names()).toEqual(['List orders', 'Create order', 'Health']);

    await userEvent.selectOptions(screen.getByLabelText('Method'), 'POST');
    expect(names()).toEqual(['Create order']);

    await userEvent.selectOptions(screen.getByLabelText('Method'), '');
    await userEvent.selectOptions(screen.getByLabelText('Tag'), 'orders');
    expect(names()).toEqual(['List orders', 'Create order']);

    await userEvent.selectOptions(screen.getByLabelText('Tag'), '');
    await userEvent.type(screen.getByLabelText('Search endpoints'), 'health');
    expect(names()).toEqual(['Health']);

    await userEvent.type(screen.getByLabelText('Search endpoints'), 'zzz');
    expect(screen.getByText('No endpoints match these filters.')).toBeInTheDocument();
  });
});

describe('creating an endpoint', () => {
  it('saves method, URL, headers, body and auth, then opens the endpoint', async () => {
    const created = endpoint({ id: 'ep-new', name: 'Create order', method: 'POST' });
    const fake = api('MEMBER', {
      'POST /endpoints': [201, ok(created)],
      'GET /endpoints/ep-new': [200, ok(created)],
    });
    const router = renderApp('/projects/proj-1/endpoints/new');

    await userEvent.type(await screen.findByLabelText('Name'), 'Create order');
    await userEvent.selectOptions(screen.getByLabelText('Method'), 'POST');
    await userEvent.type(screen.getByLabelText('URL'), '/orders');
    // The relative path is previewed against the default environment's base URL.
    expect(screen.getByText('Production: https://api.example.com/orders')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /Headers/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Add header' }));
    await userEvent.type(screen.getByLabelText('Header 1 name'), 'Content-Type');
    await userEvent.type(screen.getByLabelText('Header 1 value'), 'application/json');

    await userEvent.click(screen.getByRole('tab', { name: /Body/ }));
    await userEvent.selectOptions(screen.getByLabelText('Body type'), 'json');
    const json = screen.getByLabelText('JSON');
    await userEvent.clear(json);
    await userEvent.type(json, '{{"sku": "{{{{SKU}}"}');

    await userEvent.click(screen.getByRole('tab', { name: /Auth/ }));
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'bearer');
    await userEvent.type(screen.getByLabelText('Token'), '{{{{API_TOKEN}}');

    // The variable panel reports SKU as missing from Production; API_TOKEN is defined.
    expect(screen.getByText(/Not defined in Production: SKU/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Create endpoint' }));

    expect(await screen.findByRole('heading', { name: 'Create order' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/projects/proj-1/endpoints/ep-new');
    expect(fake.callsTo('POST', '/endpoints')[0]?.body).toMatchObject({
      projectId: 'proj-1',
      name: 'Create order',
      method: 'POST',
      url: '/orders',
      environmentId: ENV_ID,
      headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
      body: { type: 'json', content: '{"sku": "{{SKU}}"}' },
      auth: { type: 'bearer', token: '{{API_TOKEN}}' },
    });
  });

  it('refuses a literal credential and flags the tab that has the problem', async () => {
    const fake = api('OWNER');
    renderApp('/projects/proj-1/endpoints/new');

    await userEvent.type(await screen.findByLabelText('Name'), 'Secret leak');
    await userEvent.type(screen.getByLabelText('URL'), '/orders');
    await userEvent.click(screen.getByRole('tab', { name: /Auth/ }));
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'bearer');
    await userEvent.type(screen.getByLabelText('Token'), 'sk_live_123');
    await userEvent.click(screen.getByRole('tab', { name: /Params/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create endpoint' }));

    const authTab = screen.getByRole('tab', { name: /Auth/ });
    expect(await within(authTab).findByLabelText('has errors')).toBeInTheDocument();
    await userEvent.click(authTab);
    expect(screen.getByText('Reference a variable, e.g. {{API_TOKEN}}')).toBeInTheDocument();
    expect(fake.callsTo('POST', '/endpoints')).toHaveLength(0);
  });

  it('lists referenced variables while the form is still incomplete', async () => {
    api('OWNER');
    renderApp('/projects/proj-1/endpoints/new');

    // No name yet, so the form as a whole is invalid; the variable check still works.
    await userEvent.type(await screen.findByLabelText('URL'), '/orders/{{{{ORDER_ID}}');
    expect(screen.getByText('ORDER_ID')).toBeInTheDocument();
    expect(screen.getByText(/Not defined in Production: ORDER_ID/)).toBeInTheDocument();
  });

  it('shows a server-side name conflict on the name field', async () => {
    api('OWNER', {
      'POST /endpoints': [
        409,
        apiError('CONFLICT', 'An endpoint with this name already exists', [
          { path: 'name', message: 'An endpoint with this name already exists' },
        ]),
      ],
    });
    renderApp('/projects/proj-1/endpoints/new');

    await userEvent.type(await screen.findByLabelText('Name'), 'List orders');
    await userEvent.type(screen.getByLabelText('URL'), '/orders');
    await userEvent.click(screen.getByRole('button', { name: 'Create endpoint' }));

    expect(
      await screen.findByText('An endpoint with this name already exists'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('endpoint detail', () => {
  it('is read-only for viewers', async () => {
    api('VIEWER');
    renderApp('/projects/proj-1/endpoints/ep-1');

    expect(await screen.findByRole('heading', { name: 'List orders' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.getByLabelText('URL')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete endpoint' })).not.toBeInTheDocument();
  });

  it('saves only after a change, sending the edited configuration', async () => {
    const fake = api('MEMBER', {
      'PATCH /endpoints/ep-1': [
        200,
        ok(endpoint({ url: '/v2/orders', updatedAt: '2026-09-30T10:00:00.000Z' })),
      ],
    });
    renderApp('/projects/proj-1/endpoints/ep-1');

    const save = await screen.findByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();
    const url = screen.getByLabelText('URL');
    await userEvent.clear(url);
    await userEvent.type(url, '/v2/orders');
    await userEvent.click(save);

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(fake.callsTo('PATCH', '/endpoints/ep-1')[0]?.body).toMatchObject({ url: '/v2/orders' });
  });

  it('moves between tabs with the arrow keys', async () => {
    api('OWNER');
    renderApp('/projects/proj-1/endpoints/ep-1');

    const params = await screen.findByRole('tab', { name: /Params/ });
    params.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /Headers/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Headers/ })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: /Settings/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('deletes after confirmation and returns to the list', async () => {
    const fake = api('OWNER', { 'DELETE /endpoints/ep-1': [204, ''] });
    const router = renderApp('/projects/proj-1/endpoints/ep-1');

    await userEvent.click(await screen.findByRole('button', { name: 'Delete endpoint' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete endpoint' }),
    );

    expect(await screen.findByRole('list', { name: 'Endpoints' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/projects/proj-1/endpoints');
    expect(fake.callsTo('DELETE', '/endpoints/ep-1')).toHaveLength(1);
  });

  it('shows "not found" for a missing endpoint', async () => {
    api('OWNER', { 'GET /endpoints/ep-1': [404, apiError('NOT_FOUND', 'Endpoint not found')] });
    renderApp('/projects/proj-1/endpoints/ep-1');
    expect(await screen.findByText('Endpoint not found')).toBeInTheDocument();
  });
});
