import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for secrets stored in the database (AES-256-GCM), shared by the API
 * (which encrypts and decrypts) and the worker (which decrypts to run monitors).
 * Output format: `v1.<iv>.<auth tag>.<ciphertext>`, each part base64url.
 * The version prefix leaves room for key rotation without guessing formats later.
 */
const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export interface SecretBox {
  encrypt: (plaintext: string) => string;
  /** Throws if the value was tampered with, encrypted under another key, or malformed. */
  decrypt: (encoded: string) => string;
}

/** `keyBase64` must decode to exactly 32 bytes (the ENCRYPTION_KEY setting). */
export function createSecretBox(keyBase64: string): SecretBox {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes (base64)');

  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        VERSION,
        iv.toString('base64url'),
        tag.toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.');
    },
    decrypt(encoded) {
      const [version, iv, tag, ciphertext] = encoded.split('.');
      if (
        version !== VERSION ||
        iv === undefined ||
        tag === undefined ||
        ciphertext === undefined
      ) {
        throw new Error('Unsupported secret format');
      }
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
