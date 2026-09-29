import request from 'supertest';
import { REDIS_KEYS } from '@tracelayer/shared';

const mockQueryRaw = jest.fn();
const mockPing = jest.fn();
const mockGet = jest.fn();

jest.mock('../src/lib/prisma', () => ({ prisma: { $queryRaw: mockQueryRaw } }));
jest.mock('../src/lib/redis', () => ({ redis: { ping: mockPing, get: mockGet } }));

// Import after mocks are registered.
import { createApp } from '../src/app';

const app = createApp();

describe('GET /api/health', () => {
  it('reports ok when database, redis and worker are all up', async () => {
    mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
    mockPing.mockResolvedValue('PONG');
    mockGet.mockResolvedValue('2026-09-29T10:00:00.000Z');

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.dependencies.database.status).toBe('up');
    expect(res.body.data.dependencies.redis.status).toBe('up');
    expect(res.body.data.dependencies.worker).toMatchObject({
      status: 'up',
      lastHeartbeatAt: '2026-09-29T10:00:00.000Z',
    });
    expect(mockGet).toHaveBeenCalledWith(REDIS_KEYS.WORKER_HEARTBEAT);
  });

  it('is degraded but serving when only the worker heartbeat is missing', async () => {
    mockQueryRaw.mockResolvedValue([]);
    mockPing.mockResolvedValue('PONG');
    mockGet.mockResolvedValue(null);

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('degraded');
    expect(res.body.data.dependencies.worker.status).toBe('down');
  });

  it('returns 503 when the database is unreachable', async () => {
    mockQueryRaw.mockRejectedValue(new Error('connect ECONNREFUSED'));
    mockPing.mockResolvedValue('PONG');
    mockGet.mockResolvedValue(null);

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body.data.dependencies.database).toMatchObject({
      status: 'down',
      error: 'connect ECONNREFUSED',
    });
  });

  it('does not query the worker heartbeat when redis is down', async () => {
    mockQueryRaw.mockResolvedValue([]);
    mockPing.mockRejectedValue(new Error('redis down'));

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(503);
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('GET /api/health/live', () => {
  it('responds without touching dependencies', async () => {
    const res = await request(app).get('/api/health/live');
    expect(res.status).toBe(200);
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });
});

describe('error envelope', () => {
  it('returns NOT_FOUND for unknown routes', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Route GET /api/does-not-exist not found' },
    });
    expect(typeof res.body.error.requestId).toBe('string');
  });

  it('returns VALIDATION_ERROR for malformed JSON', async () => {
    const res = await request(app)
      .post('/api/anything')
      .set('content-type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns PAYLOAD_TOO_LARGE for bodies over the limit', async () => {
    const res = await request(app)
      .post('/api/anything')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(1_100_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('request metadata and security headers', () => {
  it('echoes a well-formed x-request-id', async () => {
    const res = await request(app).get('/api/health/live').set('x-request-id', 'req_abc123');
    expect(res.headers['x-request-id']).toBe('req_abc123');
  });

  it('replaces a malformed x-request-id with a generated one', async () => {
    const res = await request(app).get('/api/health/live').set('x-request-id', 'bad id <script>');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets helmet headers and hides x-powered-by', async () => {
    const res = await request(app).get('/api/health/live');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
