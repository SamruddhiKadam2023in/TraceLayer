import { Redis } from 'ioredis';

/**
 * Before the suite:
 * 1. Fail fast, with instructions, when the stack under test is not running.
 * 2. Reset the sign-up and sign-in rate limits of a local stack. Every run registers a new
 *    account, and the API allows 5 sign-ups per hour per address, so repeated local runs would
 *    otherwise be refused (the limit working as designed). Only those two counters are cleared;
 *    set E2E_RESET_RATE_LIMITS=false to leave them alone. Skipped quietly when Redis is not
 *    reachable, e.g. against a remote deployment.
 */
export default async function globalSetup(): Promise<void> {
  await assertStackHealthy();
  if (process.env.E2E_RESET_RATE_LIMITS !== 'false') await resetAuthRateLimits();
}

async function assertStackHealthy(): Promise<void> {
  const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:8080';
  const health = `${baseUrl}/api/health`;
  let body: { data?: { status?: string; dependencies?: Record<string, { status: string }> } };
  try {
    const res = await fetch(health, { signal: AbortSignal.timeout(10_000) });
    body = (await res.json()) as typeof body;
  } catch (err) {
    throw new Error(
      `The app is not reachable at ${baseUrl} (${(err as Error).message}). ` +
        'Start it with `docker compose up -d --build`, or set E2E_BASE_URL.',
    );
  }
  const dependencies = body.data?.dependencies ?? {};
  const down = Object.entries(dependencies)
    .filter(([, check]) => check.status !== 'up')
    .map(([name]) => name);
  if (down.length) {
    throw new Error(`The stack is not healthy (${down.join(', ')} down); see ${health}.`);
  }
}

async function resetAuthRateLimits(): Promise<void> {
  const prefix = process.env.E2E_QUEUE_PREFIX || 'tracelayer';
  const redis = new Redis(process.env.E2E_REDIS_URL || 'redis://localhost:6379', {
    lazyConnect: true,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    for (const limiter of ['register', 'login']) {
      const keys = await redis.keys(`${prefix}:rate-limit:${limiter}:*`);
      if (keys.length) await redis.del(...keys);
    }
  } catch {
    // Not a local stack: nothing to reset.
  } finally {
    redis.disconnect();
  }
}
