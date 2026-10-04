/**
 * Session tokens.
 *
 * The JWT is a compact, signed (HS256) bearer token delivered in an HTTP-only
 * cookie so that client-side JavaScript can never read it, which removes the
 * token-theft leg of XSS.
 *
 * Claims are deliberately minimal:
 *   sub  user id
 *   ver  token_version — compared against the database on every request, so a
 *       password change invalidates all previously issued tokens immediately
 *   typ  guards against a token minted for a different purpose being replayed
 */
import { SignJWT, jwtVerify } from 'jose';

export interface TokenClaims {
  userId: number;
  tokenVersion: number;
}

export class TokenError extends Error {
  constructor(
    message: string,
    readonly reason: 'expired' | 'invalid' | 'malformed' | 'wrong_type',
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

export interface TokenCodecOptions {
  secret: string;
  issuer?: string;
  audience?: string;
  expiresIn?: string;
}

const DEFAULT_ISSUER = 'openerp-api';
const DEFAULT_AUDIENCE = 'openerp-client';
const ACCESS_TOKEN_TYPE = 'access';

export class TokenCodec {
  private readonly key: Uint8Array;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly expiresIn: string;

  constructor(opts: TokenCodecOptions) {
    this.key = new TextEncoder().encode(opts.secret);
    this.issuer = opts.issuer ?? DEFAULT_ISSUER;
    this.audience = opts.audience ?? DEFAULT_AUDIENCE;
    this.expiresIn = opts.expiresIn ?? '15m';
  }

  async sign(claims: TokenClaims): Promise<string> {
    return new SignJWT({
      ver: claims.tokenVersion,
      typ: ACCESS_TOKEN_TYPE,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(String(claims.userId))
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt()
      .setExpirationTime(this.expiresIn)
      .sign(this.key);
  }

  async verify(token: string): Promise<TokenClaims> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'], // pinned: never let the token choose the algorithm
        issuer: this.issuer,
        audience: this.audience,
      }));
    } catch (e) {
      // jose renamed this error class between major versions
      // (`TokenExpiredError` -> `JWTExpired`), so match on both the name and
      // the stable machine code.
      const err = e as { name?: string; code?: string };
      if (
        err.name === 'TokenExpiredError' ||
        err.name === 'JWTExpired' ||
        err.code === 'ERR_JWT_EXPIRED'
      ) {
        throw new TokenError('Session token has expired.', 'expired');
      }
      throw new TokenError('Session token is not valid.', 'invalid');
    }

    if (typeof payload.sub !== 'string' || !/^\d+$/.test(payload.sub)) {
      throw new TokenError('Session token is malformed.', 'malformed');
    }
    if (payload.typ !== ACCESS_TOKEN_TYPE) {
      throw new TokenError('Session token was issued for a different purpose.', 'wrong_type');
    }
    if (typeof payload.ver !== 'number') {
      throw new TokenError('Session token is malformed.', 'malformed');
    }

    return { userId: Number(payload.sub), tokenVersion: payload.ver };
  }
}
