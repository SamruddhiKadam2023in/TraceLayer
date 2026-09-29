import {
  checkAssertion,
  evaluateCheck,
  readJsonPath,
  type EvaluationSettings,
  type ExecutionResult,
} from '@tracelayer/shared';

function result(
  overrides: Partial<ExecutionResult> & { status?: number; body?: string } = {},
): ExecutionResult {
  const { status = 200, body = '{"status":"healthy"}', ...rest } = overrides;
  return {
    startedAt: '2026-09-29T10:00:00.000Z',
    durationMs: 120,
    timeToFirstByteMs: 100,
    request: { method: 'GET', url: 'https://api.example.com/health', headers: [] },
    redirects: [],
    note: null,
    response: {
      status,
      statusText: '',
      headers: [],
      contentType: 'application/json',
      body,
      bodyKind: 'text',
      sizeBytes: body.length,
      truncated: false,
    },
    error: null,
    ...rest,
  };
}

const failed = (code: 'TIMEOUT' | 'BLOCKED_TARGET', message: string) =>
  result({ response: null, error: { code, message } });

function settings(overrides: Partial<EvaluationSettings> = {}): EvaluationSettings {
  return {
    type: 'STATUS',
    expectedStatus: null,
    latencyThresholdMs: null,
    assertions: [],
    ...overrides,
  };
}

describe('evaluateCheck', () => {
  it('fails every type when no response arrived, keeping the network reason', () => {
    for (const type of ['AVAILABILITY', 'STATUS', 'PERFORMANCE', 'RESPONSE_VALIDATION'] as const) {
      expect(
        evaluateCheck(failed('TIMEOUT', 'No complete response within 3000 ms'), settings({ type })),
      ).toEqual({
        success: false,
        failureReason: 'TIMEOUT',
        failureMessage: 'No complete response within 3000 ms',
      });
    }
    expect(evaluateCheck(failed('BLOCKED_TARGET', 'blocked'), settings()).failureReason).toBe(
      'BLOCKED_TARGET',
    );
  });

  describe('availability', () => {
    it.each([200, 301, 404, 499])('passes on %i (the server is up)', (status) => {
      expect(evaluateCheck(result({ status }), settings({ type: 'AVAILABILITY' })).success).toBe(
        true,
      );
    });
    it.each([500, 503])('fails on %i', (status) => {
      expect(evaluateCheck(result({ status }), settings({ type: 'AVAILABILITY' }))).toMatchObject({
        success: false,
        failureReason: 'SERVER_ERROR',
      });
    });
  });

  describe('status', () => {
    it('accepts any 2xx when no status is expected', () => {
      expect(evaluateCheck(result({ status: 204 }), settings()).success).toBe(true);
      expect(evaluateCheck(result({ status: 302 }), settings())).toMatchObject({
        success: false,
        failureMessage: 'Expected a 2xx status, received 302',
      });
    });
    it('requires the exact expected status', () => {
      expect(
        evaluateCheck(result({ status: 201 }), settings({ expectedStatus: 201 })).success,
      ).toBe(true);
      expect(evaluateCheck(result({ status: 500 }), settings({ expectedStatus: 200 }))).toEqual({
        success: false,
        failureReason: 'UNEXPECTED_STATUS',
        failureMessage: 'Expected 200, received 500',
      });
    });
  });

  describe('performance', () => {
    const perf = settings({ type: 'PERFORMANCE', latencyThresholdMs: 500 });
    it('passes under the threshold and fails over it', () => {
      expect(evaluateCheck(result({ durationMs: 500 }), perf).success).toBe(true);
      expect(evaluateCheck(result({ durationMs: 501 }), perf)).toEqual({
        success: false,
        failureReason: 'LATENCY_EXCEEDED',
        failureMessage: 'Took 501 ms, threshold is 500 ms',
      });
    });
    it('still requires a good status: a fast error is not healthy', () => {
      expect(evaluateCheck(result({ status: 500, durationMs: 10 }), perf).failureReason).toBe(
        'UNEXPECTED_STATUS',
      );
    });
  });

  describe('response validation', () => {
    const body = JSON.stringify({
      status: 'healthy',
      version: 3,
      checks: ['db', 'cache'],
      data: { items: [{ id: 7 }] },
    });
    const validate = (assertions: EvaluationSettings['assertions']) =>
      evaluateCheck(result({ body }), settings({ type: 'RESPONSE_VALIDATION', assertions }));

    it('passes when every check holds', () => {
      expect(
        validate([
          { path: 'status', operator: 'equals', value: 'healthy' },
          { path: 'version', operator: 'notEquals', value: 2 },
          { path: 'data.items.0.id', operator: 'equals', value: 7 },
          { path: 'checks', operator: 'contains', value: 'db' },
          { path: 'data.missing', operator: 'notExists' },
        ]).success,
      ).toBe(true);
    });

    it('reports every failing check', () => {
      const outcome = validate([
        { path: 'status', operator: 'equals', value: 'ok' },
        { path: 'data.items.5', operator: 'exists' },
      ]);
      expect(outcome).toEqual({
        success: false,
        failureReason: 'ASSERTION_FAILED',
        failureMessage: 'status: expected "ok", got "healthy"; data.items.5 is missing',
      });
    });

    it('fails on non-JSON or truncated bodies', () => {
      const notJson = evaluateCheck(
        result({ body: '<html>' }),
        settings({ type: 'RESPONSE_VALIDATION', assertions: [{ path: 'a', operator: 'exists' }] }),
      );
      expect(notJson.failureMessage).toBe('The response body is not valid JSON');
    });
  });
});

describe('readJsonPath and checkAssertion', () => {
  it('walks objects and arrays, and does not read inherited properties', () => {
    expect(readJsonPath({ a: [{ b: 1 }] }, 'a.0.b')).toEqual({ found: true, value: 1 });
    expect(readJsonPath({ a: [] }, 'a.0')).toEqual({ found: false, value: undefined });
    expect(readJsonPath({}, 'constructor')).toEqual({ found: false, value: undefined });
    expect(readJsonPath({ a: null }, 'a')).toEqual({ found: true, value: null });
  });

  it('compares objects deeply', () => {
    expect(
      checkAssertion({ a: { x: [1, 2] } }, { path: 'a', operator: 'equals', value: { x: [1, 2] } }),
    ).toBeNull();
    expect(
      checkAssertion({ a: { x: [1] } }, { path: 'a', operator: 'equals', value: { x: [1, 2] } }),
    ).not.toBeNull();
  });
});
