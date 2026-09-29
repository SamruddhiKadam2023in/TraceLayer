import { TEST_DATABASE_URL } from './test-database';

// Deterministic configuration for tests. Set before any app module loads, so the
// dotenv call in config/env.ts never overrides these values.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.FRONTEND_URL ??= 'http://localhost:5180';
process.env.JWT_SECRET ??= 'test-access-secret-that-is-long-enough-000';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-00';
process.env.ENCRYPTION_KEY ??= 'ZGV2LW9ubHktZW5jcnlwdGlvbi1rZXktMzJieXRlcyE=';
// Minimum bcrypt cost keeps the suite fast; production uses 12.
process.env.BCRYPT_ROUNDS = '4';
