import { describe, expect, it } from 'vitest';
import {
  assertPasswordAcceptable,
  hashPassword,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  PasswordPolicyError,
  verifyPassword,
} from './password.js';

const GOOD = 'Sasol#Rate2026';

describe('hashPassword / verifyPassword', () => {
  it('produces a bcrypt hash that verifies', async () => {
    const hash = await hashPassword(GOOD);
    expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    await expect(verifyPassword(GOOD, hash)).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword(GOOD);
    await expect(verifyPassword(`${GOOD}x`, hash)).resolves.toBe(false);
  });

  it('salts, so the same password hashes differently each time', async () => {
    const [a, b] = await Promise.all([hashPassword(GOOD), hashPassword(GOOD)]);
    expect(a).not.toBe(b);
    await expect(verifyPassword(GOOD, a)).resolves.toBe(true);
    await expect(verifyPassword(GOOD, b)).resolves.toBe(true);
  });

  it('returns false rather than throwing for an empty or malformed hash', async () => {
    await expect(verifyPassword(GOOD, '')).resolves.toBe(false);
    await expect(verifyPassword(GOOD, 'not-a-hash')).resolves.toBe(false);
  });
});

describe('password policy', () => {
  it('accepts a strong password', () => {
    expect(() => assertPasswordAcceptable(GOOD)).not.toThrow();
  });

  it(`rejects passwords under ${MIN_PASSWORD_LENGTH} characters`, () => {
    expect(() => assertPasswordAcceptable('Ab1!efgh')).toThrow(PasswordPolicyError);
  });

  it('rejects passwords with fewer than three character classes', () => {
    // lowercase + digit only
    expect(() => assertPasswordAcceptable('lowercase12345')).toThrow(/three of/i);
  });

  it(`rejects passwords longer than ${MAX_PASSWORD_BYTES} bytes`, () => {
    const tooLong = 'Aa1!'.repeat(30); // 120 bytes
    expect(() => assertPasswordAcceptable(tooLong)).toThrow(/at most/i);
  });

  it('counts bytes, not characters, for multi-byte input', () => {
    // 20 emoji = 80 UTF-8 bytes, so 84 bytes total from only 24 characters.
    // A character-count-only check would wrongly accept this.
    const multibyte = `Aa1!${'\u{1F600}'.repeat(20)}`;
    expect(multibyte.length).toBeLessThan(MAX_PASSWORD_BYTES);
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(MAX_PASSWORD_BYTES);
    expect(() => assertPasswordAcceptable(multibyte)).toThrow(/at most/i);
  });

  it('is enforced by hashPassword', async () => {
    await expect(hashPassword('short')).rejects.toThrow(PasswordPolicyError);
  });
});
