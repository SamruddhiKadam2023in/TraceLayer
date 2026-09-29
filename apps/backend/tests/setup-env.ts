// Deterministic configuration for tests; real infrastructure is mocked or provided by CI services.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL ??= 'postgresql://tracelayer:tracelayer@localhost:5434/tracelayer_test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.FRONTEND_URL ??= 'http://localhost:5180';
process.env.JWT_SECRET ??= 'test-access-secret-that-is-long-enough-000';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-00';
process.env.ENCRYPTION_KEY ??= 'ZGV2LW9ubHktZW5jcnlwdGlvbi1rZXktMzJieXRlcyE=';
