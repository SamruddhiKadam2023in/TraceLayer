import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { AxiosError } from 'axios';
import { beforeEach, describe, expect, it } from 'vitest';
import type { HealthReport } from '@tracelayer/shared';
import { routes } from '@/routes/router';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/auth.store';
import { apiError, installFakeApi, makeSession, ok, UNAUTHENTICATED } from './fake-api';

const HEALTH: HealthReport = {
  status: 'ok',
  version: '0.1.0',
  uptimeSeconds: 60,
  timestamp: '2026-09-29T10:00:00.000Z',
  dependencies: {
    database: { status: 'up', latencyMs: 2 },
    redis: { status: 'up', latencyMs: 1 },
    worker: { status: 'up', latencyMs: null, lastHeartbeatAt: '2026-09-29T10:00:00.000Z' },
  },
};

function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  useAuthStore.setState({ status: 'unknown', user: null, accessToken: null });
});

describe('session restore and route protection', () => {
  it('sends a signed-out visitor from a protected page to sign in', async () => {
    installFakeApi({ 'POST /auth/refresh': UNAUTHENTICATED });
    const router = renderApp('/status');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('restores the session from the refresh cookie and skips the sign-in page', async () => {
    installFakeApi({
      'POST /auth/refresh': [200, ok(makeSession())],
      'GET /health': [200, ok(HEALTH)],
    });
    renderApp('/login');

    expect(await screen.findByRole('heading', { name: 'System status' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Account menu for Ada Lovelace' }),
    ).toBeInTheDocument();
  });
});

describe('sign in', () => {
  it('validates the form before calling the API', async () => {
    const fake = installFakeApi({ 'POST /auth/refresh': UNAUTHENTICATED });
    renderApp('/login');

    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(screen.getByText('Password is required')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(fake.callsTo('POST', '/auth/login')).toHaveLength(0);
  });

  it('shows the server message when credentials are wrong', async () => {
    installFakeApi({
      'POST /auth/refresh': UNAUTHENTICATED,
      'POST /auth/login': [401, apiError('UNAUTHENTICATED', 'Invalid email or password')],
    });
    renderApp('/login');

    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(useAuthStore.getState().status).toBe('anonymous');
  });

  it('reports a network failure without crashing', async () => {
    installFakeApi({ 'POST /auth/refresh': UNAUTHENTICATED });
    renderApp('/login');
    await screen.findByLabelText('Email');
    // The API goes away after the page loaded: axios reports an error with no response.
    api.defaults.adapter = async (config) => {
      throw new AxiosError('Network Error', AxiosError.ERR_NETWORK, config);
    };

    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'whatever-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the TraceLayer API');
  });

  it('signs in and returns to the page that was originally requested', async () => {
    const fake = installFakeApi({
      'POST /auth/refresh': UNAUTHENTICATED,
      'POST /auth/login': [200, ok(makeSession())],
      'GET /health': [200, ok(HEALTH)],
    });
    const router = renderApp('/status');

    await userEvent.type(await screen.findByLabelText('Email'), '  ADA@example.com ');
    await userEvent.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'System status' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/status');
    // The shared schema normalises the email before it is sent.
    expect(fake.callsTo('POST', '/auth/login')[0]?.body).toEqual({
      email: 'ada@example.com',
      password: 'correct-horse-battery',
    });
    // Later API calls carry the new access token.
    expect(fake.callsTo('GET', '/health')[0]?.authorization).toBe('Bearer access-token-1');
  });
});

describe('create account', () => {
  async function fillForm(overrides: Partial<Record<string, string>> = {}) {
    const values = {
      Name: 'Ada Lovelace',
      Email: 'ada@example.com',
      Password: 'correct-horse-battery',
      'Confirm password': 'correct-horse-battery',
      ...overrides,
    };
    for (const [label, value] of Object.entries(values)) {
      await userEvent.type(await screen.findByLabelText(label), value);
    }
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
  }

  it('rejects mismatched passwords without calling the API', async () => {
    const fake = installFakeApi({ 'POST /auth/refresh': UNAUTHENTICATED });
    renderApp('/register');

    await fillForm({ 'Confirm password': 'something-else' });

    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();
    expect(fake.callsTo('POST', '/auth/register')).toHaveLength(0);
  });

  it('shows a duplicate-email conflict on the email field', async () => {
    installFakeApi({
      'POST /auth/refresh': UNAUTHENTICATED,
      'POST /auth/register': [
        409,
        apiError('CONFLICT', 'An account with this email already exists', [
          { path: 'email', message: 'An account with this email already exists' },
        ]),
      ],
    });
    renderApp('/register');

    await fillForm();

    expect(
      await screen.findByText('An account with this email already exists'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('creates the account and signs the user in', async () => {
    installFakeApi({
      'POST /auth/refresh': UNAUTHENTICATED,
      'POST /auth/register': [201, ok(makeSession())],
      'GET /health': [200, ok(HEALTH)],
    });
    renderApp('/register');

    await fillForm();

    expect(await screen.findByRole('heading', { name: 'System status' })).toBeInTheDocument();
    expect(useAuthStore.getState().user?.email).toBe('ada@example.com');
  });
});

describe('sign out', () => {
  it('ends the session on the server and returns to sign in', async () => {
    const fake = installFakeApi({
      'POST /auth/refresh': [200, ok(makeSession())],
      'GET /health': [200, ok(HEALTH)],
      'POST /auth/logout': [204, ''],
    });
    renderApp('/status');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Account menu for Ada Lovelace' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(fake.callsTo('POST', '/auth/logout')).toHaveLength(1);
    expect(useAuthStore.getState()).toMatchObject({ status: 'anonymous', accessToken: null });
  });
});
