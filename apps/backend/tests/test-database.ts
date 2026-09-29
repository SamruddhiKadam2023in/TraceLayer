/**
 * Integration tests run against a dedicated database, reset before every run.
 * Deliberately NOT read from DATABASE_URL, so a developer's shell or .env can never
 * point the test suite at real data.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://tracelayer:tracelayer@localhost:5434/tracelayer_test?schema=public';

const databaseName = new URL(TEST_DATABASE_URL).pathname.slice(1);
if (!databaseName.endsWith('_test')) {
  throw new Error(`Refusing to run tests against "${databaseName}": name must end in _test`);
}
