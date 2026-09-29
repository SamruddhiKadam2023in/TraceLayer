import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import type {
  EnvironmentVariableView,
  EnvironmentView,
  ProjectView,
  WorkspaceRole,
} from '@tracelayer/shared';
import { routes } from '@/routes/router';
import { useWorkspaceStore } from '@/stores/workspace.store';
import {
  apiError,
  installFakeApi,
  makeSession,
  makeWorkspace,
  ok,
  type FakeResponse,
  type Handler,
} from './fake-api';

const PROJECT: ProjectView = {
  id: 'proj-1',
  workspaceId: 'ws-1',
  name: 'Payments API',
  description: 'Card processing',
  createdBy: { id: 'user-1', name: 'Ada Lovelace' },
  environmentCount: 2,
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
};

function variable(key: string, value: string | null, isSecret = false): EnvironmentVariableView {
  return { id: `var-${key}`, key, value, isSecret, updatedAt: '2026-09-29T10:00:00.000Z' };
}

function environment(
  name: string,
  baseUrl: string | null,
  variables: EnvironmentVariableView[] = [],
): EnvironmentView {
  return {
    id: `env-${name.toLowerCase()}`,
    projectId: PROJECT.id,
    name,
    baseUrl,
    variables,
    createdAt: '2026-09-29T10:00:00.000Z',
    updatedAt: '2026-09-29T10:00:00.000Z',
  };
}

const ENVIRONMENTS = [
  environment('Development', null),
  environment('Production', 'https://api.example.com', [
    variable('API_KEY', null, true),
    variable('CLIENT_ID', 'web-app'),
  ]),
];

function api(role: WorkspaceRole, extra: Record<string, Handler | FakeResponse> = {}) {
  return installFakeApi({
    'POST /auth/refresh': [200, ok(makeSession())],
    'GET /workspaces': [200, ok([makeWorkspace({ role })])],
    'GET /projects': [200, ok([PROJECT])],
    'GET /projects/proj-1': [200, ok(PROJECT)],
    'GET /projects/proj-1/environments': [200, ok(ENVIRONMENTS)],
    ...extra,
  });
}

function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('projects list', () => {
  it('shows an empty state with a create button for managers only', async () => {
    api('OWNER', { 'GET /projects': [200, ok([])] });
    renderApp('/projects');
    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument();
  });

  it('tells members who can create projects instead of offering a button', async () => {
    api('MEMBER', { 'GET /projects': [200, ok([])] });
    renderApp('/projects');
    expect(await screen.findByText(/Owners and admins of this workspace/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();
  });

  it('creates a project in the current workspace and opens it', async () => {
    const fake = api('ADMIN', {
      'GET /projects': [200, ok([])],
      'POST /projects': [201, ok(PROJECT)],
    });
    const router = renderApp('/projects');

    await userEvent.click(await screen.findByRole('button', { name: 'New project' }));
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    await userEvent.type(within(dialog).getByLabelText('Project name'), 'Payments API');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));

    expect(
      await screen.findByRole('heading', { name: 'Payments API', level: 1 }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/projects/proj-1');
    expect(fake.callsTo('POST', '/projects')[0]?.body).toEqual({
      workspaceId: 'ws-1',
      name: 'Payments API',
      description: null,
    });
  });

  it('shows a duplicate name on the name field', async () => {
    api('OWNER', {
      'POST /projects': [
        409,
        apiError('CONFLICT', 'A project with this name already exists in the workspace', [
          { path: 'name', message: 'A project with this name already exists in the workspace' },
        ]),
      ],
    });
    renderApp('/projects');

    await userEvent.click(await screen.findByRole('button', { name: 'New project' }));
    await userEvent.type(screen.getByLabelText('Project name'), 'Payments API');
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByText(/already exists in the workspace/)).toBeInTheDocument();
    expect(screen.getByLabelText('Project name')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('project page', () => {
  it('shows the overview from real data, flagging environments without a base URL', async () => {
    api('OWNER');
    renderApp('/projects/proj-1');

    expect(
      await screen.findByRole('heading', { name: 'Payments API', level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByText('https://api.example.com')).toBeInTheDocument();
    expect(screen.getByText(/1 environment has no base URL yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  });

  it('shows "not found" for a project the user cannot see', async () => {
    api('OWNER', { 'GET /projects/proj-1': [404, apiError('NOT_FOUND', 'Project not found')] });
    renderApp('/projects/proj-1');
    expect(await screen.findByText('Project not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to projects' })).toBeInTheDocument();
  });

  it('switches to the project’s workspace when opened from another workspace', async () => {
    api('OWNER', {
      'GET /workspaces': [
        200,
        ok([
          makeWorkspace({ id: 'ws-1', name: 'Acme' }),
          makeWorkspace({ id: 'ws-2', name: 'Beta' }),
        ]),
      ],
    });
    useWorkspaceStore.setState({ currentId: 'ws-2' });
    renderApp('/projects/proj-1');

    await screen.findByRole('heading', { name: 'Payments API', level: 1 });
    expect(useWorkspaceStore.getState().currentId).toBe('ws-1');
    expect(screen.getByRole('button', { name: /Current workspace: Acme/ })).toBeInTheDocument();
  });

  it('returns to the project list when the user switches workspace', async () => {
    api('OWNER', {
      'GET /workspaces': [
        200,
        ok([
          makeWorkspace({ id: 'ws-1', name: 'Acme' }),
          makeWorkspace({ id: 'ws-2', name: 'Beta' }),
        ]),
      ],
    });
    const router = renderApp('/projects/proj-1');
    await screen.findByRole('heading', { name: 'Payments API', level: 1 });

    await userEvent.click(screen.getByRole('button', { name: /Current workspace: Acme/ }));
    await userEvent.click(screen.getByRole('button', { name: /Beta/ }));

    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/projects');
  });
});

describe('environments', () => {
  it('masks secrets and shows plain values', async () => {
    api('VIEWER');
    renderApp('/projects/proj-1/environments');

    const secret = await screen.findByTestId('variable-Production-API_KEY');
    expect(within(secret).getByText('Secret')).toBeInTheDocument();
    expect(within(secret).getByText('••••••••')).toBeInTheDocument();
    const plain = screen.getByTestId('variable-Production-CLIENT_ID');
    expect(within(plain).getByText('web-app')).toBeInTheDocument();
  });

  it('is read-only for viewers', async () => {
    api('VIEWER');
    renderApp('/projects/proj-1/environments');
    await screen.findByTestId('variable-Production-API_KEY');

    expect(screen.queryByRole('button', { name: 'New environment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add variable/ })).not.toBeInTheDocument();
  });

  it('adds a secret variable', async () => {
    const fake = api('OWNER', {
      'POST /projects/proj-1/environments/env-development/variables': [
        201,
        ok(variable('DB_PASSWORD', null, true)),
      ],
    });
    renderApp('/projects/proj-1/environments');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Add variable to Development' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Add variable' });
    await userEvent.type(within(dialog).getByLabelText('Key'), 'DB_PASSWORD');
    await userEvent.click(within(dialog).getByLabelText('Secret'));
    const value = within(dialog).getByLabelText('Value');
    expect(value).toHaveAttribute('type', 'password');
    await userEvent.type(value, 'hunter2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add variable' }));

    const row = await screen.findByTestId('variable-Development-DB_PASSWORD');
    expect(within(row).getByText('Secret')).toBeInTheDocument();
    expect(screen.queryByText('hunter2')).not.toBeInTheDocument();
    expect(
      fake.callsTo('POST', '/projects/proj-1/environments/env-development/variables')[0]?.body,
    ).toEqual({ key: 'DB_PASSWORD', value: 'hunter2', isSecret: true });
  });

  it('keeps a secret when edited without a new value', async () => {
    const path = '/projects/proj-1/environments/env-production/variables/var-API_KEY';
    const fake = api('OWNER', {
      [`PATCH ${path}`]: [200, ok(variable('SERVICE_KEY', null, true))],
    });
    renderApp('/projects/proj-1/environments');

    await userEvent.click(await screen.findByRole('button', { name: 'Edit API_KEY' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit API_KEY' });
    expect(within(dialog).getByLabelText('Value')).toHaveValue('');
    const key = within(dialog).getByLabelText('Key');
    await userEvent.clear(key);
    await userEvent.type(key, 'SERVICE_KEY');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByTestId('variable-Production-SERVICE_KEY')).toBeInTheDocument();
    // Only the key changed; no value is sent, so the stored secret is kept.
    expect(fake.callsTo('PATCH', path)[0]?.body).toEqual({ key: 'SERVICE_KEY' });
  });

  it('requires a new value before a secret can become plain', async () => {
    const path = '/projects/proj-1/environments/env-production/variables/var-API_KEY';
    const fake = api('OWNER');
    renderApp('/projects/proj-1/environments');

    await userEvent.click(await screen.findByRole('button', { name: 'Edit API_KEY' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit API_KEY' });
    await userEvent.click(within(dialog).getByLabelText('Secret'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(
      await within(dialog).findByText('Enter a new value to make this variable plain'),
    ).toBeInTheDocument();
    expect(fake.callsTo('PATCH', path)).toHaveLength(0);
  });

  it('creates an environment and reports server validation on the field', async () => {
    let attempts = 0;
    api('OWNER', {
      'POST /projects/proj-1/environments': () =>
        ++attempts === 1
          ? [
              400,
              apiError('VALIDATION_ERROR', 'Request validation failed', [
                {
                  path: 'baseUrl',
                  message: 'Do not put credentials in the URL; use a secret variable instead',
                },
              ]),
            ]
          : [201, ok(environment('QA', 'https://qa.example.com'))],
    });
    renderApp('/projects/proj-1/environments');

    await userEvent.click(await screen.findByRole('button', { name: 'New environment' }));
    const dialog = screen.getByRole('dialog', { name: 'New environment' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'QA');
    await userEvent.type(within(dialog).getByLabelText('Base URL'), 'https://u:p@qa.example.com');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create environment' }));
    expect(
      await within(dialog).findByText(/Do not put credentials in the URL/),
    ).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Create environment' }));
    expect(await screen.findByRole('heading', { name: 'QA' })).toBeInTheDocument();
  });

  it('shows why the last environment cannot be deleted', async () => {
    api('OWNER', {
      'DELETE /projects/proj-1/environments/env-development': [
        409,
        apiError('CONFLICT', 'A project must keep at least one environment'),
      ],
    });
    renderApp('/projects/proj-1/environments');

    await userEvent.click(await screen.findByRole('button', { name: 'Delete Development' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete environment' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'A project must keep at least one environment',
    );
  });
});

describe('project settings', () => {
  it('deletes a project only after its name is typed', async () => {
    const fake = api('OWNER', { 'DELETE /projects/proj-1': [204, ''] });
    const router = renderApp('/projects/proj-1/settings');

    await userEvent.click(await screen.findByRole('button', { name: 'Delete project' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete project' });
    expect(confirm).toBeDisabled();
    await userEvent.type(
      within(dialog).getByLabelText('Type Payments API to confirm'),
      'Payments API',
    );
    await userEvent.click(confirm);

    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/projects');
    expect(fake.callsTo('DELETE', '/projects/proj-1')).toHaveLength(1);
  });

  it('explains to members that they cannot change the project', async () => {
    api('MEMBER');
    renderApp('/projects/proj-1/settings');
    expect(await screen.findByText(/Only owners and admins of Acme/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete project' })).not.toBeInTheDocument();
  });
});
