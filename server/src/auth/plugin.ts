/**
 * Authentication + RBAC plugin.
 *
 * Exposes two decorators:
 *   request.principal  — the resolved Principal, present on authenticated routes
 *   app.authenticate   — preHandler enforcing a valid session (401 otherwise)
 *   app.requirePermission(...perms) — preHandler enforcing capabilities (403)
 *
 * `requirePermission` accepts several permissions and requires ALL of them, so
 * a route that both reads and writes need only one declaration.
 */
import fp from 'fastify-plugin';
import cookie from '@fastify/cookie';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { TokenCodec, TokenError } from './tokens.js';
import { PrincipalError, resolvePrincipal, type Principal } from './principal.js';
import { PasswordPolicyError } from './password.js';
import type { Config } from '../config.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: (
      ...permissions: string[]
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Test/ops helper: mint a token for an arbitrary user id + version. */
    tokenCodec: TokenCodec;
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const unauthorized = (message = 'Authentication required.'): HttpError =>
  new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Insufficient permissions.'): HttpError =>
  new HttpError(403, 'FORBIDDEN', message);

function principalFrom(request: FastifyRequest): Principal {
  if (!request.principal) throw unauthorized();
  return request.principal;
}

async function authPluginImpl(app: FastifyInstance, opts: { config: Config }): Promise<void> {
  const { config } = opts;
  const codec = new TokenCodec({
    secret: config.AUTH_JWT_SECRET,
    expiresIn: config.AUTH_JWT_EXPIRES_IN,
  });
  app.decorate('tokenCodec', codec);

  await app.register(cookie, {
    // The session cookie must never be readable from JavaScript.
    parseOptions: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.AUTH_COOKIE_SECURE,
      path: '/',
    },
  });

  /** Extracts the token from the cookie, or from an Authorization header. */
  const readToken = (request: FastifyRequest): string | null => {
    const fromCookie = request.cookies[config.AUTH_COOKIE_NAME];
    if (fromCookie) return fromCookie;

    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
    return null;
  };

  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = readToken(request);
    if (!token) {
      return reply.code(401).send({
        error: 'UNAUTHORIZED',
        message: 'Authentication required. No session token was supplied.',
      });
    }

    let claims;
    try {
      claims = await codec.verify(token);
    } catch (e) {
      // Clear the stale cookie so the browser stops resending it.
      reply.clearCookie(config.AUTH_COOKIE_NAME, { path: '/' });
      const message = e instanceof TokenError ? e.message : 'Session token could not be verified.';
      return reply.code(401).send({ error: 'UNAUTHORIZED', message });
    }

    try {
      request.principal = await resolvePrincipal(claims);
    } catch (e) {
      reply.clearCookie(config.AUTH_COOKIE_NAME, { path: '/' });
      if (e instanceof PrincipalError) {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: e.message });
      }
      throw e;
    }
  });

  app.decorate(
    'requirePermission',
    (...permissions: string[]) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const principal = principalFrom(request);
        const missing = permissions.filter((p) => !principal.permissions.has(p));
        if (missing.length > 0) {
          return reply.code(403).send({
            error: 'FORBIDDEN',
            message: `Missing required permission(s): ${missing.join(', ')}.`,
            required: missing,
            roles: principal.roleKeys,
          });
        }
      },
  );

  /** Normalises thrown errors into a consistent JSON envelope. */
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'VALIDATION_FAILED',
        message: 'Request payload failed validation.',
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    // A password that fails policy is a client input problem, not a server fault.
    if (error instanceof PasswordPolicyError) {
      return reply.code(400).send({
        error: 'PASSWORD_POLICY_VIOLATION',
        message: error.message,
      });
    }

    // Honour the status code carried by well-known HTTP errors from plugins
    // (rate limiting, payload limits, CORS, ...) instead of flattening every
    // client error into a 500.
    const status = error.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({
        error: error.code ?? 'BAD_REQUEST',
        message: error.message,
      });
    }

    app.log.error({ err: error }, 'unhandled error');
    return reply
      .code(500)
      .send({ error: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred.' });
  });
}

export const authPlugin = fp(authPluginImpl, { name: 'openerp-auth' });
