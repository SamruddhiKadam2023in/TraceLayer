import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({
  path: [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')],
  quiet: true,
});

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  /** Decrypts secret environment variables for monitor requests. Must match the API's key. */
  ENCRYPTION_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'ENCRYPTION_KEY must be 32 bytes, base64',
    ),
  /** Redis key prefix for BullMQ; must match the API's. */
  QUEUE_PREFIX: z.string().min(1).default('tracelayer'),
  /** SSRF protection off: local development only, never in production. */
  // ── Email notifications. An empty SMTP_HOST renders emails to the log instead of sending.
  SMTP_HOST: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().min(1).default('TraceLayer <alerts@tracelayer.local>'),
  /** Public URL of the web app, for links in notifications. */
  APP_URL: z.url().default('http://localhost:8080'),
  ALLOW_PRIVATE_NETWORK_TARGETS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type WorkerEnv = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  console.error(`Invalid worker configuration:\n${issues.join('\n')}`);
  process.exit(1);
}

export const env: WorkerEnv = parsed.data;
