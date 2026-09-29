import { createSecretBox } from '@tracelayer/executor';
import { env } from '../config/env';

// Encryption for secret environment variables; the implementation lives in @tracelayer/executor
// so the worker can decrypt with exactly the same code.
const box = createSecretBox(env.ENCRYPTION_KEY);

export const encryptSecret = box.encrypt;
export const decryptSecret = box.decrypt;
