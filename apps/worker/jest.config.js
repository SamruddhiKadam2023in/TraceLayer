/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@tracelayer/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^@tracelayer/db$': '<rootDir>/../../packages/db/src/index.ts',
  },
  clearMocks: true,
};
