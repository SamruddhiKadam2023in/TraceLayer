import { REDIS_KEYS, type DependencyHealth, type HealthReport } from '@tracelayer/shared';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';

const APP_VERSION = process.env.npm_package_version ?? '0.1.0';
const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

async function probe(check: () => Promise<unknown>): Promise<DependencyHealth> {
  const start = performance.now();
  try {
    await withTimeout(check(), CHECK_TIMEOUT_MS);
    return { status: 'up', latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return {
      status: 'down',
      latencyMs: null,
      error: err instanceof Error ? err.message : 'unknown error',
    };
  }
}

export async function getHealthReport(): Promise<HealthReport> {
  const [database, redisHealth] = await Promise.all([
    probe(() => prisma.$queryRaw`SELECT 1`),
    probe(() => redis.ping()),
  ]);

  let lastHeartbeatAt: string | null = null;
  if (redisHealth.status === 'up') {
    lastHeartbeatAt = await redis.get(REDIS_KEYS.WORKER_HEARTBEAT).catch(() => null);
  }
  // The heartbeat key expires on its own, so its presence alone means the worker is alive.
  const worker: HealthReport['dependencies']['worker'] = lastHeartbeatAt
    ? { status: 'up', latencyMs: null, lastHeartbeatAt }
    : { status: 'down', latencyMs: null, lastHeartbeatAt: null, error: 'no recent heartbeat' };

  const allUp = [database, redisHealth, worker].every((d) => d.status === 'up');

  return {
    status: allUp ? 'ok' : 'degraded',
    version: APP_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    dependencies: { database, redis: redisHealth, worker },
  };
}
