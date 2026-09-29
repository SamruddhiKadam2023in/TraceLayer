import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env';

/**
 * Authenticated encryption for secrets stored in the database (AES-256-GCM).
 * Output format: `v1.<iv>.<auth tag>.<ciphertext>`, each part base64url.
 * The version prefix leaves room for key rotation without guessing formats later.
 */
const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

const key = Buffer.from(env.ENCRYPTION_KEY, 'base64');

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

/** Throws if the value was tampered with, encrypted under another key, or malformed. */
export function decryptSecret(encoded: string): string {
  const [version, iv, tag, ciphertext] = encoded.split('.');
  if (version !== VERSION || iv === undefined || tag === undefined || ciphertext === undefined) {
    throw new Error('Unsupported secret format');
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
