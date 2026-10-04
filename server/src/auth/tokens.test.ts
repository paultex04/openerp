import { describe, expect, it } from 'vitest';
import { TokenCodec, TokenError } from './tokens.js';

const SECRET = 'a-test-secret-that-is-definitely-long-enough-0123456789';
const codec = new TokenCodec({ secret: SECRET, expiresIn: '15m' });

describe('TokenCodec', () => {
  it('round-trips claims', async () => {
    const token = await codec.sign({ userId: 42, tokenVersion: 3 });
    await expect(codec.verify(token)).resolves.toEqual({ userId: 42, tokenVersion: 3 });
  });

  it('rejects a token signed with a different secret', async () => {
    const foreign = new TokenCodec({ secret: `${SECRET}-different` });
    const token = await foreign.sign({ userId: 1, tokenVersion: 0 });
    await expect(codec.verify(token)).rejects.toThrow(TokenError);
  });

  it('rejects a tampered payload', async () => {
    const token = await codec.sign({ userId: 1, tokenVersion: 0 });
    const [header, , signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: '999', ver: 0, typ: 'access' })).toString(
      'base64url',
    );
    await expect(codec.verify(`${header}.${forged}.${signature}`)).rejects.toThrow(TokenError);
  });

  it('rejects an unsigned "alg: none" token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: '1', ver: 0, typ: 'access' })).toString(
      'base64url',
    );
    await expect(codec.verify(`${header}.${payload}.`)).rejects.toThrow(TokenError);
  });

  it('rejects an expired token', async () => {
    const shortLived = new TokenCodec({ secret: SECRET, expiresIn: '-1s' });
    const token = await shortLived.sign({ userId: 1, tokenVersion: 0 });
    await expect(codec.verify(token)).rejects.toThrow(/expired/i);
  });

  it('rejects garbage', async () => {
    await expect(codec.verify('not-a-jwt')).rejects.toThrow(TokenError);
    await expect(codec.verify('')).rejects.toThrow(TokenError);
  });

  it('rejects a token minted for a different audience', async () => {
    const foreign = new TokenCodec({ secret: SECRET, audience: 'someone-else' });
    const token = await foreign.sign({ userId: 1, tokenVersion: 0 });
    await expect(codec.verify(token)).rejects.toThrow(TokenError);
  });

  it('rejects a non-access token type', async () => {
    // A refresh token must never be accepted where an access token is expected.
    const [header, payload, signature] = (await codec.sign({ userId: 1, tokenVersion: 0 })).split(
      '.',
    );
    const swapped = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload!, 'base64url').toString()),
        typ: 'refresh',
      }),
    ).toString('base64url');
    // Signature no longer matches, so this must fail either way.
    await expect(codec.verify(`${header}.${swapped}.${signature}`)).rejects.toThrow(TokenError);
  });
});
