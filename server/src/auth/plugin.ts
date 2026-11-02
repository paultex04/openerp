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
import { ROLE_ADMINISTRATOR } from '@openerp/shared';
import { TokenCodec, TokenError } from './tokens.js';
import { PrincipalError, resolvePrincipal, type Principal } from './principal.js';
import { PasswordPolicyError } from './password.js';
import { withAuditActor } from '../audit/context.js';
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
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
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

/**
 * Wraps every route handler so the audit actor is bound for its execution.
 *
 * `AsyncLocalStorage.enterWith` inside a preHandler does **not** reach the
 * handler: Fastify schedules hooks and handlers on its own promise chain, which
 * breaks the ALS continuation. Measured over real HTTP, every audited write came
 * out recorded as `system` with no route — the log looked complete but named
 * nobody, which is the worst possible failure for an audit trail.
 *
 * Wrapping the handler with `storage.run` fixes it, because `run` establishes a
 * real ALS scope around the handler's whole execution and anything it awaits —
 * including the Prisma query extension — inherits it. `request.principal` is
 * already populated by the time a handler runs, so an unauthenticated route gets
 * no actor and is recorded as `system`, which is correct.
 *
 * Installed via `onRoute` rather than `addHook('preHandler')` because only
 * `onRoute` can replace the handler itself.
 */
function bindAuditContext(app: FastifyInstance): void {
  app.addHook('onRoute', (routeOptions) => {
    const original = routeOptions.handler;
    if (typeof original !== 'function') return;

    routeOptions.handler = function auditBound(this: unknown, request, reply) {
      const principal = (request as FastifyRequest).principal;
      const invoke = () =>
        (original as (this: unknown, req: FastifyRequest, rep: FastifyReply) => unknown).call(
          this,
          request,
          reply,
        );

      if (!principal) return invoke();

      return withAuditActor(
        {
          userId: principal.userId,
          email: principal.email,
          employeeId: principal.employeeId,
          requestId: request.id,
          route: request.routeOptions?.url ?? request.url,
          method: request.method,
        },
        invoke,
      );
    };
  });
}

async function authPluginImpl(app: FastifyInstance, opts: { config: Config }): Promise<void> {
  bindAuditContext(app);

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

    // The audit actor is bound in an `onRoute` wrapper (see `bindAuditContext`),
    // not here. Binding it from this preHandler looks equivalent and is not:
    // Fastify's hook runner does not preserve AsyncLocalStorage propagation from
    // a preHandler into the handler, so every audited write came out as `system`
    // with no route. That was measured over real HTTP, not assumed.
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

  app.decorate('requireAdmin', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = principalFrom(request);
    if (!principal.roleKeys.includes(ROLE_ADMINISTRATOR)) {
      return reply.code(403).send({
        error: 'FORBIDDEN',
        message: 'Only administrators may perform this action.',
        roles: principal.roleKeys,
      });
    }
  });

  /** Normalises thrown errors into a consistent JSON envelope with diagnostic metadata. */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const requestId = request.id;
    reply.header('x-request-id', requestId);

    // 1. Domain errors (HttpError, BillingError, OperationsError, TimesheetError, etc.)
    const customStatus = (error as { statusCode?: unknown }).statusCode;
    const customCode = (error as { code?: unknown }).code;
    if (
      error instanceof HttpError ||
      (typeof customStatus === 'number' && typeof customCode === 'string')
    ) {
      const status = typeof customStatus === 'number' ? customStatus : 400;
      const code = typeof customCode === 'string' ? customCode : 'BAD_REQUEST';
      return reply.code(status).send({
        error: code,
        code,
        message: error.message,
        requestId,
      });
    }

    // 2. Prisma Database Errors
    const prismaCode = (error as { code?: unknown }).code;
    if (typeof prismaCode === 'string' && prismaCode.startsWith('P')) {
      // P2002: Unique constraint failed
      if (prismaCode === 'P2002') {
        const target = (error as { meta?: { target?: unknown } }).meta?.target;
        const field = Array.isArray(target) ? target.join(', ') : undefined;
        return reply.code(409).send({
          error: 'UNIQUE_CONSTRAINT_VIOLATION',
          code: 'UNIQUE_CONSTRAINT_VIOLATION',
          message: field
            ? `Another record already uses that ${field.replace(/_/g, ' ')}.`
            : 'Another record already uses that value.',
          ...(field ? { field } : {}),
          requestId,
        });
      }

      // P2003: Foreign key constraint violation
      if (prismaCode === 'P2003') {
        const fieldName = (error as { meta?: { field_name?: unknown } }).meta?.field_name;
        const field = typeof fieldName === 'string' ? fieldName : undefined;
        return reply.code(409).send({
          error: 'FOREIGN_KEY_VIOLATION',
          code: 'RECORD_IN_USE',
          message:
            'This record cannot be removed or modified because other active records depend on it.',
          ...(field ? { field } : {}),
          requestId,
        });
      }

      // P2025: Record to update or delete not found
      if (prismaCode === 'P2025') {
        return reply.code(404).send({
          error: 'RECORD_NOT_FOUND',
          code: 'RECORD_NOT_FOUND',
          message: 'The requested record does not exist or has already been removed.',
          requestId,
        });
      }

      // P2024 / P1001: Connection pool timeout or database unreachable
      if (prismaCode === 'P2024' || prismaCode === 'P1001') {
        reply.header('retry-after', '5');
        return reply.code(503).send({
          error: 'SERVICE_UNAVAILABLE',
          code: 'DATABASE_UNAVAILABLE',
          message:
            'The database is temporarily busy or unreachable. Please try your request again shortly.',
          requestId,
        });
      }

      // P2034: Transaction conflict / serialization failure
      if (prismaCode === 'P2034') {
        return reply.code(409).send({
          error: 'TRANSACTION_CONFLICT',
          code: 'CONCURRENT_UPDATE',
          message:
            'A concurrent database operation conflicted with this action. Please retry.',
          requestId,
        });
      }
    }

    // 3. Schema validation errors (Zod)
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'VALIDATION_FAILED',
        code: 'VALIDATION_FAILED',
        message: 'Request payload failed validation.',
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        requestId,
      });
    }

    // 4. Password policy violation
    if (error instanceof PasswordPolicyError) {
      return reply.code(400).send({
        error: 'PASSWORD_POLICY_VIOLATION',
        code: 'PASSWORD_POLICY_VIOLATION',
        message: error.message,
        requestId,
      });
    }

    // 5. Plugin HTTP status codes (Rate limits, CORS, Multipart limits, etc.)
    const status = error.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({
        error: error.code ?? 'BAD_REQUEST',
        code: error.code ?? 'BAD_REQUEST',
        message: error.message,
        requestId,
      });
    }

    // 6. Unhandled 500 Internal Server Errors
    app.log.error(
      {
        err: error,
        requestId,
        url: request.raw.url,
        method: request.raw.method,
      },
      'unhandled server error',
    );

    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred.',
      requestId,
      timestamp: new Date().toISOString(),
    });
  });
}

export const authPlugin = fp(authPluginImpl, { name: 'openerp-auth' });
