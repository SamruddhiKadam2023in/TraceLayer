import {
  checkAssertion,
  computeHealth,
  describeIncidentEvent,
  evaluateCheck,
  readJsonPath,
  resolveHost,
  saveDependencyMapSchema,
  type Assertion,
  type ExecutionResult,
  type IncidentEventView,
} from '../src';

// ─── Monitor check evaluation (spec §20) ─────────────────────────────────────

function result(
  overrides: Partial<ExecutionResult> & { status?: number; body?: string | null } = {},
) {
  const { status = 200, body = '{"status":"ok"}', ...rest } = overrides;
  return {
    startedAt: '2026-09-30T00:00:00.000Z',
    durationMs: 120,
    timeToFirstByteMs: 80,
    request: { method: 'GET', url: 'https://api.example.com/health', headers: [] },
    redirects: [],
    note: null,
    response: {
      status,
      statusText: '',
      headers: [],
      contentType: 'application/json',
      body,
      bodyKind: body === null ? 'empty' : 'text',
      sizeBytes: body?.length ?? 0,
      truncated: false,
    },
    error: null,
    ...rest,
  } satisfies ExecutionResult;
}

const settings = (overrides: object = {}) => ({
  type: 'STATUS' as const,
  expectedStatus: null,
  latencyThresholdMs: null,
  assertions: [],
  ...overrides,
});

describe('evaluateCheck', () => {
  it('fails with the network error when there was no response', () => {
    const outcome = evaluateCheck(
      result({ response: null, error: { code: 'TIMEOUT', message: 'Timed out after 5000 ms' } }),
      settings(),
    );
    expect(outcome).toEqual({
      success: false,
      failureReason: 'TIMEOUT',
      failureMessage: 'Timed out after 5000 ms',
    });
  });

  it('availability passes on anything below 500', () => {
    expect(evaluateCheck(result({ status: 404 }), settings({ type: 'AVAILABILITY' })).success).toBe(
      true,
    );
    expect(
      evaluateCheck(result({ status: 503 }), settings({ type: 'AVAILABILITY' })),
    ).toMatchObject({ success: false, failureReason: 'SERVER_ERROR' });
  });

  it('status monitors want the expected status, or any 2xx', () => {
    expect(evaluateCheck(result({ status: 204 }), settings()).success).toBe(true);
    expect(evaluateCheck(result({ status: 301 }), settings())).toMatchObject({
      failureReason: 'UNEXPECTED_STATUS',
      failureMessage: 'Expected a 2xx status, received 301',
    });
    expect(evaluateCheck(result({ status: 201 }), settings({ expectedStatus: 200 }))).toMatchObject(
      { failureMessage: 'Expected 200, received 201' },
    );
  });

  it('performance monitors also fail when slower than the threshold', () => {
    const perf = settings({ type: 'PERFORMANCE', latencyThresholdMs: 100 });
    expect(evaluateCheck(result({ durationMs: 100 }), perf).success).toBe(true);
    expect(evaluateCheck(result({ durationMs: 101 }), perf)).toMatchObject({
      failureReason: 'LATENCY_EXCEEDED',
      failureMessage: 'Took 101 ms, threshold is 100 ms',
    });
    // A wrong status is reported first: it is the more important problem.
    expect(evaluateCheck(result({ status: 500, durationMs: 900 }), perf).failureReason).toBe(
      'UNEXPECTED_STATUS',
    );
  });

  it('response validation checks every assertion against the JSON body', () => {
    const validation = settings({
      type: 'RESPONSE_VALIDATION',
      assertions: [
        { path: 'status', operator: 'equals', value: 'ok' },
        { path: 'version', operator: 'exists' },
      ],
    });
    expect(evaluateCheck(result({ body: '{"status":"ok","version":3}' }), validation).success).toBe(
      true,
    );
    expect(evaluateCheck(result({ body: '{"status":"down"}' }), validation)).toMatchObject({
      failureReason: 'ASSERTION_FAILED',
      failureMessage: 'status: expected "ok", got "down"; version is missing',
    });
    expect(evaluateCheck(result({ body: '<html>' }), validation).failureMessage).toBe(
      'The response body is not valid JSON',
    );
    const truncated = result();
    truncated.response!.truncated = true;
    expect(evaluateCheck(truncated, validation).failureMessage).toBe(
      'The response body is not available as complete JSON',
    );
  });
});

describe('JSON assertions', () => {
  const body = { data: { items: [{ id: 7, tags: ['a', 'b'] }], name: 'orders' }, empty: null };

  it('reads dot paths through objects and arrays', () => {
    expect(readJsonPath(body, 'data.items.0.id')).toEqual({ found: true, value: 7 });
    expect(readJsonPath(body, 'empty')).toEqual({ found: true, value: null });
    expect(readJsonPath(body, 'data.items.1.id').found).toBe(false);
    // Inherited properties are not part of the JSON.
    expect(readJsonPath(body, 'data.toString').found).toBe(false);
  });

  it.each([
    [{ path: 'data.name', operator: 'equals', value: 'orders' }, null],
    [{ path: 'data.items.0', operator: 'equals', value: { tags: ['a', 'b'], id: 7 } }, null],
    [
      { path: 'data.items.0.id', operator: 'equals', value: '7' },
      'data.items.0.id: expected "7", got 7',
    ],
    [{ path: 'data.name', operator: 'notEquals', value: 'users' }, null],
    [{ path: 'missing', operator: 'notEquals', value: 1 }, null],
    [{ path: 'data.name', operator: 'contains', value: 'der' }, null],
    [
      { path: 'data.items.0.tags', operator: 'contains', value: 'c' },
      'data.items.0.tags does not contain "c"',
    ],
    [{ path: 'empty', operator: 'exists' }, null],
    [{ path: 'data.name', operator: 'notExists' }, 'data.name should be absent but is "orders"'],
  ] as [Assertion, string | null][])('%o → %s', (assertion, expected) => {
    expect(checkAssertion(body, assertion)).toBe(expected);
  });
});

// ─── Health (spec §24) ───────────────────────────────────────────────────────

describe('computeHealth', () => {
  const runs = (pattern: string) => [...pattern].map((c) => ({ success: c === '.' }));

  it.each([
    ['', 'NO_DATA'],
    ['..........', 'HEALTHY'],
    ['.........x', 'DEGRADED'], // an old failure is still intermittent trouble
    ['xx........', 'DEGRADED'], // two recent failures are not yet a streak
    ['xxx.......', 'FAILING'], // the last three failed
    ['.x.x.x.x.x', 'FAILING'], // half of the last ten failed
    ['.x.x.x.x..', 'DEGRADED'], // 4 of 10
    ['x', 'FAILING'], // a single run that failed is half (or more) of the window
    ['..........xxxxx', 'HEALTHY'], // only the latest ten count
  ])('%s → %s', (pattern, health) => {
    expect(computeHealth(runs(pattern))).toBe(health);
  });
});

// ─── Dependency map (spec §30) ───────────────────────────────────────────────

describe('resolveHost', () => {
  it.each([
    ['/orders', 'https://api.example.com/v1', 'api.example.com'],
    ['orders', 'https://API.example.com:8443/', 'api.example.com:8443'],
    ['https://pay.example.com/charge', null, 'pay.example.com'],
    ['https://pay.example.com/charge', 'https://api.example.com', 'pay.example.com'],
    ['/orders', null, null], // relative, nothing to resolve against
    ['{{BASE}}/orders', null, null], // template variable: unknown until run
    ['ftp://files.example.com/x', null, null],
  ])('%s against %s → %s', (url, base, host) => {
    expect(resolveHost(url, base)).toBe(host);
  });
});

describe('saveDependencyMapSchema', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const node = (n: number) => ({
    id: id(n),
    label: `N${n}`,
    kind: 'SERVICE',
    origin: 'MANUAL',
    host: null,
    x: 10.6,
    y: -3.2,
  });
  const edge = (n: number, from: number, to: number) => ({
    id: id(n),
    sourceId: id(from),
    targetId: id(to),
    origin: 'MANUAL',
    label: null,
  });
  const map = (nodes: object[], edges: object[] = []) =>
    saveDependencyMapSchema.safeParse({ projectId: id(999), version: 0, nodes, edges });

  it('accepts a valid map, rounding positions and lowercasing hosts', () => {
    const parsed = map([{ ...node(1), host: 'API.Example.com' }, node(2)], [edge(10, 1, 2)]);
    expect(parsed.success && parsed.data.nodes[0]).toMatchObject({
      x: 11,
      y: -3,
      host: 'api.example.com',
    });
  });

  it.each([
    [
      'a connection to a node not on the map',
      [node(1)],
      [edge(10, 1, 2)],
      'Connects a node that is not on the map',
    ],
    ['a node depending on itself', [node(1)], [edge(10, 1, 1)], 'A node cannot depend on itself'],
    [
      'the same connection twice',
      [node(1), node(2)],
      [edge(10, 1, 2), edge(11, 1, 2)],
      'These nodes are already connected',
    ],
    ['a duplicate node', [node(1), node(1)], [], 'Duplicate node'],
    ['an edge reusing a node id', [node(1), node(2)], [edge(1, 1, 2)], 'Duplicate id'],
  ])('rejects %s', (_label, nodes, edges, message) => {
    const parsed = map(nodes, edges);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message)).toContain(message);
  });

  it('rejects hosts that are URLs rather than host names', () => {
    expect(map([{ ...node(1), host: 'https://api.example.com' }]).success).toBe(false);
    expect(map([{ ...node(1), host: 'api.example.com:8443' }]).success).toBe(true);
  });
});

// ─── Incident timeline wording (spec §27) ────────────────────────────────────

describe('describeIncidentEvent', () => {
  const event = (overrides: Partial<IncidentEventView>): IncidentEventView => ({
    id: 'e',
    type: 'DETECTED',
    actor: null,
    message: null,
    fromValue: null,
    toValue: null,
    createdAt: '',
    ...overrides,
  });
  const person = { id: 'u', name: 'Grace' };

  it.each([
    [event({ type: 'DETECTED' }), 'Incident detected'],
    [
      event({ type: 'ALERT_FIRED', message: 'Error spike: 8.7% > 5%' }),
      'Alert triggered: Error spike: 8.7% > 5%',
    ],
    [
      event({ type: 'STATUS_CHANGED', fromValue: 'OPEN', toValue: 'RESOLVED' }),
      'Resolved automatically: the monitor recovered',
    ],
    [
      event({ type: 'STATUS_CHANGED', actor: person, fromValue: 'OPEN', toValue: 'RESOLVED' }),
      'Status changed from Open to Resolved',
    ],
    [
      event({
        type: 'STATUS_CHANGED',
        actor: person,
        fromValue: 'RESOLVED',
        toValue: 'INVESTIGATING',
      }),
      'Reopened as Investigating',
    ],
    [
      event({ type: 'SEVERITY_CHANGED', fromValue: 'HIGH', toValue: 'CRITICAL' }),
      'Severity changed from HIGH to CRITICAL (a more severe alert fired)',
    ],
    [event({ type: 'ASSIGNED', actor: person, toValue: 'Grace' }), 'Assigned to Grace'],
    [event({ type: 'ASSIGNED', actor: person, fromValue: 'Grace' }), 'Unassigned'],
    [event({ type: 'COMMENT', actor: person, message: 'Rolled back.' }), 'Rolled back.'],
  ])('%#: %s', (e, text) => {
    expect(describeIncidentEvent(e)).toBe(text);
  });
});
