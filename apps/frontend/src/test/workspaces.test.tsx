import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { WorkspaceMemberView, WorkspaceRole } from '@tracelayer/shared';
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

const SESSION: FakeResponse = [200, ok(makeSession())];

function member(
  userId: string,
  name: string,
  role: WorkspaceRole,
  email = `${name.split(' ')[0]?.toLowerCase()}@example.com`,
): WorkspaceMemberView {
  return { userId, name, email, role, joinedAt: '2026-09-29T10:00:00.000Z' };
}

// The signed-in user (makeSession) is user-1, Ada Lovelace.
const MEMBERS = [
  member('user-1', 'Ada Lovelace', 'OWNER', 'ada@example.com'),
  member('user-2', 'Grace Hopper', 'MEMBER'),
];

function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('first workspace', () => {
  it('asks a user with no workspaces to create one, then opens it', async () => {
    const fake = installFakeApi({
      'POST /auth/refresh': SESSION,
      'GET /workspaces': [200, ok([])],
      'POST /workspaces': [201, ok(makeWorkspace({ id: 'ws-new', name: 'Acme Engineering' }))],
      'GET /workspaces/ws-new/members': [200, ok([MEMBERS[0]])],
    });
    renderApp('/settings');

    expect(
      await screen.findByRole('heading', { name: 'Create your first workspace' }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(await screen.findByText('Workspace name is required')).toBeInTheDocument();
    expect(fake.callsTo('POST', '/workspaces')).toHaveLength(0);

    await userEvent.type(screen.getByLabelText('Workspace name'), '  Acme Engineering ');
    await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(await screen.findByRole('heading', { name: 'Workspace settings' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Current workspace: Acme Engineering/ }),
    ).toBeInTheDocument();
    expect(fake.callsTo('POST', '/workspaces')[0]?.body).toEqual({ name: 'Acme Engineering' });
  });
});

describe('switching workspaces', () => {
  const TWO: FakeResponse = [
    200,
    ok([
      makeWorkspace({ id: 'ws-1', name: 'Acme' }),
      makeWorkspace({ id: 'ws-2', name: 'Globex', role: 'VIEWER', memberCount: 4 }),
    ]),
  ];

  it('switches from the top bar and remembers the choice', async () => {
    installFakeApi({
      'POST /auth/refresh': SESSION,
      'GET /workspaces': TWO,
      'GET /workspaces/ws-1/members': [200, ok(MEMBERS)],
      'GET /workspaces/ws-2/members': [200, ok(MEMBERS)],
    });
    renderApp('/settings');

    await userEvent.click(await screen.findByRole('button', { name: /Current workspace: Acme/ }));
    await userEvent.click(screen.getByRole('button', { name: /Globex/ }));

    expect(screen.getByRole('button', { name: /Current workspace: Globex/ })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('tracelayer-workspace') ?? '{}').state).toEqual({
      currentId: 'ws-2',
    });
  });

  it('reopens the remembered workspace, and falls back when it is no longer accessible', async () => {
    installFakeApi({
      'POST /auth/refresh': SESSION,
      'GET /workspaces': TWO,
      'GET /health': [500, apiError('INTERNAL_ERROR', 'x')],
    });
    useWorkspaceStore.setState({ currentId: 'ws-2' });
    renderApp('/status');
    expect(
      await screen.findByRole('button', { name: /Current workspace: Globex/ }),
    ).toBeInTheDocument();

    useWorkspaceStore.getState().reset();
    useWorkspaceStore.setState({ currentId: 'ws-deleted' });
    await useWorkspaceStore.getState().load();
    expect(useWorkspaceStore.getState().currentId).toBe('ws-1');
  });
});

describe('workspace settings', () => {
  function settingsApi(role: WorkspaceRole, extra: Record<string, Handler | FakeResponse> = {}) {
    return installFakeApi({
      'POST /auth/refresh': SESSION,
      'GET /workspaces': [200, ok([makeWorkspace({ role, memberCount: 2 })])],
      'GET /notification-channels': [200, ok([])],
      'GET /workspaces/ws-1/members': [
        200,
        ok([member('user-1', 'Ada Lovelace', role, 'ada@example.com'), MEMBERS[1]]),
      ],
      ...extra,
    });
  }

  it('shows a viewer a read-only page', async () => {
    settingsApi('VIEWER');
    renderApp('/settings');

    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Workspace name' })).not.toBeInTheDocument();
    expect(screen.getByText(/Only owners can rename the workspace/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add member' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete workspace' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave workspace' })).toBeInTheDocument();
  });

  it('lets an admin manage members but not rename, delete or grant owner', async () => {
    settingsApi('ADMIN');
    renderApp('/settings');

    await screen.findByText('Grace Hopper');
    expect(screen.queryByRole('textbox', { name: 'Workspace name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete workspace' })).not.toBeInTheDocument();
    const roleOptions = within(screen.getByLabelText('Role')).getAllByRole('option');
    expect(roleOptions.map((o) => o.textContent)).toEqual(['Admin', 'Member', 'Viewer']);
  });

  it('renames the workspace', async () => {
    const fake = settingsApi('OWNER', {
      'PATCH /workspaces/ws-1': [200, ok(makeWorkspace({ name: 'Acme Corp', memberCount: 2 }))],
    });
    renderApp('/settings');

    const name = await screen.findByRole('textbox', { name: 'Workspace name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Acme Corp');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(fake.callsTo('PATCH', '/workspaces/ws-1')[0]?.body).toEqual({ name: 'Acme Corp' });
    expect(
      screen.getByRole('button', { name: /Current workspace: Acme Corp/ }),
    ).toBeInTheDocument();
  });

  it('adds a member, and reports an unknown email on the email field', async () => {
    let attempts = 0;
    settingsApi('OWNER', {
      'POST /workspaces/ws-1/members': () =>
        ++attempts === 1
          ? [
              404,
              apiError('NOT_FOUND', 'No TraceLayer account uses this email', [
                { path: 'email', message: 'No TraceLayer account uses this email' },
              ]),
            ]
          : [201, ok(member('user-3', 'Alan Turing', 'VIEWER'))],
    });
    renderApp('/settings');

    await userEvent.type(await screen.findByLabelText('Email address'), 'alan@example.com');
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'VIEWER');
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }));
    expect(await screen.findByText('No TraceLayer account uses this email')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add member' }));
    const row = await screen.findByTestId('member-alan@example.com');
    expect(within(row).getByText('Alan Turing')).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toHaveValue('');
  });

  it('changes a role, and shows the reason when the server refuses', async () => {
    const fake = settingsApi('OWNER', {
      'PATCH /workspaces/ws-1/members/user-2': [200, ok(member('user-2', 'Grace Hopper', 'ADMIN'))],
      'PATCH /workspaces/ws-1/members/user-1': [
        409,
        apiError('CONFLICT', 'A workspace must always have at least one owner'),
      ],
    });
    renderApp('/settings');

    await userEvent.selectOptions(await screen.findByLabelText('Role for Grace Hopper'), 'ADMIN');
    expect(fake.callsTo('PATCH', '/workspaces/ws-1/members/user-2')[0]?.body).toEqual({
      role: 'ADMIN',
    });
    expect(await screen.findByLabelText('Role for Grace Hopper')).toHaveValue('ADMIN');

    await userEvent.selectOptions(screen.getByLabelText('Role for Ada Lovelace'), 'VIEWER');
    expect(await screen.findByRole('alert')).toHaveTextContent('at least one owner');
    expect(screen.getByLabelText('Role for Ada Lovelace')).toHaveValue('OWNER');
  });

  it('removes a member after confirmation', async () => {
    const fake = settingsApi('OWNER', { 'DELETE /workspaces/ws-1/members/user-2': [204, ''] });
    renderApp('/settings');

    await userEvent.click(await screen.findByRole('button', { name: 'Remove Grace Hopper' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Grace Hopper?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove member' }));

    expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument();
    expect(fake.callsTo('DELETE', '/workspaces/ws-1/members/user-2')).toHaveLength(1);
  });

  it('only deletes a workspace after its name is typed, then leaves it', async () => {
    const fake = settingsApi('OWNER', { 'DELETE /workspaces/ws-1': [204, ''] });
    renderApp('/settings');

    await userEvent.click(await screen.findByRole('button', { name: 'Delete workspace' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Acme?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete workspace' });
    expect(confirm).toBeDisabled();

    await userEvent.type(within(dialog).getByLabelText('Type Acme to confirm'), 'Acme');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    expect(fake.callsTo('DELETE', '/workspaces/ws-1')).toHaveLength(1);
    // It was the only workspace, so the user is asked to create a new one.
    expect(
      await screen.findByRole('heading', { name: 'Create your first workspace' }),
    ).toBeInTheDocument();
  });

  it('closes the confirmation with Escape without deleting', async () => {
    const fake = settingsApi('OWNER');
    renderApp('/settings');

    await userEvent.click(await screen.findByRole('button', { name: 'Delete workspace' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fake.callsTo('DELETE', '/workspaces/ws-1')).toHaveLength(0);
  });
});

describe('signing out', () => {
  it('forgets the workspaces so the next user never sees them', async () => {
    installFakeApi({
      'POST /auth/refresh': SESSION,
      'GET /workspaces': [200, ok([makeWorkspace()])],
      'GET /workspaces/ws-1/members': [200, ok(MEMBERS)],
      'POST /auth/logout': [204, ''],
    });
    renderApp('/settings');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Account menu for Ada Lovelace' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(useWorkspaceStore.getState()).toMatchObject({ workspaces: [], currentId: null });
  });
});
