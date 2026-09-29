import {
  ipKeyGenerator,
  rateLimit,
  type ClientRateLimitInfo,
  type Options,
  type Store,
} from 'express-rate-limit';
import type { Request } from 'express';
import { env } from '../config/env';
import { redis } from '../lib/redis';
import { AppError } from '../utils/errors';

const MINUTE_MS = 60_000;

/**
 * Fixed-window counters in Redis, shared by every API instance.
 * INCR and PEXPIRE NX run in one MULTI, so a window's expiry is set exactly once.
 */
export class RedisRateLimitStore implements Store {
  readonly prefix: string;
  private windowMs = MINUTE_MS;

  constructor(name: string) {
    this.prefix = `tracelayer:rate-limit:${name}:`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const redisKey = this.prefix + key;
    const results = await redis
      .multi()
      .incr(redisKey)
      .pexpire(redisKey, this.windowMs, 'NX')
      .pttl(redisKey)
      .exec();
    if (!results) throw new Error('Rate-limit transaction was aborted');
    for (const [err] of results) if (err) throw err;

    const totalHits = Number(results[0]?.[1]);
    const ttlMs = Number(results[2]?.[1]);
    return {
      totalHits,
      resetTime: new Date(Date.now() + (ttlMs > 0 ? ttlMs : this.windowMs)),
    };
  }

  async decrement(key: string): Promise<void> {
    await redis.decr(this.prefix + key);
  }

  async resetKey(key: string): Promise<void> {
    await redis.del(this.prefix + key);
  }
}

interface LimiterConfig {
  name: string;
  windowMs: number;
  limit: number;
  message: string;
  /** Only failed requests count, e.g. so successful logins never lock a user out. */
  skipSuccessfulRequests?: boolean;
  /** Count per signed-in user instead of per client IP. Mount after `requireAuth`. */
  perUser?: boolean;
}

/** The signed-in user's id, falling back to the client IP (IPv6 grouped by /56 subnet). */
function userKey(req: Request): string {
  return req.auth ? `user:${req.auth.userId}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;
}

function createLimiter(config: LimiterConfig) {
  return rateLimit({
    windowMs: config.windowMs,
    limit: config.limit,
    skipSuccessfulRequests: config.skipSuccessfulRequests ?? false,
    ...(config.perUser ? { keyGenerator: userKey } : {}),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Tests get an in-memory store per app instance, so suites stay independent of Redis.
    store: env.NODE_ENV === 'test' ? undefined : new RedisRateLimitStore(config.name),
    // Fail open: if Redis is unreachable, availability wins over throttling.
    passOnStoreError: true,
    handler: (_req, _res, next) => next(new AppError('RATE_LIMITED', config.message)),
  });
}

/** Limits on actions that create data, counted per signed-in user. */
export function createWorkspaceRateLimiters() {
  return {
    createWorkspace: createLimiter({
      name: 'workspace-create',
      windowMs: 60 * MINUTE_MS,
      limit: 20,
      perUser: true,
      message: 'Too many workspaces created. Try again later.',
    }),
    addMember: createLimiter({
      name: 'member-add',
      windowMs: 15 * MINUTE_MS,
      limit: 30,
      perUser: true,
      message: 'Too many members added. Try again in a few minutes.',
    }),
  };
}

export function createProjectRateLimiters() {
  return {
    createProject: createLimiter({
      name: 'project-create',
      windowMs: 60 * MINUTE_MS,
      limit: 30,
      perUser: true,
      message: 'Too many projects created. Try again later.',
    }),
  };
}

export function createEndpointRateLimiters() {
  return {
    createEndpoint: createLimiter({
      name: 'endpoint-create',
      windowMs: 60 * MINUTE_MS,
      limit: 100,
      perUser: true,
      message: 'Too many endpoints created. Try again later.',
    }),
  };
}

export function createRequestRateLimiters() {
  return {
    // Each execution makes an outbound request, so this also caps use of the platform as a proxy.
    execute: createLimiter({
      name: 'request-execute',
      windowMs: MINUTE_MS,
      limit: 60,
      perUser: true,
      message: 'Too many requests sent. Wait a minute and try again.',
    }),
  };
}

/** Rate limiters are built per app so each `createApp()` (and each test) starts fresh. */
export function createAuthRateLimiters() {
  return {
    login: createLimiter({
      name: 'login',
      windowMs: 15 * MINUTE_MS,
      limit: 10,
      skipSuccessfulRequests: true,
      message: 'Too many failed sign-in attempts. Try again in a few minutes.',
    }),
    register: createLimiter({
      name: 'register',
      windowMs: 60 * MINUTE_MS,
      limit: 5,
      message: 'Too many accounts created from this network. Try again later.',
    }),
    refresh: createLimiter({
      name: 'refresh',
      windowMs: 15 * MINUTE_MS,
      limit: 60,
      message: 'Too many session refreshes. Try again in a few minutes.',
    }),
  };
}
