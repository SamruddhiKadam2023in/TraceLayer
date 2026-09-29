import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env from the package dir or the monorepo root. Existing process env always wins,
// so container/platform-provided values are never overridden by a stray file.
dotenv.config({
  path: [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')],
  quiet: true,
});

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  BACKEND_PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_URL: z.url().default('http://localhost:5180'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  ENCRYPTION_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'ENCRYPTION_KEY must be 32 bytes, base64',
    ),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    // Logger depends on env, so fail loudly on stderr before anything else starts.
    console.error(`Invalid environment configuration:\n${issues.join('\n')}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
export const isProduction = env.NODE_ENV === 'production';
