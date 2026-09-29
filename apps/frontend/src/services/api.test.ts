import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/stores/auth.store';
import { installFakeApi, makeSession, ok, UNAUTHENTICATED, type Handler } from '@/test/fake-api';
import { api } from './api';

/** A protected endpoint that only accepts the given access token. */
function protectedEndpoint(validToken: string): Handler {
  return (config) =>
    config.headers.get('Authorization') === `Bearer ${validToken}`
      ? [200, ok({ secret: 42 })]
      : UNAUTHENTICATED;
}

describe('API client session renewal', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession(makeSession({ accessToken: 'expired-token' }));
  });

  it('renews an expired access token once for concurrent requests and retries them', async () => {
    const fake = installFakeApi({
      'GET /things': protectedEndpoint('fresh-token'),
      'POST /auth/refresh': [200, ok(makeSession({ accessToken: 'fresh-token' }))],
    });

    const results = await Promise.all([api.get('/things'), api.get('/things'), api.get('/things')]);

    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(fake.callsTo('POST', '/auth/refresh')).toHaveLength(1);
    expect(useAuthStore.getState().accessToken).toBe('fresh-token');
  });

  it('signs out locally and rejects the request when renewal fails', async () => {
    const fake = installFakeApi({
      'GET /things': UNAUTHENTICATED,
      'POST /auth/refresh': UNAUTHENTICATED,
    });

    await expect(api.get('/things')).rejects.toMatchObject({ response: { status: 401 } });
    expect(useAuthStore.getState()).toMatchObject({ status: 'anonymous', accessToken: null });
    // No retry loop: one original request, one refresh.
    expect(fake.callsTo('GET', '/things')).toHaveLength(1);
  });

  it('retries only once when the renewed token is also rejected', async () => {
    const fake = installFakeApi({
      'GET /things': UNAUTHENTICATED,
      'POST /auth/refresh': [200, ok(makeSession({ accessToken: 'fresh-token' }))],
    });

    await expect(api.get('/things')).rejects.toMatchObject({ response: { status: 401 } });
    expect(fake.callsTo('GET', '/things')).toHaveLength(2);
    expect(fake.callsTo('POST', '/auth/refresh')).toHaveLength(1);
  });

  it('does not try to renew the session for the auth endpoints themselves', async () => {
    const fake = installFakeApi({ 'POST /auth/refresh': UNAUTHENTICATED });

    await expect(api.post('/auth/refresh', null, { skipAuthRefresh: true })).rejects.toMatchObject({
      response: { status: 401 },
    });
    // Only the call itself: a failing refresh never triggers another refresh.
    expect(fake.callsTo('POST', '/auth/refresh')).toHaveLength(1);
  });
});
