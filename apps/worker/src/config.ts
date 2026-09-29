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
});

export type WorkerEnv = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  console.error(`Invalid worker configuration:\n${issues.join('\n')}`);
  process.exit(1);
}

export const env: WorkerEnv = parsed.data;
