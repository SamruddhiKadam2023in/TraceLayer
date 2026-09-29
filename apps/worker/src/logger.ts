import pino from 'pino';
import { env } from './config';

export const logger = pino({
  name: 'worker',
  level: env.LOG_LEVEL,
  redact: {
    paths: ['*.headers.authorization', '*.headers.cookie', '*.password', '*.token', '*.secret'],
    censor: '[REDACTED]',
  },
  // Pretty printing runs in a worker thread; keep it out of production and tests.
  ...(env.NODE_ENV === 'production' || env.NODE_ENV === 'test'
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss' },
        },
      }),
});
