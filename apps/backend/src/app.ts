import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { logger } from './utils/logger';
import { createApiRouter } from './routes';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { createGlobalRateLimiter } from './middleware/rate-limit';
import { responseTimeout, RESPONSE_TIMEOUT_MS } from './middleware/timeout';

export const JSON_BODY_LIMIT = '1mb';
export const GLOBAL_RATE_LIMIT_PER_MINUTE = 600;

export interface AppOptions {
  /** Requests per minute per client IP across the whole API. */
  globalRateLimit?: number;
  responseTimeoutMs?: number;
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();

  app.disable('x-powered-by');
  // One reverse proxy (nginx / platform load balancer) sits in front in every deployment.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      // An allowlist: only a matching Origin is echoed back; any other gets no CORS headers.
      origin: [env.FRONTEND_URL],
      credentials: true,
    }),
  );
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id =
          typeof incoming === 'string' && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url?.startsWith('/api/health') ?? false },
      // Allowlist what request logs contain: headers (auth, cookies) are never logged.
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(responseTimeout(options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(cookieParser());

  app.use(
    '/api',
    createGlobalRateLimiter(options.globalRateLimit ?? GLOBAL_RATE_LIMIT_PER_MINUTE),
    createApiRouter(),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
