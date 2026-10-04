/**
 * Test fixtures: create and destroy throwaway users with specific roles.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/client.js';
import { hashPassword } from '../auth/password.js';

export const TEST_PASSWORD = 'Field#Ops2026x';

interface CreatedUser {
  id: number;
  employeeId: number;
  email: string;
  password: string;
}

/**
 * Creates an employee + app_user carrying exactly `roleKeys`.
 *
 * Employee and AppUser are both created here because `app_user.employee_id` is a
 * non-nullable 1-to-1 foreign key: an account can never exist without one.
 */
export async function createTestUser(roleKeys: string[]): Promise<CreatedUser> {
  const email = `test-${randomUUID()}@example.test`;
  const contractType = await prisma.employeeContractType.findFirstOrThrow();

  const employee = await prisma.employee.create({
    data: {
      name: 'Test',
      surname: 'User',
      email,
      startDate: new Date('2026-01-01'),
      contractTypeId: contractType.id,
    },
    select: { id: true },
  });

  const roles = await prisma.appRole.findMany({
    where: { key: { in: roleKeys } },
    select: { id: true, key: true },
  });

  const missing = roleKeys.filter((k) => !roles.some((r) => r.key === k));
  if (missing.length) {
    await prisma.employee.delete({ where: { id: employee.id } });
    throw new Error(
      `Cannot create test user: role(s) not seeded: ${missing.join(', ')}. Run "npm run seed --workspace server" first.`,
    );
  }

  const user = await prisma.appUser.create({
    data: {
      employeeId: employee.id,
      email,
      passwordHash: await hashPassword(TEST_PASSWORD),
      isActive: true,
      roles: { create: roles.map((r) => ({ roleId: r.id })) },
    },
    select: { id: true, employeeId: true, email: true },
  });

  return { ...user, password: TEST_PASSWORD };
}

/** Removes a user created by `createTestUser`, in FK-safe order. */
export async function destroyTestUser(user: Pick<CreatedUser, 'id' | 'employeeId'>): Promise<void> {
  await prisma.appUser.deleteMany({ where: { id: user.id } });
  await prisma.employee.deleteMany({ where: { id: user.employeeId } });
}

export interface Session {
  cookie: string;
  email: string;
}

/** Logs in and returns the session cookie header value for subsequent calls. */
export async function login(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Login failed for ${email}: ${response.statusCode} ${response.body}`);
  }

  const setCookie = response.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error('Login succeeded but no Set-Cookie header was returned.');

  // "openerp_session=<jwt>; Path=/; ..." -> "openerp_session=<jwt>"
  return raw.split(';')[0]!;
}
