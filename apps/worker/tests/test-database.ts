/**
 * The worker's integration tests use their own database, separate from the backend's, so the
 * two suites can run in parallel without truncating each other's tables.
 */
export const TEST_DATABASE_URL =
  process.env.WORKER_TEST_DATABASE_URL ??
  'postgresql://tracelayer:tracelayer@localhost:5434/tracelayer_worker_test?schema=public';

const databaseName = new URL(TEST_DATABASE_URL).pathname.slice(1);
if (!databaseName.endsWith('_test')) {
  throw new Error(`Refusing to run tests against "${databaseName}": name must end in _test`);
}
