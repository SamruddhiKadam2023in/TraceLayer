import type { ResolvedEnvironment } from '@tracelayer/executor';
import { prisma } from '../lib/prisma';
import { AppError } from '../utils/errors';
import { decryptSecret } from '../utils/secret-box';

/**
 * Loads a project's environment with secret values decrypted, for building requests.
 * Server-side only: the result must never be returned to a client.
 */
export async function loadResolvedEnvironment(
  projectId: string,
  environmentId: string | null,
): Promise<ResolvedEnvironment | null> {
  if (environmentId === null) return null;
  const environment = await prisma.environment.findFirst({
    where: { id: environmentId, projectId },
    include: { variables: true },
  });
  if (!environment) {
    const message = 'Environment not found in this project';
    throw new AppError('NOT_FOUND', message, [{ path: 'environmentId', message }]);
  }
  return {
    name: environment.name,
    baseUrl: environment.baseUrl,
    variables: environment.variables.map((v) => ({
      key: v.key,
      isSecret: v.isSecret,
      value: v.isSecret ? decryptSecret(v.encryptedValue ?? '') : (v.value ?? ''),
    })),
  };
}
