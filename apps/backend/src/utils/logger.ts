import pino from 'pino';
import { env, isProduction } from '../config/env';

/**
 * Paths that must never reach log output in plaintext.
 * Covers inbound request headers and any outbound request config we log later.
 */
export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
  '*.secret',
  '*.apiKey',
  'headers.authorization',
  'headers.cookie',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: REDACTED_LOG_PATHS, censor: '[REDACTED]' },
  ...(isProduction || env.NODE_ENV === 'test'
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss' },
        },
      }),
});
