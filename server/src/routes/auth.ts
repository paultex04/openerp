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
import {
  ROLES,
  createAccessRequestSchema,
  emailSchema,
  accessRequestStatusFromKey,
} from '@openerp/shared';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('A valid email address is required.'),
  password: z.string().min(1, 'Password is required.'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.'),
  newPassword: z.string().min(1, 'New password is required.'),
});

/** Clears both access and refresh session cookies with matching options. */
function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(config.AUTH_COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.AUTH_COOKIE_SECURE,
  });
  reply.clearCookie(`${config.AUTH_COOKIE_NAME}_refresh`, {
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

      const refreshToken = await app.tokenCodec.signRefresh(
        {
          userId: user.id,
          tokenVersion: user.tokenVersion,
        },
        '7d',
      );

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

      reply.setCookie(`${config.AUTH_COOKIE_NAME}_refresh`, refreshToken, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.AUTH_COOKIE_SECURE,
        maxAge: secondsFromDuration('7d'),
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
      config: config.isTest ? {} : { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const refreshCookieName = `${config.AUTH_COOKIE_NAME}_refresh`;
      const rawRefresh = request.cookies[refreshCookieName];
      const rawAccess = request.cookies[config.AUTH_COOKIE_NAME];

      let claims: { userId: number; tokenVersion: number } | null = null;

      if (rawRefresh) {
        try {
          claims = await app.tokenCodec.verifyRefresh(rawRefresh);
        } catch {
          claims = null;
        }
      }

      // Fallback: If refresh cookie is missing, check active access token
      if (!claims && rawAccess) {
        try {
          claims = await app.tokenCodec.verify(rawAccess);
        } catch {
          claims = null;
        }
      }

      if (!claims) {
        clearSessionCookie(reply, config);
        throw unauthorized('Session has expired. Please sign in again.');
      }

      const user = await prisma.appUser.findUnique({
        where: { id: claims.userId },
        select: {
          id: true,
          isActive: true,
          tokenVersion: true,
        },
      });

      if (!user || !user.isActive || user.tokenVersion !== claims.tokenVersion) {
        clearSessionCookie(reply, config);
        throw unauthorized('Account is inactive, modified, or session was revoked.');
      }

      const token = await app.tokenCodec.sign({
        userId: user.id,
        tokenVersion: user.tokenVersion,
      });

      const refreshToken = await app.tokenCodec.signRefresh(
        {
          userId: user.id,
          tokenVersion: user.tokenVersion,
        },
        '7d',
      );

      reply.setCookie(config.AUTH_COOKIE_NAME, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.AUTH_COOKIE_SECURE,
        maxAge: secondsFromDuration(config.AUTH_JWT_EXPIRES_IN),
      });

      reply.setCookie(refreshCookieName, refreshToken, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.AUTH_COOKIE_SECURE,
        maxAge: secondsFromDuration('7d'),
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

  // ---- POST /api/auth/access-requests (submit public access request) ------
  app.post(
    '/api/auth/access-requests',
    {
      config: config.isTest ? {} : { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createAccessRequestSchema.parse(request.body);

      // Check if an active account is already registered with this email
      const existingUser = await prisma.appUser.findUnique({
        where: { email: body.email },
        select: { id: true, isActive: true },
      });
      if (existingUser && existingUser.isActive) {
        throw new HttpError(
          409,
          'ACCOUNT_EXISTS',
          'An active account is already registered with this email address. Please sign in or contact an administrator.',
        );
      }

      // Check if a pending request is already waiting for review
      const existingPending = await prisma.accessRequest.findFirst({
        where: {
          email: body.email,
          status: 'PENDING',
        },
        select: { id: true },
      });
      if (existingPending) {
        throw new HttpError(
          409,
          'REQUEST_PENDING',
          'An access request for this email address is already pending review by system administrators.',
        );
      }

      const accessRequest = await prisma.accessRequest.create({
        data: {
          fullName: body.fullName,
          email: body.email,
          phone: body.phone,
          department: body.department,
          jobTitle: body.jobTitle ?? null,
          reason: body.reason,
          status: 'PENDING',
        },
      });

      return reply.code(201).send({
        ok: true,
        id: accessRequest.id,
        message: 'Access request submitted successfully. A system administrator will review it.',
      });
    },
  );

  // ---- GET /api/auth/access-requests/status (check status by email) --------
  app.get(
    '/api/auth/access-requests/status',
    {
      config: config.isTest ? {} : { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = z.object({ email: emailSchema }).parse(request.query);

      const latest = await prisma.accessRequest.findFirst({
        where: { email: query.email },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          department: true,
          jobTitle: true,
          reason: true,
          status: true,
          adminNotes: true,
          reviewedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (!latest) {
        return reply.code(200).send({ found: false, request: null });
      }

      return reply.code(200).send({
        found: true,
        request: {
          ...latest,
          status: accessRequestStatusFromKey(latest.status),
          reviewedAt: latest.reviewedAt?.toISOString() ?? null,
          createdAt: latest.createdAt.toISOString(),
          updatedAt: latest.updatedAt.toISOString(),
        },
      });
    },
  );
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
