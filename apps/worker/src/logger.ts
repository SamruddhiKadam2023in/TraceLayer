import pino from 'pino';
import { env } from './config';

export const logger = pino({
  name: 'worker',
  level: env.LOG_LEVEL,
  redact: {
    paths: ['*.headers.authorization', '*.headers.cookie', '*.password', '*.token', '*.secret'],
    censor: '[REDACTED]',
  },
  ...(env.NODE_ENV === 'production'
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss' },
        },
      }),
});
