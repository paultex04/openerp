/**
 * Phase 5 acceptance gates: the audit log and the admin suite.
 *
 *   1. Every write is captured, with the right actor, without a single call site
 *      opting in.
 *   2. An UPDATE records what changed, not the whole row.
 *   3. An actor survives deletion of the account, because the log denormalises it.
 *   4. The admin suite manages users and shows role/permission drift.
 *   5. Self-lockout and last-administrator lockout are impossible.
 *   6. No non-administrator can reach the admin surface.
 *
 * Audit entries are read through the API where possible so the tested path is the
 * shipped path.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { prisma, prismaBase } from '../db/client.js';
import {
  TEST_PASSWORD,
  createTestUser,
  destroyTestUser,
  login,
  seededContractWithAmendment,
} from '../test/fixtures.js';
import { asSystem } from './context.js';

let app: FastifyInstance;
const createdUsers: Array<{ id: number; employeeId: number }> = [];
const cookies = new Map<string, string>();

/** Fixtures to remove in FK-safe order. Audit rows are deliberately kept. */
const fixtureClients: number[] = [];
const fixtureContracts: number[] = [];
const fixtureAmendments: number[] = [];
const fixtureProjects: string[] = [];
const fixtureJobs: number[] = [];
const fixtureDeliverables: number[] = [];

beforeAll(async () => {
  app = await buildApp({ config: loadConfig(), logger: false });
  await app.ready();
});

afterAll(async () => {
  // Sweep any fixture this run failed to clean up. Without it a crashed run
  // leaves employees and clients behind forever, and they then collide with the
  // next run's unique constraints — a failure that looks like a code bug.
  //
  // Order is FK-safe: contracts reference clients, so contracts go first. Deleting
  // the client first fails on the foreign key and (being caught) silently leaves
  // both behind, which is exactly the leak this sweep was added to prevent.
  await prisma.contractAmendment
    .deleteMany({
      where: { contract: { number: { startsWith: 'AUD-' } } },
    })
    .catch(() => undefined);
  await prisma.contract
    .deleteMany({ where: { number: { startsWith: 'AUD-' } } })
    .catch(() => undefined);
  await prisma.client
    .deleteMany({ where: { email: { endsWith: '@example.test' } } })
    .catch(() => undefined);
  // Test users reference their employees. Remove any leaked test accounts before
  // the employee sweep so a failed earlier run cannot leave FK-blocking fixtures.
  await prisma.appUser
    .deleteMany({
      where: {
        OR: [
          { email: { endsWith: '@example.test' } },
          { employee: { email: { endsWith: '@example.test' } } },
        ],
      },
    })
    .catch(() => undefined);
  await prisma.employee
    .deleteMany({ where: { email: { endsWith: '@example.test' } } })
    .catch(() => undefined);

  for (const id of fixtureDeliverables) {
    await prisma.jobServiceCode.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const id of fixtureJobs) {
    await prisma.job.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const code of fixtureProjects) {
    await prisma.project.deleteMany({ where: { code } }).catch(() => undefined);
  }
  if (fixtureAmendments.length) {
    await prisma.contractAmendment
      .deleteMany({ where: { id: { in: fixtureAmendments } } })
      .catch(() => undefined);
  }
  if (fixtureContracts.length) {
    await prisma.contract
      .deleteMany({ where: { id: { in: fixtureContracts } } })
      .catch(() => undefined);
  }
  if (fixtureClients.length) {
    await prisma.client
      .deleteMany({ where: { id: { in: fixtureClients } } })
      .catch(() => undefined);
  }
  for (const user of createdUsers) {
    await destroyTestUser(user).catch(() => undefined);
  }
  await app.close();
  await prisma.$disconnect();
});

async function sessionFor(role: string): Promise<string> {
  const cached = cookies.get(role);
  if (cached) return cached;
  const user = await createTestUser([role]);
  createdUsers.push(user);
  cookies.set(role, await login(app, user.email, TEST_PASSWORD));
  return cookies.get(role)!;
}

/** Waits for the fire-and-forget audit insert to land. */
async function auditSettled(): Promise<void> {
  await new Promise((r) => setTimeout(r, 120));
}

/**
 * A disposable client, so writes have something of our own to record.
 *
 * Wrapped in `asSystem` because a test shares an async chain with the
 * `app.inject` calls it has already made, and `enterWith` (used by the auth
 * preHandler) binds the actor for the rest of that chain. Without this the
 * fixture would be misattributed to whichever user logged in most recently —
 * which is exactly the leak the helper exists to prevent.
 */
async function makeClient(name: string): Promise<number> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
  // The email must be unique per call, not per name: a crashed earlier run
  // leaves its rows behind, and a name-derived address would then collide on the
  // next run and fail for a reason that has nothing to do with the code under test.
  const client = await asSystem(() =>
    prisma.client.create({
      data: { name, email: `${slug}-${randomUUID().slice(0, 8)}@example.test` },
      select: { id: true },
    }),
  );
  fixtureClients.push(client.id);
  return client.id;
}

/** A disposable project, for the DELETE gate (clients are not deletable). */
async function makeProject(): Promise<number> {
  const { contractId, amendmentId } = await seededContractWithAmendment();
  const code = `AUDIT-PRJ-${Date.now().toString(36)}`;

  const project = await asSystem(() =>
    prisma.project.create({
      data: { contractId, amendmentId, code, year: 2026 },
      select: { id: true },
    }),
  );
  fixtureProjects.push(code);
  return project.id;
}

// ===========================================================================

describe('Gate 1: every write is captured with its actor', () => {
  it('records a CREATE attributed to the authenticated user', async () => {
    const cookie = await sessionFor('administrator');
    const before = await prismaBase.auditLog.count();
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    const actorId = me.json().user.id;
    const actorEmail = me.json().user.email;

    const name = `Audit Create ${Date.now().toString(36)}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie },
      // The client schema requires an email; the name is what the entry keys on.
      payload: { name, email: `audit-create-${Date.now().toString(36)}@example.test` },
    });
    expect(created.statusCode).toBe(201);
    const clientId = created.json().client.id;

    await auditSettled();

    const entries = await prismaBase.auditLog.findMany({
      where: { model: 'Client', recordId: String(clientId) },
      orderBy: { id: 'desc' },
    });
    expect(entries.length).toBeGreaterThan(0);

    const entry = entries[0]!;
    expect(entry.action).toBe('CREATE');
    expect(entry.actorUserId).toBe(actorId);
    expect(entry.actorEmail).toBe(actorEmail);
    expect(entry.recordId).toBe(String(clientId));
    expect(entry.summary).toContain('Created');
    expect(entry.route).toBe('/api/clients');
    expect(entry.method).toBe('POST');
    expect(entry.requestId).toBeTruthy();

    expect(await prismaBase.auditLog.count()).toBeGreaterThan(before);
  });

  it('records an UPDATE with only the changed fields', async () => {
    const cookie = await sessionFor('administrator');
    const clientId = await makeClient('Audit Update');

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/clients/${clientId}`,
      headers: { cookie },
      payload: { name: 'Renamed By Audit' },
    });
    expect(updated.statusCode).toBe(200);

    await auditSettled();

    const entry = await prismaBase.auditLog.findFirstOrThrow({
      where: { model: 'Client', recordId: String(clientId), action: 'UPDATE' },
      orderBy: { id: 'desc' },
    });

    expect(entry.changedFields).toContain('name');
    // Only the change is stored, not the whole row: this is what keeps the log
    // reviewable rather than a wall of duplicated data.
    expect(Object.keys((entry.after as object) ?? {})).toEqual(['name']);
    expect(entry.summary).toContain('name');
    expect(entry.before).toBeTruthy();
  });

  it('records a DELETE with the prior state', async () => {
    const cookie = await sessionFor('administrator');
    // Projects, not clients: the API deliberately offers no client deletion
    // (commercial history is not removable), so this gate uses a model that is.
    const projectId = await makeProject();

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(204);

    await auditSettled();

    const entry = await prismaBase.auditLog.findFirstOrThrow({
      where: { model: 'Project', recordId: String(projectId), action: 'DELETE' },
      orderBy: { id: 'desc' },
    });

    expect(entry.summary).toContain('Deleted');
    expect(entry.before).toBeTruthy();
    expect(entry.after).toBeNull();
  });

  it('attributes a write to system when there is no request', async () => {
    // A direct Prisma call outside a request has no actor. It must still be
    // recorded — as `system`, which is honest, rather than dropped.
    const id = await makeClient('Audit System');
    await auditSettled();

    const entry = await prismaBase.auditLog.findFirstOrThrow({
      where: { model: 'Client', recordId: String(id), action: 'CREATE' },
      orderBy: { id: 'desc' },
    });
    expect(entry.actorEmail).toBe('system');
    expect(entry.actorUserId).toBeNull();
    expect(entry.requestId).toBeNull();
  });

  it('captures a domain write the service layer performs', async () => {
    // Proves the capture is not route-driven: these go straight through Prisma,
    // not through any HTTP route.
    const clientId = await makeClient('Audit Operations');
    const contract = await asSystem(() =>
      prisma.contract.create({
        data: {
          clientId,
          number: `AUD-${Date.now().toString(36)}`,
          description: 'audit fixture',
        },
        select: { id: true },
      }),
    );
    fixtureContracts.push(contract.id);
    await asSystem(() =>
      prisma.contractAmendment.create({
        data: {
          contractId: contract.id,
          amendmentNumber: `AMD-${Date.now().toString(36)}`,
          effectiveDate: new Date('2026-01-01'),
        },
        select: { id: true },
      }),
    );

    await auditSettled();

    for (const model of ['Contract', 'ContractAmendment']) {
      const rows = await prismaBase.auditLog.count({ where: { model, action: 'CREATE' } });
      expect(rows, model).toBeGreaterThan(0);
    }
  });
});

describe('Gate 3: the actor survives account deletion', () => {
  it('keeps naming an actor whose account is hard-deleted', async () => {
    // The point of denormalising actor_email/actor_employee_id: an entry must
    // still name who acted after the account itself is gone.
    //
    // The actor has to be the account being deleted, so this creates a user,
    // has THAT user perform a write, then hard-deletes them. (An earlier version
    // asserted on the administrator's entries and so tested the wrong thing
    // entirely: creating a user does not make that user the actor.)
    const adminCookie = await sessionFor('administrator');
    const tag = randomUUID().slice(0, 8);
    const email = `vanishing-${tag}@example.test`;

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie: adminCookie },
      payload: {
        email,
        password: 'Vanishing#Pass2026',
        // commercial_qs can create a client, so the new account has a write to make.
        roleKeys: ['commercial_qs'],
        employee: {
          mode: 'new',
          name: 'Vanishing',
          surname: 'User',
          startDate: '2026-01-01',
          rate: 100,
          contractTypeId: (
            await prisma.employeeContractType.findFirstOrThrow({
              where: { isArchived: false },
              select: { id: true },
            })
          ).id,
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const userId = created.json().user.id as number;

    // The new user signs in and writes something of their own.
    const theirCookie = await login(app, email, 'Vanishing#Pass2026');
    await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: theirCookie },
      payload: { name: `Vanishing Client ${tag}`, email: `vanishing-c-${tag}@example.test` },
    });

    await auditSettled();

    const whileAlive = await prismaBase.auditLog.findMany({ where: { actorUserId: userId } });
    expect(whileAlive.length).toBeGreaterThan(0);

    const employeeId = (
      await prisma.appUser.findUniqueOrThrow({
        where: { id: userId },
        select: { employeeId: true },
      })
    ).employeeId;

    // Hard-delete, bypassing the deactivation path, to prove the FK behaviour.
    await prisma.appUser.deleteMany({ where: { id: userId } });

    const afterDelete = await prismaBase.auditLog.findMany({
      where: { id: { in: whileAlive.map((e) => e.id) } },
    });
    expect(afterDelete.length).toBe(whileAlive.length);

    for (const entry of afterDelete) {
      // The foreign key is nulled...
      expect(entry.actorUserId, entry.summary ?? '').toBeNull();
      // ...but the log still names them, and still ties them to the person.
      expect(entry.actorEmail).toBe(email);
      expect(entry.actorEmployeeId).toBe(employeeId);
    }

    // Clean up the client and employee the fixture created.
    await prisma.client
      .deleteMany({ where: { email: `vanishing-c-${tag}@example.test` } })
      .catch(() => undefined);
    await prisma.employee.deleteMany({ where: { id: employeeId } }).catch(() => undefined);
  });
});
describe('Gate 4: the admin suite', () => {
  it('lists users with roles and effective permission counts', async () => {
    const cookie = await sessionFor('administrator');
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const users = response.json().users as Array<{
      id: number;
      roleKeys: string[];
      permissionCount: number;
    }>;
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) {
      expect(Array.isArray(u.roleKeys)).toBe(true);
      expect(typeof u.permissionCount).toBe('number');
    }
  });

  it('never leaks a password hash', async () => {
    const cookie = await sessionFor('administrator');
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie },
    });
    expect(response.body).not.toContain('passwordHash');
    expect(response.body).not.toContain('$2b$');
  });

  it('serves the role matrix with granted and expected permissions', async () => {
    const cookie = await sessionFor('administrator');
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/roles',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.permissions.length).toBeGreaterThan(0);
    expect(body.roles.length).toBe(5);

    const billing = body.roles.find((r: { key: string }) => r.key === 'billing_clerk');
    expect(billing.granted).toContain('invoice.approve');
    expect(billing.expected).toContain('invoice.approve');
    // Drift between the live grants and the catalogue is the point of sending both.
    expect(Array.isArray(billing.granted)).toBe(true);
  });

  it('atomically replaces editable role grants, rejects invalid grants and locks administrator', async () => {
    const cookie = await sessionFor('administrator');
    const role = await prisma.appRole.findUniqueOrThrow({ where: { key: 'project_manager' } });
    const wasCustomized = role.permissionsCustomized;
    const original = await prisma.rolePermission.findMany({
      where: { roleId: role.id },
      select: { permission: { select: { key: true } } },
    });
    const originalKeys = original.map((row) => row.permission.key).sort();

    try {
      const saved = await app.inject({
        method: 'PUT',
        url: '/api/admin/roles/project_manager/permissions',
        headers: { cookie },
        payload: { permissionKeys: ['project.read', 'job.read'] },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().granted).toEqual(['job.read', 'project.read']);
      await auditSettled();
      const grantAudit = await prismaBase.auditLog.findFirst({
        where: {
          model: 'RolePermission',
          method: 'PUT',
          route: '/api/admin/roles/:key/permissions',
        },
        orderBy: { occurredAt: 'desc' },
      });
      expect(grantAudit).not.toBeNull();
      expect(grantAudit?.actorUserId).not.toBeNull();
      expect(grantAudit?.actorEmail).not.toBe('system');

      const deniedScopePermission = await app.inject({
        method: 'PUT',
        url: '/api/admin/roles/project_manager/permissions',
        headers: { cookie },
        payload: { permissionKeys: ['not.a.permission'] },
      });
      expect(deniedScopePermission.statusCode).toBe(422);
      expect(await prisma.rolePermission.count({ where: { roleId: role.id } })).toBe(2);

      const protectedAdminGrant = await app.inject({
        method: 'PUT',
        url: '/api/admin/roles/project_manager/permissions',
        headers: { cookie },
        payload: { permissionKeys: ['project.read', 'admin.role.write'] },
      });
      expect(protectedAdminGrant.statusCode).toBe(422);
      expect(protectedAdminGrant.json().error).toBe('PROTECTED_PERMISSION');
      expect(await prisma.rolePermission.count({ where: { roleId: role.id } })).toBe(2);

      const locked = await app.inject({
        method: 'PUT',
        url: '/api/admin/roles/administrator/permissions',
        headers: { cookie },
        payload: { permissionKeys: [] },
      });
      expect(locked.statusCode).toBe(409);
      expect(locked.json().error).toBe('ROLE_LOCKED');

      const updatedRole = await prisma.appRole.findUniqueOrThrow({ where: { id: role.id } });
      expect(updatedRole.permissionsCustomized).toBe(true);
    } finally {
      const permissionRows = await prisma.permission.findMany({
        where: { key: { in: [...originalKeys, 'admin.role.write'] } },
        select: { id: true },
      });
      await prisma.$transaction([
        prisma.rolePermission.deleteMany({ where: { roleId: role.id } }),
        ...(permissionRows.length
          ? [
              prisma.rolePermission.createMany({
                data: permissionRows.map((permission) => ({
                  roleId: role.id,
                  permissionId: permission.id,
                })),
              }),
            ]
          : []),
        prisma.appRole.update({
          where: { id: role.id },
          data: { permissionsCustomized: wasCustomized },
        }),
      ]);
    }
  });

  it('creates a user and refuses a duplicate email or unknown role', async () => {
    const cookie = await sessionFor('administrator');
    const email = `newuser-${Date.now().toString(36)}@example.test`;

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie },
      payload: {
        email,
        password: 'Fresh#Account2026',
        roleKeys: ['project_manager'],
        employee: {
          mode: 'new',
          name: 'New',
          surname: 'Starter',
          startDate: '2026-01-01',
          rate: 100,
          contractTypeId: (
            await prisma.employeeContractType.findFirstOrThrow({
              where: { isArchived: false },
              select: { id: true },
            })
          ).id,
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const userId = created.json().user.id;

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie },
      payload: {
        email,
        password: 'Fresh#Account2026',
        roleKeys: ['project_manager'],
        employee: {
          mode: 'new',
          name: 'Dup',
          surname: 'Licate',
          startDate: '2026-01-01',
          rate: 100,
          contractTypeId: (
            await prisma.employeeContractType.findFirstOrThrow({
              where: { isArchived: false },
              select: { id: true },
            })
          ).id,
        },
      },
    });
    expect(duplicate.statusCode).toBe(409);

    const unknownRole = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie },
      payload: {
        email: `unknown-${Date.now().toString(36)}@example.test`,
        password: 'Fresh#Account2026',
        roleKeys: ['not_a_role'],
        employee: {
          mode: 'new',
          name: 'No',
          surname: 'Role',
          startDate: '2026-01-01',
          rate: 100,
          contractTypeId: (
            await prisma.employeeContractType.findFirstOrThrow({
              where: { isArchived: false },
              select: { id: true },
            })
          ).id,
        },
      },
    });
    expect(unknownRole.statusCode).toBe(422);
    expect(unknownRole.json().error).toBe('UNKNOWN_ROLE');

    // Clean up the account and its employee.
    const employeeId = (
      await prisma.appUser.findUniqueOrThrow({
        where: { id: userId },
        select: { employeeId: true },
      })
    ).employeeId;
    await prisma.appUser.deleteMany({ where: { id: userId } });
    await prisma.employee.deleteMany({ where: { id: employeeId } });
  });

  it('links an eligible employee, rejects reused or inactive employees, and lists only eligible choices', async () => {
    const cookie = await sessionFor('administrator');
    const contractType = await prisma.employeeContractType.findFirstOrThrow({
      where: { isArchived: false },
      select: { id: true },
    });
    const employee = await prisma.employee.create({
      data: {
        name: 'Existing',
        surname: `Employee-${randomUUID().slice(0, 8)}`,
        startDate: new Date('2024-01-01T00:00:00.000Z'),
        contractTypeId: contractType.id,
      },
    });
    const createdEmails = [
      `linked-${randomUUID()}@example.test`,
      `reused-${randomUUID()}@example.test`,
    ];

    try {
      const options = await app.inject({
        method: 'GET',
        url: '/api/admin/users/create-options',
        headers: { cookie },
      });
      expect(options.statusCode).toBe(200);
      expect(options.json().employees.some((row: { id: number }) => row.id === employee.id)).toBe(
        true,
      );
      expect(options.json().contractTypes.length).toBeGreaterThan(0);

      const linked = await app.inject({
        method: 'POST',
        url: '/api/admin/users',
        headers: { cookie },
        payload: {
          email: createdEmails[0],
          password: 'Linked#Employee2026',
          roleKeys: ['project_manager'],
          employee: { mode: 'existing', employeeId: employee.id },
        },
      });
      expect(linked.statusCode).toBe(201);
      expect(linked.json().user.employeeId).toBe(employee.id);
      expect(await prisma.appUser.count({ where: { employeeId: employee.id } })).toBe(1);

      const reused = await app.inject({
        method: 'POST',
        url: '/api/admin/users',
        headers: { cookie },
        payload: {
          email: createdEmails[1],
          password: 'Linked#Employee2026',
          roleKeys: ['project_manager'],
          employee: { mode: 'existing', employeeId: employee.id },
        },
      });
      expect(reused.statusCode).toBe(409);
      expect(reused.json().error).toBe('EMPLOYEE_HAS_USER');

      await prisma.employee.update({ where: { id: employee.id }, data: { endDate: new Date() } });
      const inactive = await app.inject({
        method: 'POST',
        url: '/api/admin/users',
        headers: { cookie },
        payload: {
          email: createdEmails[1],
          password: 'Linked#Employee2026',
          roleKeys: ['project_manager'],
          employee: { mode: 'existing', employeeId: employee.id },
        },
      });
      expect(inactive.statusCode).toBe(422);
      expect(inactive.json().error).toBe('EMPLOYEE_NOT_ELIGIBLE');
    } finally {
      await prisma.appUser.deleteMany({ where: { email: { in: createdEmails } } });
      await prisma.employee.deleteMany({ where: { id: employee.id } });
    }
  });

  it('validates required new-employee details before creating any records', async () => {
    const cookie = await sessionFor('administrator');
    const contractType = await prisma.employeeContractType.findFirstOrThrow({
      where: { isArchived: false },
      select: { id: true },
    });
    const email = `atomic-${randomUUID()}@example.test`;
    const invalidDate = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie },
      payload: {
        email,
        password: 'Atomic#Employee2026',
        roleKeys: ['project_manager'],
        employee: {
          mode: 'new',
          name: 'Invalid',
          surname: 'Date',
          startDate: '2026-02-31',
          contractTypeId: contractType.id,
        },
      },
    });
    expect(invalidDate.statusCode).toBe(400);
    expect(await prisma.employee.count({ where: { email } })).toBe(0);

    expect(await prisma.employee.count({ where: { email } })).toBe(0);

    const invalidType = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie },
      payload: {
        email,
        password: 'Atomic#Employee2026',
        roleKeys: ['project_manager'],
        employee: {
          mode: 'new',
          name: 'Atomic',
          surname: 'Failure',
          startDate: '2026-01-01',
          rate: 100,
          contractTypeId: 2147483647,
        },
      },
    });
    expect(invalidType.statusCode).toBe(422);
    expect(invalidType.json().error).toBe('INVALID_CONTRACT_TYPE');
    expect(await prisma.employee.count({ where: { email } })).toBe(0);

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie },
      payload: {
        email,
        password: 'Atomic#Employee2026',
        roleKeys: ['project_manager'],
        employee: { mode: 'new', name: 'Missing fields' },
      },
    });
    expect(malformed.statusCode).toBe(400);
    expect(await prisma.employee.count({ where: { email } })).toBe(0);
  });

  it('rejects a weak password with the policy message', async () => {
    const cookie = await sessionFor('administrator');
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie },
      payload: {
        email: `weak-${Date.now().toString(36)}@example.test`,
        password: 'short',
        roleKeys: ['billing_clerk'],
        employee: {
          mode: 'new',
          name: 'Weak',
          surname: 'Pass',
          startDate: '2026-01-01',
          rate: 100,
          contractTypeId: (
            await prisma.employeeContractType.findFirstOrThrow({
              where: { isArchived: false },
              select: { id: true },
            })
          ).id,
        },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('WEAK_PASSWORD');
  });

  it('deactivates rather than deletes, and revokes live sessions', async () => {
    const adminCookie = await sessionFor('administrator');
    const email = `deactivate-${Date.now().toString(36)}@example.test`;

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie: adminCookie },
      payload: {
        email,
        password: 'Deactivate#Pass2026',
        roleKeys: ['billing_clerk'],
        employee: {
          mode: 'new',
          name: 'De',
          surname: 'Activate',
          startDate: '2026-01-01',
          rate: 100,
          contractTypeId: (
            await prisma.employeeContractType.findFirstOrThrow({
              where: { isArchived: false },
              select: { id: true },
            })
          ).id,
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const userId = created.json().user.id;
    const employeeId = (
      await prisma.appUser.findUniqueOrThrow({
        where: { id: userId },
        select: { employeeId: true },
      })
    ).employeeId;

    // The new account can sign in, so we can prove its session dies with it.
    const victimCookie = await login(app, email, 'Deactivate#Pass2026');

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${userId}`,
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.deactivated).toBe(true);
    expect(response.json().user.deleted).toBe(false);

    // The row survives; only is_active changed.
    const row = await prisma.appUser.findUniqueOrThrow({ where: { id: userId } });
    expect(row.isActive).toBe(false);

    // The previously valid cookie no longer authenticates.
    const after = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: victimCookie },
    });
    expect(after.statusCode).toBe(401);

    await prisma.appUser.deleteMany({ where: { id: userId } });
    await prisma.employee.deleteMany({ where: { id: employeeId } });
  });

  it('resets a password and invalidates existing sessions', async () => {
    const adminCookie = await sessionFor('administrator');
    const email = `reset-${Date.now().toString(36)}@example.test`;

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie: adminCookie },
      payload: {
        email,
        password: 'Original#Pass2026',
        roleKeys: ['billing_clerk'],
        employee: {
          mode: 'new',
          name: 'Re',
          surname: 'Set',
          startDate: '2026-01-01',
          rate: 100,
          contractTypeId: (
            await prisma.employeeContractType.findFirstOrThrow({
              where: { isArchived: false },
              select: { id: true },
            })
          ).id,
        },
      },
    });
    const userId = created.json().user.id;
    const employeeId = (
      await prisma.appUser.findUniqueOrThrow({
        where: { id: userId },
        select: { employeeId: true },
      })
    ).employeeId;

    const oldCookie = await login(app, email, 'Original#Pass2026');

    const reset = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${userId}`,
      headers: { cookie: adminCookie },
      payload: { password: 'Rotated#Pass2026' },
    });
    expect(reset.statusCode).toBe(200);

    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: oldCookie } }))
        .statusCode,
    ).toBe(401);
    await login(app, email, 'Rotated#Pass2026'); // throws if the reset failed

    await prisma.appUser.deleteMany({ where: { id: userId } });
    await prisma.employee.deleteMany({ where: { id: employeeId } });
  });
});

describe('Gate 5: lockouts are impossible', () => {
  it('refuses self-deactivation', async () => {
    const cookie = await sessionFor('administrator');
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    const selfId = me.json().user.id;

    const viaDelete = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${selfId}`,
      headers: { cookie },
    });
    expect(viaDelete.statusCode).toBe(409);
    expect(viaDelete.json().error).toBe('SELF_LOCKOUT');

    const viaPatch = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${selfId}`,
      headers: { cookie },
      payload: { isActive: false },
    });
    expect(viaPatch.statusCode).toBe(409);
  });

  it('refuses removing your own administrator role', async () => {
    const cookie = await sessionFor('administrator');
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${me.json().user.id}`,
      headers: { cookie },
      payload: { roleKeys: ['billing_clerk'] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('SELF_LOCKOUT');
  });

  it('refuses demoting the last active administrator', async () => {
    const adminCookie = await sessionFor('administrator');
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: adminCookie },
    });
    const selfId = me.json().user.id as number;

    // Deactivating every other administrator leaves this one as the last, so the
    // last-administrator guard must refuse. They are restored in the `finally`
    // so the baseline is unchanged whatever happens.
    const others = await prisma.appUser.findMany({
      where: {
        isActive: true,
        id: { not: selfId },
        roles: { some: { role: { key: 'administrator' } } },
      },
      select: { id: true },
    });

    try {
      for (const other of others) {
        await prisma.appUser.update({ where: { id: other.id }, data: { isActive: false } });
      }

      const remaining = await prisma.appUser.count({
        where: { isActive: true, roles: { some: { role: { key: 'administrator' } } } },
      });
      expect(remaining).toBe(1);

      // This account is now the last one, so it cannot be removed.
      const retainingAdminButDeactivating = await app.inject({
        method: 'PATCH',
        url: `/api/admin/users/${selfId}`,
        headers: { cookie: adminCookie },
        payload: { isActive: false, roleKeys: ['administrator'] },
      });
      expect(retainingAdminButDeactivating.statusCode).toBe(409);
      // Self-deactivation is rejected before the last-admin count is consulted.
      expect(retainingAdminButDeactivating.json().error).toBe('SELF_LOCKOUT');

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/users/${selfId}`,
        headers: { cookie: adminCookie },
        payload: { roleKeys: ['billing_clerk'] },
      });
      expect(response.statusCode).toBe(409);
      expect(['SELF_LOCKOUT', 'LAST_ADMINISTRATOR']).toContain(response.json().error);
    } finally {
      for (const other of others) {
        await prisma.appUser.update({ where: { id: other.id }, data: { isActive: true } });
      }
    }

    const restored = await prisma.appUser.count({
      where: { isActive: true, roles: { some: { role: { key: 'administrator' } } } },
    });
    expect(restored).toBe(others.length + 1);
  });

  it('serialises two concurrent demotions of the last two administrators', async () => {
    // Both disposable administrators demote the other at the same time. Without
    // the row locks in `lockActiveAdministrators`, each transaction observes
    // "the other one remains", both commit, and the system is left with zero
    // administrators. With the locks, one blocks, re-reads the post-commit state
    // and is refused.
    const actorA = await createTestUser(['administrator']);
    const actorB = await createTestUser(['administrator']);
    createdUsers.push(actorA, actorB);

    const cookieA = await login(app, actorA.email, TEST_PASSWORD);
    const cookieB = await login(app, actorB.email, TEST_PASSWORD);

    // Every other active administrator is stepped out of the way, so only these
    // two remain — the situation the race corrupts. Restored in the `finally`.
    const others = await prisma.appUser.findMany({
      where: {
        isActive: true,
        id: { notIn: [actorA.id, actorB.id] },
        roles: { some: { role: { key: 'administrator' } } },
      },
      select: { id: true },
    });

    try {
      for (const other of others) {
        await prisma.appUser.update({ where: { id: other.id }, data: { isActive: false } });
      }

      const demote = (cookie: string, targetId: number) =>
        app.inject({
          method: 'PATCH',
          url: `/api/admin/users/${targetId}`,
          headers: { cookie },
          payload: { roleKeys: ['billing_clerk'] },
        });

      const [first, second] = await Promise.all([
        demote(cookieA, actorB.id),
        demote(cookieB, actorA.id),
      ]);

      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
      const loser = first.statusCode === 409 ? first : second;
      expect(loser.json().error).toBe('LAST_ADMINISTRATOR');

      const remaining = await prisma.appUser.count({
        where: { isActive: true, roles: { some: { role: { key: 'administrator' } } } },
      });
      expect(remaining).toBe(1);
    } finally {
      for (const other of others) {
        await prisma.appUser.update({ where: { id: other.id }, data: { isActive: true } });
      }
    }
  });
});

describe('Gate 6: the admin surface is closed to everyone else', () => {
  it('refuses every non-administrator role', async () => {
    for (const role of ['billing_clerk', 'project_manager', 'commercial_qs', 'site_supervisor']) {
      const cookie = await sessionFor(role);
      for (const url of [
        '/api/admin/users',
        '/api/admin/roles',
        '/api/admin/audit',
        '/api/admin/audit/summary',
      ]) {
        const response = await app.inject({ method: 'GET', url, headers: { cookie } });
        expect(response.statusCode, `${role} -> ${url}`).toBe(403);
      }
    }
  });

  it('refuses unauthenticated access', async () => {
    for (const url of ['/api/admin/users', '/api/admin/roles', '/api/admin/audit']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
  });
});

describe('the audit register itself', () => {
  it('filters by model, action and actor, and paginates', async () => {
    const cookie = await sessionFor('administrator');

    const all = await app.inject({
      method: 'GET',
      url: '/api/admin/audit?limit=5',
      headers: { cookie },
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().entries.length).toBeLessThanOrEqual(5);
    expect(all.json().total).toBeGreaterThan(0);

    const byModel = await app.inject({
      method: 'GET',
      url: '/api/admin/audit?model=Client',
      headers: { cookie },
    });
    expect(
      (byModel.json().entries as Array<{ model: string }>).every((e) => e.model === 'Client'),
    ).toBe(true);

    const byAction = await app.inject({
      method: 'GET',
      url: '/api/admin/audit?action=CREATE',
      headers: { cookie },
    });
    expect(
      (byAction.json().entries as Array<{ action: string }>).every((e) => e.action === 'CREATE'),
    ).toBe(true);

    const paged = await app.inject({
      method: 'GET',
      url: '/api/admin/audit?limit=2&offset=0',
      headers: { cookie },
    });
    const second = await app.inject({
      method: 'GET',
      url: '/api/admin/audit?limit=2&offset=2',
      headers: { cookie },
    });
    const firstIds = (paged.json().entries as Array<{ id: string }>).map((e) => e.id);
    const secondIds = (second.json().entries as Array<{ id: string }>).map((e) => e.id);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  });

  it('reports the model list and activity summary', async () => {
    const cookie = await sessionFor('administrator');

    const models = await app.inject({
      method: 'GET',
      url: '/api/admin/audit/models',
      headers: { cookie },
    });
    expect(models.statusCode).toBe(200);
    expect((models.json().models as string[]).length).toBeGreaterThan(0);

    const summary = await app.inject({
      method: 'GET',
      url: '/api/admin/audit/summary',
      headers: { cookie },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().activity.total).toBeGreaterThan(0);
    // A silently failing audit hook must be visible rather than merely absent.
    expect(typeof summary.json().auditWriteFailures).toBe('number');
    expect(summary.json().auditWriteFailures).toBe(0);
  });

  it('rejects an invalid date range rather than silently ignoring it', async () => {
    const cookie = await sessionFor('administrator');
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/audit?from=not-a-date',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });
});
