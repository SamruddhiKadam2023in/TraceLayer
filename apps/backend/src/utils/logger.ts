import pino, { type DestinationStream, type LoggerOptions } from 'pino';
import { redactSensitive } from '@tracelayer/shared';
import { env, isProduction } from '../config/env';

/**
 * Paths that must never reach log output in plaintext (fast path, applied by pino itself).
 * Everything else still passes through `redactSensitive`, which masks sensitive keys at any
 * depth and credentials inside strings (spec §42: never log Authorization, cookies, API keys
 * or secrets).
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

export function loggerOptions(level: string = env.LOG_LEVEL): LoggerOptions {
  return {
    level,
    redact: { paths: REDACTED_LOG_PATHS, censor: '[REDACTED]' },
    formatters: {
      log: (object) => redactSensitive(object) as Record<string, unknown>,
    },
  };
}

/** A logger with the production redaction rules, writing to `destination` (tests capture it). */
export function createLogger(destination: DestinationStream, level = 'info') {
  return pino(loggerOptions(level), destination);
}

export const logger = pino({
  ...loggerOptions(),
  ...(isProduction || env.NODE_ENV === 'test'
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss' },
        },
      }),
});
