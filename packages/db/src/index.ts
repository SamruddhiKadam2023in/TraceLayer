import { PrismaClient } from '../generated/client';

export * from '../generated/client';

export interface CreatePrismaClientOptions {
  logQueries?: boolean;
}

export function createPrismaClient(options: CreatePrismaClientOptions = {}): PrismaClient {
  return new PrismaClient({
    log: options.logQueries ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });
}
