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

/**
 * A seeded contract together with an amendment that actually belongs to it.
 *
 * ## Why this exists
 *
 * Test fixtures used to pick the two independently:
 *
 * ```ts
 * const contract   = await prisma.contract.findFirstOrThrow();
 * const amendment  = await prisma.contractAmendment.findFirstOrThrow();
 * ```
 *
 * That is only correct while the database happens to hold exactly one contract and
 * one amendment. It is not a property anyone can rely on: the amendment table grows
 * with every fixture that creates its own chain, and `findFirst` with no `orderBy`
 * has no defined ordering. Once a second amendment exists the two lines can return
 * rows from *different* contracts, and the fixture builds a project whose amendment
 * does not belong to its contract - corrupt data that then fails much later, in the
 * pricing code, as `AMENDMENT_MISMATCH` against a service code that was never wrong.
 *
 * The production routes refuse that pairing (see `AMENDMENT_MISMATCH` in
 * `routes/operations.ts` and `operations/service.ts`). These fixtures write through
 * Prisma, which bypasses those routes, so they were never subject to the check and
 * had to be made correct at the source.
 *
 * The amendment is restricted to ACTIVE and the latest by effective date, matching
 * the server's own default for a project that does not name one.
 */
export async function seededContractWithAmendment(): Promise<{
  contractId: number;
  amendmentId: number;
}> {
  // `orderBy: { id: 'asc' }` is load-bearing, not decoration.
  //
  // The database carries residue: the smoke scripts, manual runs and earlier
  // test files all create contracts, and nothing wipes the table between runs
  // (`fileParallelism` is off, but that only stops *concurrent* writers). An
  // unordered `findFirst` returns whichever row the planner reaches first,
  // which has been a *fixture* contract left by another test - so the "seeded"
  // chain was not seeded at all, and the seeded service code it then reached
  // for belonged to a different amendment. Lowest id is the seeded contract
  // and is stable under that churn.
  const contract = await prisma.contract.findFirstOrThrow({
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  // Oldest active amendment for that contract. Also ordered explicitly: a bare
  // `findFirst` here can pick a fixture amendment left by a sibling test file that
  // happens to share the contract.
  const amendment = await prisma.contractAmendment.findFirstOrThrow({
    where: { contractId: contract.id, status: 'ACTIVE' },
    orderBy: { effectiveDate: 'asc' },
    select: { id: true },
  });
  return { contractId: contract.id, amendmentId: amendment.id };
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
