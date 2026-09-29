/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@tracelayer/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^@tracelayer/db$': '<rootDir>/../../packages/db/src/index.ts',
    '^@tracelayer/executor$': '<rootDir>/../../packages/executor/src/index.ts',
  },
  globalSetup: '<rootDir>/tests/global-setup.ts',
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  // Integration suites share one database, so files run one at a time.
  maxWorkers: 1,
  clearMocks: true,
};
