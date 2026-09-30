import {
  baseUrlSchema,
  createEndpointSchema,
  createMonitorSchema,
  emailSchema,
  endpointUrlSchema,
  endpointVariableNames,
  extractVariableNames,
  headerSchema,
  isSensitiveHeader,
  monitorConfigSchema,
  passwordSchema,
  registerSchema,
  tagSchema,
  variableKeySchema,
} from '../src';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ENDPOINT = '22222222-2222-4222-8222-222222222222';
const ENVIRONMENT = '33333333-3333-4333-8333-333333333333';

/** The messages of a failed parse, or [] when it passed. */
function problems(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.success ? [] : result.error!.issues.map((i) => i.message);
}

describe('accounts', () => {
  it('normalises emails and rejects invalid ones', () => {
    expect(emailSchema.parse('  Ada@Example.COM ')).toBe('ada@example.com');
    expect(problems(emailSchema.safeParse('not-an-email'))).toEqual([
      'Enter a valid email address',
    ]);
  });

  it('requires 8+ characters and at most 72 bytes (bcrypt’s limit), counted as UTF-8', () => {
    expect(passwordSchema.safeParse('1234567').success).toBe(false);
    expect(passwordSchema.safeParse('12345678').success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(72)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(73)).success).toBe(false);
    // 25 three-byte characters = 75 bytes, although only 25 characters.
    expect(problems(passwordSchema.safeParse('€'.repeat(25)))).toEqual([
      'Password must be at most 72 bytes',
    ]);
  });

  it('checks that the password confirmation matches', () => {
    const base = { name: 'Ada', email: 'ada@example.com', password: 'password-1' };
    expect(registerSchema.safeParse({ ...base, confirmPassword: 'password-1' }).success).toBe(true);
    const mismatch = registerSchema.safeParse({ ...base, confirmPassword: 'password-2' });
    expect(mismatch.success).toBe(false);
    expect(mismatch.error?.issues[0]).toMatchObject({
      path: ['confirmPassword'],
      message: 'Passwords do not match',
    });
  });
});

describe('environments', () => {
  it('stores base URLs without trailing slashes, and empty as null', () => {
    expect(baseUrlSchema.parse('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    expect(baseUrlSchema.parse('  ')).toBeNull();
  });

  it.each([
    ['api.example.com', 'Enter a full URL, e.g. https://api.example.com'],
    ['ftp://files.example.com', 'Only http and https URLs are supported'],
    [
      'https://user:pass@api.example.com',
      'Do not put credentials in the URL; use a secret variable instead',
    ],
    ['https://api.example.com/?key=1', 'A base URL cannot contain ? or #'],
  ])('rejects %s', (url, message) => {
    expect(problems(baseUrlSchema.safeParse(url))).toEqual([message]);
  });

  it('accepts variable names that can be referenced as {{NAME}}', () => {
    expect(variableKeySchema.safeParse('API_TOKEN').success).toBe(true);
    expect(variableKeySchema.safeParse('9lives').success).toBe(false);
    expect(variableKeySchema.safeParse('has space').success).toBe(false);
  });
});

describe('endpoints', () => {
  it('finds variable references, once each, in order', () => {
    expect(extractVariableNames('{{ BASE }}/users/{{ID}}?x={{BASE}}')).toEqual(['BASE', 'ID']);
    expect(extractVariableNames('no variables here {{ not valid }}')).toEqual([]);
  });

  it.each([
    ['/orders/{{ORDER_ID}}', true],
    ['{{GATEWAY}}/orders', true],
    ['https://api.example.com/orders', true],
    ['orders', false],
    ['/orders?page=2', false],
    ['ftp://example.com/x', false],
  ])('URL %s valid: %s', (url, valid) => {
    expect(endpointUrlSchema.safeParse(url).success).toBe(valid);
  });

  it('only lets credential headers hold variable references', () => {
    expect(isSensitiveHeader(' Authorization ')).toBe(true);
    expect(isSensitiveHeader('X-Request-Id')).toBe(false);
    expect(
      problems(headerSchema.safeParse({ key: 'Authorization', value: 'Bearer abc123' })),
    ).toEqual(['This header carries credentials: use a variable, e.g. Bearer {{API_TOKEN}}']);
    expect(
      headerSchema.safeParse({ key: 'Authorization', value: 'Bearer {{API_TOKEN}}' }).success,
    ).toBe(true);
    expect(headerSchema.safeParse({ key: 'X-Trace', value: 'plain value' }).success).toBe(true);
    expect(headerSchema.safeParse({ key: 'Bad Header', value: 'x' }).success).toBe(false);
  });

  const endpoint = (overrides: object = {}) =>
    createEndpointSchema.safeParse({
      projectId: PROJECT,
      name: 'Create order',
      method: 'POST',
      url: '/orders',
      ...overrides,
    });

  it('fills defaults for everything but name, method and URL', () => {
    const parsed = endpoint();
    expect(parsed.success && parsed.data).toMatchObject({
      headers: [],
      queryParams: [],
      body: { type: 'none' },
      auth: { type: 'none' },
      timeoutMs: 10_000,
      expectedStatus: null,
      tags: [],
      environmentId: null,
      description: null,
    });
  });

  it('rejects bodies on GET and HEAD, and invalid JSON bodies (templates allowed)', () => {
    expect(problems(endpoint({ method: 'GET', body: { type: 'text', content: 'x' } }))).toEqual([
      'GET requests cannot have a body',
    ]);
    expect(
      problems(endpoint({ body: { type: 'json', content: '{"total": {{AMOUNT}}}' } })),
    ).toEqual([]);
    expect(problems(endpoint({ body: { type: 'json', content: '{"total": }' } }))).toEqual([
      'Body is not valid JSON',
    ]);
  });

  it('keeps credentials in variables for every auth type', () => {
    expect(endpoint({ auth: { type: 'bearer', token: 'raw-token' } }).success).toBe(false);
    expect(endpoint({ auth: { type: 'bearer', token: '{{TOKEN}}' } }).success).toBe(true);
    expect(
      endpoint({ auth: { type: 'basic', username: 'svc', password: 'hunter2' } }).success,
    ).toBe(false);
    expect(
      endpoint({ auth: { type: 'apiKey', in: 'header', name: 'X-Key', value: '{{KEY}}' } }).success,
    ).toBe(true);
  });

  it('bounds timeouts and status codes, and normalises tags', () => {
    expect(endpoint({ timeoutMs: 999 }).success).toBe(false);
    expect(endpoint({ timeoutMs: 30_001 }).success).toBe(false);
    expect(endpoint({ expectedStatus: 600 }).success).toBe(false);
    const tagged = endpoint({ tags: ['Payments', 'payments', 'v2'] });
    expect(tagged.success && tagged.data.tags).toEqual(['payments', 'v2']);
    expect(tagSchema.safeParse('-leading-dash').success).toBe(false);
  });

  it('lists every variable an endpoint needs, skipping disabled rows', () => {
    expect(
      endpointVariableNames({
        url: '{{BASE}}/orders',
        headers: [
          { key: 'Authorization', value: 'Bearer {{TOKEN}}', enabled: true },
          { key: 'X-Old', value: '{{UNUSED}}', enabled: false },
        ],
        queryParams: [{ key: 'region', value: '{{REGION}}', enabled: true }],
        body: { type: 'json', content: '{"tenant": "{{TENANT}}"}' },
        auth: { type: 'bearer', token: '{{TOKEN}}' },
      }),
    ).toEqual(['BASE', 'TOKEN', 'REGION', 'TENANT']);
  });
});

describe('monitors', () => {
  const monitor = (overrides: object = {}) =>
    createMonitorSchema.safeParse({
      projectId: PROJECT,
      name: 'Orders health',
      endpointId: ENDPOINT,
      environmentId: ENVIRONMENT,
      type: 'STATUS',
      ...overrides,
    });

  it('defaults to a 5-minute check that is enabled', () => {
    const parsed = monitor();
    expect(parsed.success && parsed.data).toMatchObject({
      intervalSeconds: 300,
      enabled: true,
      assertions: [],
      latencyThresholdMs: null,
    });
  });

  it('only allows the offered intervals', () => {
    expect(monitor({ intervalSeconds: 60 }).success).toBe(true);
    expect(problems(monitor({ intervalSeconds: 30 }))).toEqual(['Choose an interval']);
  });

  /** Type rules apply to the complete configuration, which the server builds from defaults. */
  const config = (overrides: object = {}) =>
    monitorConfigSchema.safeParse({
      name: 'Orders health',
      endpointId: ENDPOINT,
      environmentId: ENVIRONMENT,
      type: 'STATUS',
      intervalSeconds: 300,
      timeoutMs: 5000,
      expectedStatus: null,
      latencyThresholdMs: null,
      assertions: [],
      enabled: true,
      ...overrides,
    });

  it('needs a latency threshold below the timeout for performance monitors', () => {
    expect(problems(config({ type: 'PERFORMANCE' }))).toEqual(['Enter a latency threshold']);
    expect(
      problems(config({ type: 'PERFORMANCE', timeoutMs: 1000, latencyThresholdMs: 1000 })),
    ).toEqual(['The threshold must be lower than the timeout']);
    expect(config({ type: 'PERFORMANCE', timeoutMs: 5000, latencyThresholdMs: 800 }).success).toBe(
      true,
    );
  });

  it('needs at least one well-formed check for response validation', () => {
    expect(problems(config({ type: 'RESPONSE_VALIDATION' }))).toEqual(['Add at least one check']);
    expect(
      config({
        type: 'RESPONSE_VALIDATION',
        assertions: [{ path: 'data..id', operator: 'exists' }],
      }).success,
    ).toBe(false);
    expect(
      problems(
        config({
          type: 'RESPONSE_VALIDATION',
          assertions: [{ path: 'status', operator: 'equals' }],
        }),
      ),
    ).toEqual(['Enter a value to compare with']);
    expect(
      config({
        type: 'RESPONSE_VALIDATION',
        assertions: [{ path: 'data.items.0.id', operator: 'exists' }],
      }).success,
    ).toBe(true);
  });
});
