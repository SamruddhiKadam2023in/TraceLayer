import {
  maskSecrets,
  prepareRequest,
  RequestPreparationError,
  SECRET_MASK,
  type RequestSpec,
  type ResolvedEnvironment,
} from './prepare';

const PRODUCTION: ResolvedEnvironment = {
  name: 'Production',
  baseUrl: 'https://api.example.com/v1',
  variables: [
    { key: 'ORDER_ID', value: '42', isSecret: false },
    { key: 'API_TOKEN', value: 'sk_live_abc+/=', isSecret: true },
    { key: 'PASSWORD', value: 'hunter2', isSecret: true },
    { key: 'EVIL', value: 'x\r\nX-Injected: yes', isSecret: false },
  ],
};

function spec(overrides: Partial<RequestSpec> = {}): RequestSpec {
  return {
    method: 'GET',
    url: '/orders/{{ORDER_ID}}',
    headers: [],
    queryParams: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    timeoutMs: 5000,
    ...overrides,
  };
}

function headerValue(headers: [string, string][], name: string): string | undefined {
  return headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
}

function preparationError(fn: () => unknown): RequestPreparationError {
  try {
    fn();
  } catch (err) {
    if (err instanceof RequestPreparationError) return err;
    throw err;
  }
  throw new Error('expected a RequestPreparationError');
}

describe('prepareRequest', () => {
  it('joins a relative path to the base URL and substitutes variables', () => {
    const req = prepareRequest(
      spec({
        queryParams: [
          { key: 'expand', value: 'items', enabled: true },
          { key: 'skipped', value: 'x', enabled: false },
        ],
      }),
      PRODUCTION,
    );
    expect(req.url.href).toBe('https://api.example.com/v1/orders/42?expand=items');
    expect(req.usesSecrets).toBe(false);
    expect(headerValue(req.headers, 'user-agent')).toMatch(/^TraceLayer\//);
  });

  it('keeps absolute URLs and skips disabled headers', () => {
    const req = prepareRequest(
      spec({
        url: 'https://api.example.com/v1/health',
        headers: [
          { key: 'Accept', value: 'application/json', enabled: true },
          { key: 'X-Off', value: '1', enabled: false },
        ],
      }),
      PRODUCTION,
    );
    expect(req.url.href).toBe('https://api.example.com/v1/health');
    expect(headerValue(req.headers, 'accept')).toBe('application/json');
    expect(headerValue(req.headers, 'x-off')).toBeUndefined();
  });

  it('builds bearer, basic and API-key authentication', () => {
    const bearer = prepareRequest(
      spec({ auth: { type: 'bearer', token: '{{API_TOKEN}}' } }),
      PRODUCTION,
    );
    expect(headerValue(bearer.headers, 'authorization')).toBe('Bearer sk_live_abc+/=');

    const basic = prepareRequest(
      spec({ auth: { type: 'basic', username: 'svc', password: '{{PASSWORD}}' } }),
      PRODUCTION,
    );
    const encoded = Buffer.from('svc:hunter2').toString('base64');
    expect(headerValue(basic.headers, 'authorization')).toBe(`Basic ${encoded}`);
    expect(basic.secretValues).toContain(encoded);

    const apiKey = prepareRequest(
      spec({ auth: { type: 'apiKey', in: 'query', name: 'key', value: '{{API_TOKEN}}' } }),
      PRODUCTION,
    );
    expect(apiKey.url.searchParams.get('key')).toBe('sk_live_abc+/=');
    const headerKey = prepareRequest(
      spec({ auth: { type: 'apiKey', in: 'header', name: 'X-Api-Key', value: '{{API_TOKEN}}' } }),
      PRODUCTION,
    );
    expect(headerKey.credentialHeaders).toContain('x-api-key');
  });

  it('sets content types for bodies unless one is given', () => {
    const json = prepareRequest(
      spec({ method: 'POST', body: { type: 'json', content: '{"id": {{ORDER_ID}}}' } }),
      PRODUCTION,
    );
    expect(json.body).toBe('{"id": 42}');
    expect(headerValue(json.headers, 'content-type')).toBe('application/json');

    const form = prepareRequest(
      spec({
        method: 'POST',
        body: { type: 'form', fields: [{ key: 'q', value: 'a b&c', enabled: true }] },
      }),
      PRODUCTION,
    );
    expect(form.body).toBe('q=a+b%26c');
    expect(headerValue(form.headers, 'content-type')).toBe('application/x-www-form-urlencoded');

    const custom = prepareRequest(
      spec({
        method: 'POST',
        headers: [{ key: 'content-type', value: 'application/vnd.api+json', enabled: true }],
        body: { type: 'json', content: '{}' },
      }),
      PRODUCTION,
    );
    expect(custom.headers.filter(([k]) => k.toLowerCase() === 'content-type')).toHaveLength(1);
  });

  it('reports every missing variable at once', () => {
    const err = preparationError(() =>
      prepareRequest(
        spec({ url: '/{{A}}/{{B}}', headers: [{ key: 'X', value: '{{A}}', enabled: true }] }),
        PRODUCTION,
      ),
    );
    expect(err.code).toBe('MISSING_VARIABLE');
    expect(err.message).toBe('Not defined in Production: A, B');
  });

  it('needs a base URL for relative paths', () => {
    const err = preparationError(() => prepareRequest(spec(), { ...PRODUCTION, baseUrl: null }));
    expect(err.code).toBe('NO_BASE_URL');
    expect(preparationError(() => prepareRequest(spec({ url: '/x' }), null)).code).toBe(
      'NO_BASE_URL',
    );
  });

  it('refuses header values that would inject extra headers', () => {
    const err = preparationError(() =>
      prepareRequest(
        spec({ headers: [{ key: 'X-Trace', value: '{{EVIL}}', enabled: true }] }),
        PRODUCTION,
      ),
    );
    expect(err.code).toBe('INVALID_HEADER_VALUE');
  });

  describe('secret origin rule', () => {
    it('allows secrets to the environment’s own origin', () => {
      const req = prepareRequest(
        spec({
          url: 'https://api.example.com/other',
          auth: { type: 'bearer', token: '{{API_TOKEN}}' },
        }),
        PRODUCTION,
      );
      expect(req.usesSecrets).toBe(true);
    });

    it.each([
      ['another host', 'https://attacker.example.net/collect'],
      ['a scheme downgrade', 'http://api.example.com/v1/orders'],
      ['another port', 'https://api.example.com:8443/v1/orders'],
    ])('refuses to send a secret to %s', (_label, url) => {
      const err = preparationError(() =>
        prepareRequest(spec({ url, auth: { type: 'bearer', token: '{{API_TOKEN}}' } }), PRODUCTION),
      );
      expect(err.code).toBe('SECRET_ORIGIN_MISMATCH');
    });

    it('applies to secrets anywhere, e.g. inside a body', () => {
      const err = preparationError(() =>
        prepareRequest(
          spec({
            method: 'POST',
            url: 'https://attacker.example.net/',
            body: { type: 'text', content: 'pw={{PASSWORD}}' },
          }),
          PRODUCTION,
        ),
      );
      expect(err.code).toBe('SECRET_ORIGIN_MISMATCH');
    });

    it('needs a base URL before secrets can be used at all', () => {
      const err = preparationError(() =>
        prepareRequest(
          spec({
            url: 'https://api.example.com/x',
            auth: { type: 'bearer', token: '{{API_TOKEN}}' },
          }),
          { ...PRODUCTION, baseUrl: null },
        ),
      );
      expect(err.code).toBe('SECRET_ORIGIN_MISMATCH');
    });
  });
});

describe('maskSecrets', () => {
  it('masks raw, percent-encoded and form-encoded forms', () => {
    const req = prepareRequest(
      spec({ auth: { type: 'apiKey', in: 'query', name: 'key', value: '{{API_TOKEN}}' } }),
      PRODUCTION,
    );
    const masked = maskSecrets(`${req.url.href} echo=sk_live_abc+/=`, req.secretValues);
    expect(masked).not.toContain('sk_live');
    expect(masked).toContain(SECRET_MASK);
  });
});
