/**
 * Authentication routes: login, logout, password change and current-user
 * context.
 *
 * Security posture:
 *  * The session token is delivered ONLY as an HTTP-only cookie. It is never
 *    placed in the response body, so page scripts cannot read it.
 *  * Login failures are deliberately indistinguishable between "no such email"
 *    and "wrong password", and both take comparable time.
 *  * A `token_version` bump on password change invalidates every outstanding
 *    session for that user immediately.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { fakeVerify, hashPassword, verifyPassword } from '../auth/password.js';
import { HttpError, unauthorized } from '../auth/plugin.js';
import type { Config } from '../config.js';
import { ROLES } from '@openerp/shared';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('A valid email address is required.'),
  password: z.string().min(1, 'Password is required.'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.'),
  newPassword: z.string().min(1, 'New password is required.'),
});

/** Clears the session cookie with options matching how it was set. */
function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(config.AUTH_COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.AUTH_COOKIE_SECURE,
  });
}

export async function registerAuthRoutes(app: FastifyInstance, config: Config): Promise<void> {
  // ---- POST /api/auth/login --------------------------------------------
  app.post(
    '/api/auth/login',
    {
      // Brute-force protection. Skipped under NODE_ENV=test because the suite
      // performs far more logins per minute than a human ever would, which
      // would otherwise turn unrelated assertions into 429s.
      config: config.isTest ? {} : { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = loginSchema.parse(request.body);

      const user = await prisma.appUser.findUnique({
        where: { email: body.email },
        select: {
          id: true,
          employeeId: true,
          email: true,
          passwordHash: true,
          isActive: true,
          tokenVersion: true,
        },
      });

      if (!user) {
        // Burn comparable time so a missing account is not detectable by timing.
        await fakeVerify(body.password);
        throw unauthorized('Invalid email address or password.');
      }

      const passwordOk = await verifyPassword(body.password, user.passwordHash);
      if (!passwordOk) {
        throw unauthorized('Invalid email address or password.');
      }

      if (!user.isActive) {
        // Distinct message is safe here: the caller has already proven they
        // hold the correct password.
        throw new HttpError(403, 'ACCOUNT_INACTIVE', 'This account has been deactivated.');
      }

      const token = await app.tokenCodec.sign({
        userId: user.id,
        tokenVersion: user.tokenVersion,
      });

      await prisma.appUser.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      reply.setCookie(config.AUTH_COOKIE_NAME, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.AUTH_COOKIE_SECURE,
        maxAge: secondsFromDuration(config.AUTH_JWT_EXPIRES_IN),
      });

      // Intentionally no token in the body.
      return reply.code(200).send({ ok: true });
    },
  );

  // ---- POST /api/auth/logout -------------------------------------------
  app.post(
    '/api/auth/logout',
    { preHandler: [app.authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      clearSessionCookie(reply, config);
      return reply.code(200).send({ ok: true });
    },
  );

  // ---- POST /api/auth/refresh ------------------------------------------
  app.post(
    '/api/auth/refresh',
    {
      preHandler: [app.authenticate],
      config: config.isTest ? {} : { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = request.principal!;

      const user = await prisma.appUser.findUnique({
        where: { id: principal.userId },
        select: {
          id: true,
          isActive: true,
          tokenVersion: true,
        },
      });

      if (!user || !user.isActive) {
        clearSessionCookie(reply, config);
        throw unauthorized('Account is inactive or no longer exists.');
      }

      const token = await app.tokenCodec.sign({
        userId: user.id,
        tokenVersion: user.tokenVersion,
      });

      reply.setCookie(config.AUTH_COOKIE_NAME, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.AUTH_COOKIE_SECURE,
        maxAge: secondsFromDuration(config.AUTH_JWT_EXPIRES_IN),
      });

      return reply.code(200).send({ ok: true });
    },
  );

  // ---- GET /api/auth/me -------------------------------------------------
  app.get(
    '/api/auth/me',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = request.principal!;

      const roles = await prisma.appUserRole.findMany({
        where: { userId: principal.userId },
        select: {
          assignedAt: true,
          role: {
            select: {
              key: true,
              name: true,
              description: true,
              permissions: {
                select: { permission: { select: { key: true } } },
              },
            },
          },
        },
        orderBy: { role: { key: 'asc' } },
      });

      return reply.code(200).send({
        user: {
          id: principal.userId,
          email: principal.email,
          isActive: principal.isActive,
          // The profile screen and the shell avatar read this; it is also the
          // cache-buster appended to the avatar URL.
          avatarUpdatedAt: principal.avatarUpdatedAt,
        },
        employee: principal.employee,
        roles: roles.map((r) => ({
          key: r.role.key,
          name: r.role.name,
          description: r.role.description,
          assignedAt: r.assignedAt,
        })),
        permissions: [...principal.permissions].sort(),
        rolePermissions: Object.fromEntries(
          roles.map((r) => [r.role.key, r.role.permissions.map((p) => p.permission.key).sort()]),
        ),
      });
    },
  );

  // ---- POST /api/auth/change-password -----------------------------------
  app.post(
    '/api/auth/change-password',
    {
      preHandler: [app.authenticate],
      config: config.isTest ? {} : { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = request.principal!;
      const body = changePasswordSchema.parse(request.body);

      const user = await prisma.appUser.findUnique({
        where: { id: principal.userId },
        select: { id: true, passwordHash: true, tokenVersion: true },
      });
      if (!user) throw unauthorized();

      if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
        throw unauthorized('Current password is incorrect.');
      }

      if (body.currentPassword === body.newPassword) {
        throw new HttpError(
          400,
          'PASSWORD_UNCHANGED',
          'The new password must differ from the current password.',
        );
      }

      const passwordHash = await hashPassword(body.newPassword);

      // Bumping token_version invalidates every other session for this user.
      await prisma.appUser.update({
        where: { id: user.id },
        data: { passwordHash, tokenVersion: user.tokenVersion + 1 },
      });

      clearSessionCookie(reply, config);
      return reply.code(200).send({
        ok: true,
        message: 'Password changed. All other sessions have been signed out.',
      });
    },
  );

  // ---- GET /api/auth/roles (public catalogue for the login page) --------
  app.get('/api/auth/roles', async (_request, reply) => reply.code(200).send({ roles: ROLES }));
}

/**
 * Converts a duration string such as '15m', '1h', '7d' or '900' to seconds.
 * Mirrors the subset of `ms` syntax that the app actually uses.
 */
export function secondsFromDuration(duration: string): number {
  const match = /^(\d+)\s*(s|m|h|d)?$/.exec(duration.trim());
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1;
  return value * multiplier;
}
