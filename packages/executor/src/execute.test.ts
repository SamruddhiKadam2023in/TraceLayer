import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { executeRequest } from './execute';
import { prepareRequest, SECRET_MASK, type RequestSpec, type ResolvedEnvironment } from './prepare';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

interface TestServer {
  origin: string;
  received: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[];
  close: () => Promise<void>;
}

async function startServer(handler: Handler): Promise<TestServer> {
  const received: TestServer['received'] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function environment(baseUrl: string, secret = 'sk_live_secret_value'): ResolvedEnvironment {
  return {
    name: 'Local',
    baseUrl,
    variables: [
      { key: 'API_TOKEN', value: secret, isSecret: true },
      { key: 'NAME', value: 'ada', isSecret: false },
    ],
  };
}

function spec(overrides: Partial<RequestSpec> = {}): RequestSpec {
  return {
    method: 'GET',
    url: '/',
    headers: [],
    queryParams: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    timeoutMs: 3000,
    ...overrides,
  };
}

// Test servers listen on 127.0.0.1, which SSRF protection blocks unless explicitly allowed.
const LOCAL = { allowPrivateNetwork: true };

const servers: TestServer[] = [];
async function server(handler: Handler): Promise<TestServer> {
  const s = await startServer(handler);
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('executeRequest', () => {
  it('sends the request and captures status, headers, body, size and timing', async () => {
    const s = await server((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-request-id': 'abc' });
      res.end('{"ok":true}');
    });
    const result = await executeRequest(
      prepareRequest(
        spec({
          method: 'POST',
          url: '/users/{{NAME}}',
          queryParams: [{ key: 'verbose', value: '1', enabled: true }],
          body: { type: 'json', content: '{"name":"{{NAME}}"}' },
        }),
        environment(`http://127.0.0.1:${new URL((await Promise.resolve(s)).origin).port}`),
      ),
      LOCAL,
    );

    expect(result.error).toBeNull();
    expect(result.response).toMatchObject({
      status: 201,
      contentType: 'application/json',
      body: '{"ok":true}',
      bodyKind: 'text',
      sizeBytes: 11,
      truncated: false,
    });
    expect(result.response?.headers).toContainEqual(['x-request-id', 'abc']);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.timeToFirstByteMs).not.toBeNull();
    expect(s.received[0]).toMatchObject({
      method: 'POST',
      url: '/users/ada?verbose=1',
      body: '{"name":"ada"}',
    });
    expect(s.received[0]?.headers['content-type']).toBe('application/json');
  });

  it('masks secrets in the returned request, response headers and body', async () => {
    const s = await server((req, res) => {
      // An "echo" endpoint that reflects the credential back.
      res.writeHead(200, {
        'content-type': 'text/plain',
        'x-echo': req.headers.authorization ?? '',
      });
      res.end(`you sent ${req.headers.authorization}`);
    });
    const result = await executeRequest(
      prepareRequest(
        spec({ auth: { type: 'bearer', token: '{{API_TOKEN}}' } }),
        environment(s.origin),
      ),
      LOCAL,
    );

    // The real secret reached the server...
    expect(s.received[0]?.headers.authorization).toBe('Bearer sk_live_secret_value');
    // ...but never comes back out.
    const everything = JSON.stringify(result);
    expect(everything).not.toContain('sk_live_secret_value');
    expect(result.response?.body).toBe(`you sent Bearer ${SECRET_MASK}`);
    expect(result.request.headers).toContainEqual(['Authorization', `Bearer ${SECRET_MASK}`]);
  });

  it('decodes gzip responses', async () => {
    const s = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync('{"compressed":true}'));
    });
    const result = await executeRequest(prepareRequest(spec(), environment(s.origin)), LOCAL);
    expect(result.response?.body).toBe('{"compressed":true}');
  });

  it('caps the body at the size limit, counting decoded bytes (compression bombs)', async () => {
    const s = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(gzipSync('a'.repeat(5_000_000))); // ~5 KB compressed, 5 MB decoded
    });
    const result = await executeRequest(prepareRequest(spec(), environment(s.origin)), {
      ...LOCAL,
      maxResponseBytes: 1000,
    });
    expect(result.response).toMatchObject({ sizeBytes: 1000, truncated: true });
    expect(result.response?.body).toHaveLength(1000);
  });

  it('reports binary bodies without returning them as text', async () => {
    const s = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    });
    const result = await executeRequest(prepareRequest(spec(), environment(s.origin)), LOCAL);
    expect(result.response).toMatchObject({ bodyKind: 'binary', body: null, sizeBytes: 6 });
  });

  it('times out slow servers within the configured budget', async () => {
    const s = await server((_req, res) => {
      setTimeout(() => res.end('late'), 2000);
    });
    const started = Date.now();
    const result = await executeRequest(
      prepareRequest(spec({ timeoutMs: 300 }), environment(s.origin)),
      LOCAL,
    );
    expect(result.error?.code).toBe('TIMEOUT');
    expect(result.response).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('reports refused connections', async () => {
    const s = await server((_req, res) => res.end());
    const origin = s.origin;
    await s.close();
    servers.length = 0;
    const result = await executeRequest(prepareRequest(spec(), environment(origin)), LOCAL);
    expect(result.error?.code).toBe('CONNECTION_REFUSED');
  });

  describe('SSRF protection', () => {
    it('blocks private addresses unless explicitly allowed', async () => {
      const s = await server((_req, res) => res.end('should not be reached'));
      const result = await executeRequest(prepareRequest(spec(), environment(s.origin)));
      expect(result.error?.code).toBe('BLOCKED_TARGET');
      expect(s.received).toHaveLength(0);
    });

    it('blocks cloud metadata and localhost names', async () => {
      for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:9/']) {
        const result = await executeRequest(prepareRequest(spec({ url }), null));
        expect(result.error?.code).toBe('BLOCKED_TARGET');
      }
    });

    it('re-checks every redirect hop', async () => {
      const s = await server((_req, res) => {
        res.writeHead(302, { location: 'file:///etc/passwd' });
        res.end();
      });
      const result = await executeRequest(prepareRequest(spec(), environment(s.origin)), LOCAL);
      expect(result.error?.code).toBe('BLOCKED_TARGET');
    });
  });

  describe('redirects', () => {
    it('follows same-origin redirects and records them', async () => {
      const s = await server((req, res) => {
        if (req.url === '/old') {
          res.writeHead(301, { location: '/new' });
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('moved');
        }
      });
      const result = await executeRequest(
        prepareRequest(spec({ url: '/old' }), environment(s.origin)),
        LOCAL,
      );
      expect(result.response?.body).toBe('moved');
      expect(result.redirects).toEqual([{ status: 301, location: `${s.origin}/new` }]);
      expect(result.request.url).toBe(`${s.origin}/new`);
    });

    it('switches to GET without a body on 303', async () => {
      const s = await server((req, res) => {
        if (req.url === '/submit') {
          res.writeHead(303, { location: '/result' });
          res.end();
        } else {
          res.end('done');
        }
      });
      await executeRequest(
        prepareRequest(
          spec({ method: 'POST', url: '/submit', body: { type: 'text', content: 'x' } }),
          environment(s.origin),
        ),
        LOCAL,
      );
      expect(s.received[1]).toMatchObject({ method: 'GET', url: '/result', body: '' });
    });

    it('drops credentials on a cross-origin redirect', async () => {
      const other = await server((_req, res) => res.end('other origin'));
      const s = await server((_req, res) => {
        res.writeHead(302, { location: `${other.origin}/landing` });
        res.end();
      });
      await executeRequest(
        prepareRequest(
          spec({ headers: [{ key: 'Authorization', value: 'Bearer plain-token', enabled: true }] }),
          environment(s.origin),
        ),
        LOCAL,
      );
      expect(s.received[0]?.headers.authorization).toBe('Bearer plain-token');
      expect(other.received[0]?.headers.authorization).toBeUndefined();
    });

    it('does not follow a cross-origin redirect at all when secrets are in use', async () => {
      const other = await server((_req, res) => res.end('should not be reached'));
      const s = await server((_req, res) => {
        res.writeHead(302, { location: `${other.origin}/steal` });
        res.end();
      });
      const result = await executeRequest(
        prepareRequest(
          spec({ auth: { type: 'bearer', token: '{{API_TOKEN}}' } }),
          environment(s.origin),
        ),
        LOCAL,
      );
      expect(result.response?.status).toBe(302);
      expect(result.note).toMatch(/was not followed/);
      expect(other.received).toHaveLength(0);
    });

    it('stops after the redirect limit', async () => {
      let hops = 0;
      const s = await server((_req, res) => {
        hops++;
        res.writeHead(302, { location: `/loop${hops}` });
        res.end();
      });
      const result = await executeRequest(prepareRequest(spec(), environment(s.origin)), {
        ...LOCAL,
        maxRedirects: 3,
      });
      expect(result.redirects).toHaveLength(3);
      expect(result.response?.status).toBe(302);
      expect(hops).toBe(4);
    });
  });
});
