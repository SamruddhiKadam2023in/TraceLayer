import { execSync } from 'node:child_process';
import path from 'node:path';
import { TEST_DATABASE_URL } from './test-database';

/**
 * Brings the test database up to the current migrations. `migrate deploy` only applies
 * pending migrations and never drops data; tests empty their tables themselves.
 */
export default function globalSetup(): void {
  execSync('pnpm exec prisma migrate deploy', {
    cwd: path.resolve(__dirname, '../../../packages/db'),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
}
