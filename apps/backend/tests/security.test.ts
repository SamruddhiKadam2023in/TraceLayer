import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import express from 'express';
import request from 'supertest';
import { DEV_PLACEHOLDER_SECRETS, findInsecureSecrets, redactSensitive } from '@tracelayer/shared';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { errorHandler } from '../src/middleware/error-handler';
import { applyServerTimeouts, responseTimeout } from '../src/middleware/timeout';
import { createLogger } from '../src/utils/logger';

const run = promisify(execFile);

describe('CORS', () => {
  const app = createApp();

  it('lets only the configured frontend origin read responses', async () => {
    const allowed = await request(app).get('/api/health/live').set('Origin', env.FRONTEND_URL);
    expect(allowed.headers['access-control-allow-origin']).toBe(env.FRONTEND_URL);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const other = await request(app).get('/api/health/live').set('Origin', 'https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflights for the frontend only', async () => {
    const preflight = (origin: string) =>
      request(app)
        .options('/api/auth/login')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,authorization');
    const ok = await preflight(env.FRONTEND_URL);
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(env.FRONTEND_URL);
    const evil = await preflight('https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('Helmet', () => {
  it('sends a strict CSP and anti-framing, anti-sniffing and HSTS headers on API responses', async () => {
    const res = await request(createApp()).get('/api/health/live');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('global rate limit', () => {
  it('caps requests per client address across all routes, but never health checks', async () => {
    const app = createApp({ globalRateLimit: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/api/auth/me')).status).toBe(401);
    }
    const limited = await request(app).get('/api/auth/me');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();

    for (let i = 0; i < 5; i++) {
      expect((await request(app).get('/api/health/live')).status).toBe(200);
    }
  });
});

describe('request size and timeouts', () => {
  it('rejects oversized JSON before it reaches a handler', async () => {
    const res = await request(createApp())
      .post('/api/auth/login')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(1_100_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('answers 504 when a handler takes too long, and ignores its late result', async () => {
    const app = express();
    app.use(responseTimeout(50));
    let finished = false;
    app.get('/slow', async (_req, res) => {
      await new Promise((r) => setTimeout(r, 200));
      finished = true;
      res.json({ ok: true }); // too late: must not crash or send twice
    });
    app.get('/fast', (_req, res) => void res.json({ ok: true }));
    app.use(errorHandler);

    const slow = await request(app).get('/slow');
    expect(slow.status).toBe(504);
    expect(slow.body.error).toMatchObject({
      code: 'TIMEOUT',
      message: 'The server took too long to respond',
    });
    expect((await request(app).get('/fast')).status).toBe(200);
    await new Promise((r) => setTimeout(r, 250));
    expect(finished).toBe(true);
  });

  it('bounds how long a client may take to send headers and body', () => {
    const server = createServer();
    applyServerTimeouts(server);
    expect(server.headersTimeout).toBe(20_000);
    expect(server.requestTimeout).toBe(50_000);
    expect(server.keepAliveTimeout).toBe(65_000);
  });
});

describe('sensitive-log filtering', () => {
  function capture() {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    return { logger: createLogger(stream), output: () => lines.join('') };
  }

  it('never writes credentials, at any depth or inside messages', () => {
    const { logger, output } = capture();
    const err = Object.assign(
      new Error('upstream said: Authorization: Bearer eyJhbGciOi.payload.sig'),
      {
        config: { headers: { Authorization: 'Bearer leaked-1', 'X-API-Key': 'leaked-2' } },
      },
    );
    logger.info(
      {
        req: { headers: { authorization: 'Bearer leaked-3', cookie: 'tl_refresh=leaked-4' } },
        request: {
          url: 'https://api.example.com/x?token=leaked-5&page=2',
          body: { password: 'leaked-6' },
        },
        deep: { a: { b: { c: { clientSecret: 'leaked-7', smtpPassword: 'leaked-8' } } } },
        list: [{ apiKey: 'leaked-9' }],
      },
      'request sent',
    );
    logger.error({ err }, 'request failed');

    const text = output();
    for (let i = 1; i <= 9; i++) expect(text).not.toContain(`leaked-${i}`);
    expect(text).not.toContain('eyJhbGciOi');
    expect(text).toContain('[REDACTED]');
    // Useful context survives.
    expect(text).toContain('page=2');
    expect(text).toContain('upstream said');
    expect(text).toContain('request failed');
  });

  it('keeps ordinary values, dates and circular references safe', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    const when = new Date('2026-09-30T00:00:00.000Z');
    expect(redactSensitive({ circular, when, count: 3, tokensUsed: 5 })).toEqual({
      circular: { name: 'loop', self: '[Circular]' },
      when,
      count: 3,
      // Key names are matched broadly on purpose: over-redacting is the safe mistake.
      tokensUsed: '[REDACTED]',
    });
  });
});

describe('secrets', () => {
  it('flags development placeholders, "change-me" values and reused JWT secrets', () => {
    const [placeholder] = [...DEV_PLACEHOLDER_SECRETS];
    expect(findInsecureSecrets({ JWT_SECRET: placeholder })).toEqual(['JWT_SECRET']);
    expect(findInsecureSecrets({ ENCRYPTION_KEY: 'changeme-please' })).toEqual(['ENCRYPTION_KEY']);
    expect(
      findInsecureSecrets({ JWT_SECRET: 'x'.repeat(40), JWT_REFRESH_SECRET: 'x'.repeat(40) }),
    ).toEqual(['JWT_SECRET and JWT_REFRESH_SECRET must differ']);
    expect(
      findInsecureSecrets({
        JWT_SECRET: 'a-strong-random-access-secret-0123456789',
        JWT_REFRESH_SECRET: 'a-strong-random-refresh-secret-012345678',
        ENCRYPTION_KEY: 'q83vEjRWeJq83vEjRWeJq83vEjRWeJq83vEjRWeJq8M=',
      }),
    ).toEqual([]);
  });

  const startInProduction = (extra: Record<string, string>) =>
    run(
      process.execPath,
      [
        require.resolve('tsx/cli'),
        '-e',
        "import('./src/config/env').then(() => console.log('STARTED'))",
      ],
      {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...process.env,
          // Resolve workspace packages to their TypeScript sources, as `pnpm dev` does.
          NODE_OPTIONS: '--conditions=development',
          NODE_ENV: 'production',
          JWT_SECRET: 'change-me-dev-access-secret-at-least-32-chars',
          JWT_REFRESH_SECRET: 'change-me-dev-refresh-secret-at-least-32-chars',
          ...extra,
        },
        timeout: 30_000,
      },
    );

  it('refuses to start in production with development secrets', async () => {
    await expect(startInProduction({})).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Refusing to start in production with insecure secrets'),
    });
  });

  it('starts when the local stack opts in explicitly', async () => {
    const { stdout } = await startInProduction({ ALLOW_DEV_SECRETS: 'true' });
    expect(stdout).toContain('STARTED');
  });
});
