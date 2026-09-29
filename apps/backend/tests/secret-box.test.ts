import { decryptSecret, encryptSecret } from '../src/utils/secret-box';

describe('secret-box (AES-256-GCM)', () => {
  it('round-trips values, including unicode and empty strings', () => {
    for (const value of ['sk_live_123', 'pässwörd 🔑', '']) {
      expect(decryptSecret(encryptSecret(value))).toBe(value);
    }
  });

  it('uses a fresh IV, so equal values encrypt differently', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('never contains the plaintext', () => {
    const encrypted = encryptSecret('super-secret-api-key');
    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain('super-secret-api-key');
  });

  it('rejects tampered ciphertext instead of returning garbage', () => {
    const [version, iv, tag, ciphertext] = encryptSecret('api-key').split('.');
    const flipped = `${ciphertext![0] === 'A' ? 'B' : 'A'}${ciphertext!.slice(1)}`;
    expect(() => decryptSecret([version, iv, tag, flipped].join('.'))).toThrow();
  });

  it('rejects unknown formats', () => {
    expect(() => decryptSecret('plaintext')).toThrow('Unsupported secret format');
    expect(() => decryptSecret('v2.a.b.c')).toThrow('Unsupported secret format');
  });
});
