import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import type {
  EndpointView,
  EnvironmentView,
  ExecutionResult,
  HistoryEntry,
  HistoryPage,
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

const ENV_ID = '7f3e2a10-4b5c-4d6e-8f90-a1b2c3d4e5f6';
const STAGING_ID = '8a4f3b21-5c6d-4e7f-9a01-b2c3d4e5f6a7';

const PROJECT: ProjectView = {
  id: 'proj-1',
  workspaceId: 'ws-1',
  name: 'Orders API',
  description: null,
  createdBy: null,
  environmentCount: 2,
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
};

function env(id: string, name: string, baseUrl: string): EnvironmentView {
  return {
    id,
    projectId: 'proj-1',
    name,
    baseUrl,
    variables: [],
    createdAt: '2026-09-29T10:00:00.000Z',
    updatedAt: '2026-09-29T10:00:00.000Z',
  };
}
const ENVIRONMENTS = [
  env(ENV_ID, 'Production', 'https://api.example.com'),
  env(STAGING_ID, 'Staging', 'https://staging.example.com'),
];

const ENDPOINT: EndpointView = {
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
  tags: [],
  createdBy: null,
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
};

function result(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    startedAt: '2026-09-29T10:00:00.000Z',
    durationMs: 243,
    timeToFirstByteMs: 200,
    request: {
      method: 'GET',
      url: 'https://api.example.com/orders',
      headers: [
        ['Authorization', 'Bearer ••••••'],
        ['User-Agent', 'TraceLayer/0.1'],
      ],
    },
    redirects: [],
    note: null,
    response: {
      status: 200,
      statusText: '',
      headers: [['content-type', 'application/json']],
      contentType: 'application/json',
      body: '{"orders":[{"id":1}],"total":1}',
      bodyKind: 'text',
      sizeBytes: 2150,
      truncated: false,
    },
    error: null,
    ...overrides,
  };
}

function api(role: WorkspaceRole, extra: Record<string, Handler | FakeResponse> = {}) {
  return installFakeApi({
    'POST /auth/refresh': [200, ok(makeSession())],
    'GET /workspaces': [200, ok([makeWorkspace({ role })])],
    'GET /projects/proj-1': [200, ok(PROJECT)],
    'GET /projects/proj-1/environments': [200, ok(ENVIRONMENTS)],
    'GET /endpoints': [200, ok([ENDPOINT])],
    'GET /endpoints/ep-1': [200, ok(ENDPOINT)],
    'POST /requests/execute': [200, ok({ result: result(), historyId: 'h-1' })],
    ...extra,
  });
}

function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('sending a request', () => {
  it('sends the current form, including unsaved edits, and shows the response', async () => {
    const fake = api('MEMBER');
    renderApp('/projects/proj-1/endpoints/ep-1');

    const url = await screen.findByLabelText('URL');
    await userEvent.clear(url);
    await userEvent.type(url, '/orders/recent');
    await userEvent.selectOptions(screen.getByLabelText('Run in environment'), STAGING_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    const viewer = await screen.findByTestId('response-viewer');
    expect(within(viewer).getByText('200 OK')).toBeInTheDocument();
    expect(within(viewer).getByText('243ms')).toBeInTheDocument();
    expect(within(viewer).getByText('2.1 KB')).toBeInTheDocument();
    // JSON is pretty-printed.
    expect(within(viewer).getByTestId('json-viewer').textContent).toContain('"orders": [');

    expect(fake.callsTo('POST', '/requests/execute')[0]?.body).toMatchObject({
      projectId: 'proj-1',
      environmentId: STAGING_ID,
      endpointId: 'ep-1',
      request: { method: 'GET', url: '/orders/recent' },
    });
  });

  it('switches between pretty and raw, and shows headers and the sent request', async () => {
    api('OWNER');
    renderApp('/projects/proj-1/endpoints/ep-1');
    await userEvent.click(await screen.findByRole('button', { name: 'Send' }));
    const viewer = await screen.findByTestId('response-viewer');

    await userEvent.click(within(viewer).getByRole('button', { name: 'Raw' }));
    expect(within(viewer).getByText('{"orders":[{"id":1}],"total":1}')).toBeInTheDocument();

    await userEvent.click(within(viewer).getByRole('tab', { name: /Headers/ }));
    expect(within(viewer).getByText('content-type')).toBeInTheDocument();

    await userEvent.click(within(viewer).getByRole('tab', { name: 'Request' }));
    expect(within(viewer).getByText('Bearer ••••••')).toBeInTheDocument();
  });

  it('shows network failures such as blocked targets', async () => {
    api('OWNER', {
      'POST /requests/execute': [
        200,
        ok({
          result: result({
            response: null,
            error: {
              code: 'BLOCKED_TARGET',
              message: 'Requests to private or internal addresses are blocked (169.254.169.254)',
            },
          }),
          historyId: 'h-2',
        }),
      ],
    });
    renderApp('/projects/proj-1/endpoints/ep-1');
    await userEvent.click(await screen.findByRole('button', { name: 'Send' }));

    const viewer = await screen.findByTestId('response-viewer');
    expect(within(viewer).getByText('Blocked')).toBeInTheDocument();
    expect(within(viewer).getByRole('alert')).toHaveTextContent('169.254.169.254');
  });

  it('shows configuration problems from the server on the form', async () => {
    api('OWNER', {
      'POST /requests/execute': [
        400,
        apiError(
          'VALIDATION_ERROR',
          'Secret variables can only be sent to https://api.example.com',
          [
            {
              path: 'url',
              message: 'Secret variables can only be sent to https://api.example.com',
            },
          ],
        ),
      ],
    });
    renderApp('/projects/proj-1/endpoints/ep-1');
    await userEvent.click(await screen.findByRole('button', { name: 'Send' }));

    expect(await screen.findByText(/Secret variables can only be sent to/)).toBeInTheDocument();
    expect(screen.getByLabelText('URL')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByTestId('response-viewer')).not.toBeInTheDocument();
  });

  it('validates the request before sending, without needing a name', async () => {
    const fake = api('OWNER');
    renderApp('/projects/proj-1/endpoints/new');

    await userEvent.type(await screen.findByLabelText('URL'), 'not a url');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Use a path like \/orders/)).toBeInTheDocument();
    expect(fake.callsTo('POST', '/requests/execute')).toHaveLength(0);

    const url = screen.getByLabelText('URL');
    await userEvent.clear(url);
    await userEvent.type(url, '/health');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByTestId('response-viewer')).toBeInTheDocument();
    expect(fake.callsTo('POST', '/requests/execute')[0]?.body).toMatchObject({ endpointId: null });
  });

  it('does not offer Send to viewers', async () => {
    api('VIEWER');
    renderApp('/projects/proj-1/endpoints/ep-1');
    await screen.findByRole('heading', { name: 'List orders' });
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });
});

describe('request history', () => {
  function entry(id: string, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
    return {
      id,
      projectId: 'proj-1',
      endpoint: { id: 'ep-1', name: 'List orders' },
      environment: { id: ENV_ID, name: 'Production' },
      user: { id: 'user-1', name: 'Ada Lovelace' },
      method: 'GET',
      url: 'https://api.example.com/orders',
      status: 200,
      errorCode: null,
      errorMessage: null,
      durationMs: 120,
      sizeBytes: 512,
      createdAt: '2026-09-29T10:00:00.000Z',
      ...overrides,
    };
  }

  function page(items: HistoryEntry[], overrides: Partial<HistoryPage> = {}): HistoryPage {
    return { items, total: items.length, page: 1, pageSize: 25, ...overrides };
  }

  it('lists requests with status, timing and who ran them', async () => {
    api('VIEWER', {
      'GET /requests/history': [
        200,
        ok(
          page([
            entry('h1'),
            entry('h2', {
              status: null,
              errorCode: 'TIMEOUT',
              errorMessage: 'slow',
              sizeBytes: null,
            }),
          ]),
        ),
      ],
    });
    renderApp('/projects/proj-1/history');

    const rows = await screen.findAllByTestId('history-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('200')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('120ms')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Timed out')).toBeInTheDocument();
  });

  it('sends filters, sorting and paging to the API and keeps them in the URL', async () => {
    const fake = api('OWNER', {
      'GET /requests/history': [200, ok(page([entry('h1')], { total: 60 }))],
    });
    const router = renderApp('/projects/proj-1/history');
    await screen.findAllByTestId('history-row');

    await userEvent.selectOptions(screen.getByLabelText('Status'), '5xx');
    await userEvent.selectOptions(screen.getByLabelText('Method'), 'POST');
    await userEvent.click(screen.getByRole('button', { name: 'Duration' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));

    const last = fake.calls.filter((c) => c.url === '/requests/history').at(-1);
    expect(last?.params).toEqual({
      projectId: 'proj-1',
      status: '5xx',
      method: 'POST',
      sort: 'durationMs',
      order: 'desc',
      page: 2,
      pageSize: 25,
    });
    expect(router.state.location.search).toContain('status=5xx');
    expect(router.state.location.search).toContain('page=2');
    expect(screen.getByRole('columnheader', { name: /Duration/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    // 60 results at 25 per page.
    expect(screen.getByText(/of 3/)).toBeInTheDocument();
  });

  it('explains an empty history', async () => {
    api('OWNER', { 'GET /requests/history': [200, ok(page([]))] });
    renderApp('/projects/proj-1/history');
    expect(await screen.findByText('No requests yet')).toBeInTheDocument();
  });
});
