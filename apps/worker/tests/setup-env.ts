import { TEST_DATABASE_URL } from './test-database';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.ENCRYPTION_KEY ??= 'ZGV2LW9ubHktZW5jcnlwdGlvbi1rZXktMzJieXRlcyE=';
