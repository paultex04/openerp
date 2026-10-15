/**
 * Admin API: user accounts, the role/permission matrix, and the audit log.
 *
 * RBAC map (administrator only — no other role holds any `admin.*` grant):
 *   admin.user.read   — list users and the role matrix
 *   admin.user.write  — create users, change roles, deactivate, reset credentials
 *   admin.role.read   — roles and their permissions
 *   admin.role.write  — edit grants on the four non-administrator built-in roles
 *   admin.audit.read  — read the audit log
 *
 * ## Users are deactivated, never hard-deleted
 *
 * `DELETE /api/admin/users/:id` deactivates rather than deletes. A hard delete
 * would cascade away the user's audit trail attribution and, worse, leave
 * `job.supervisor_id` and `job_assignment` rows dangling or silently orphaned —
 * the operational record of who was on a job must survive the account. The audit
 * log deliberately denormalises the actor for the same reason.
 *
 * ## Self-lockout is prevented
 *
 * An administrator cannot deactivate themselves, and cannot remove their own last
 * administrator role. Either would leave the system with no way back in, and the
 * recovery path (direct SQL against a production database) is exactly the kind of
 * emergency this system should not create for itself.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS, ROLE_ADMINISTRATOR, ROLE_KEYS, ROLE_PERMISSIONS } from '@openerp/shared';
import { prisma } from '../db/client.js';
import { HttpError } from '../auth/plugin.js';
import { hashPassword, PasswordPolicyError } from '../auth/password.js';
import { auditFailureCount, auditModels, auditSummary, queryAudit } from '../audit/service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('A valid email address is required.')
  .max(255);

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A valid start date is required.')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'A valid start date is required.');

const createUserSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'A password is required.'),
  roleKeys: z.array(z.string().trim().min(1)).min(1, 'Assign at least one role.'),
  employee: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('existing'), employeeId: z.coerce.number().int().positive() }),
    z.object({
      mode: z.literal('new'),
      name: z.string().trim().min(1).max(100),
      surname: z.string().trim().min(1).max(100),
      startDate: isoDateSchema,
      contractTypeId: z.coerce.number().int().positive(),
    }),
  ]),
});

const updateRolePermissionsSchema = z.object({
  permissionKeys: z
    .array(z.string().trim().min(1))
    .refine((keys) => new Set(keys).size === keys.length, 'Permission keys must be unique.'),
});

const updateUserSchema = z
  .object({
    roleKeys: z.array(z.string().trim().min(1)).optional(),
    isActive: z.boolean().optional(),
    /** Sets a new password and forces every existing session to end. */
    password: z.string().min(1).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });

function serialise<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) out[key] = value.toISOString();
    else if (value !== null && typeof value === 'object' && 'toNumber' in value) {
      out[key] = (value as { toNumber(): number }).toNumber();
    } else out[key] = value;
  }
  return out;
}

/** Resolves role keys to ids, failing loudly on an unknown key. */
async function resolveRoles(roleKeys: string[]): Promise<Array<{ id: number; key: string }>> {
  const roles = await prisma.appRole.findMany({
    where: { key: { in: roleKeys } },
    select: { id: true, key: true },
  });
  const missing = roleKeys.filter((k) => !roles.some((r) => r.key === k));
  if (missing.length > 0) {
    throw new HttpError(
      422,
      'UNKNOWN_ROLE',
      `Unknown role(s): ${missing.join(', ')}. Run "npm run seed --workspace server" first.`,
    );
  }
  return roles;
}

/** Whether a user currently holds the administrator role. */
async function holdsAdministratorRole(userId: number): Promise<boolean> {
  return (
    (await prisma.appUserRole.findFirst({
      where: { userId, role: { key: 'administrator' } },
      select: { userId: true },
    })) !== null
  );
}

async function assertNotLastAdministrator(userId: number, nextRoles: string[]): Promise<void> {
  const remaining = await prisma.appUser.count({
    where: {
      isActive: true,
      id: { not: userId },
      roles: { some: { role: { key: 'administrator' } } },
    },
  });
  if (remaining === 0 && !nextRoles.includes('administrator')) {
    throw new HttpError(
      409,
      'LAST_ADMINISTRATOR',
      'This is the last active administrator. Promote another administrator before changing ' +
        'this account, otherwise nobody can administer the system.',
    );
  }
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  // =======================================================================
  // Roles and the permission matrix
  // =======================================================================

  app.get(
    '/api/admin/roles',
    { preHandler: [app.authenticate, app.requirePermission('admin.role.read')] },
    async () => {
      const roles = await prisma.appRole.findMany({
        orderBy: { key: 'asc' },
        include: { permissions: { include: { permission: true } } },
      });

      return {
        // Live grants are authoritative. `expected` is only the initial seed
        // default, retained to provide context to administrators.
        permissions: PERMISSIONS.map((p) => ({
          key: p.key,
          // The catalogue's category is the RBAC module, e.g. 'invoice'.
          module: p.category,
          description: p.description,
        })),
        roles: roles.map((r) => ({
          id: r.id,
          key: r.key,
          name: r.name,
          description: r.description,
          granted: r.permissions.map((rp) => rp.permission.key).sort(),
          expected: [...(ROLE_PERMISSIONS[r.key] ?? [])].sort(),
          locked: r.key === ROLE_ADMINISTRATOR,
        })),
      };
    },
  );

  app.put(
    '/api/admin/roles/:key/permissions',
    { preHandler: [app.authenticate, app.requirePermission('admin.role.write')] },
    async (request: FastifyRequest) => {
      const { key } = z.object({ key: z.string().trim().min(1) }).parse(request.params);
      const { permissionKeys } = updateRolePermissionsSchema.parse(request.body);

      if (!ROLE_KEYS.includes(key)) {
        throw new HttpError(404, 'ROLE_NOT_FOUND', `Built-in role "${key}" does not exist.`);
      }
      if (key === ROLE_ADMINISTRATOR) {
        throw new HttpError(
          409,
          'ROLE_LOCKED',
          'The administrator role is protected and always holds every catalogue permission.',
        );
      }

      const forbidden = permissionKeys.filter((permission) => permission.startsWith('admin.'));
      if (forbidden.length) {
        throw new HttpError(
          422,
          'PROTECTED_PERMISSION',
          'Administrator permissions cannot be granted to non-administrator roles.',
        );
      }

      const unknown = permissionKeys.filter(
        (permission) => !PERMISSIONS.some((p) => p.key === permission),
      );
      if (unknown.length) {
        throw new HttpError(
          422,
          'UNKNOWN_PERMISSION',
          `Unknown permission(s): ${unknown.join(', ')}.`,
        );
      }

      const role = await prisma.appRole.findUnique({ where: { key }, select: { id: true } });
      if (!role)
        throw new HttpError(404, 'ROLE_NOT_FOUND', `Built-in role "${key}" does not exist.`);
      const permissions = await prisma.permission.findMany({
        where: { key: { in: permissionKeys } },
        select: { id: true, key: true },
      });
      if (permissions.length !== permissionKeys.length) {
        throw new HttpError(
          422,
          'UNKNOWN_PERMISSION',
          'One or more permissions are not provisioned. Rerun the seed.',
        );
      }

      await prisma.$transaction(async (tx) => {
        const existing = await tx.rolePermission.findMany({
          where: { roleId: role.id },
          select: { permissionId: true },
        });
        for (const grant of existing) {
          await tx.rolePermission.delete({
            where: { roleId_permissionId: { roleId: role.id, permissionId: grant.permissionId } },
          });
        }
        for (const permission of permissions) {
          await tx.rolePermission.create({
            data: { roleId: role.id, permissionId: permission.id },
          });
        }
        await tx.appRole.update({
          where: { id: role.id },
          data: { permissionsCustomized: true },
        });
      });

      return { roleKey: key, granted: permissionKeys.slice().sort() };
    },
  );

  // =======================================================================
  // Users
  // =======================================================================

  app.get(
    '/api/admin/users',
    { preHandler: [app.authenticate, app.requirePermission('admin.user.read')] },
    async () => {
      const users = await prisma.appUser.findMany({
        orderBy: { id: 'asc' },
        select: {
          id: true,
          email: true,
          isActive: true,
          tokenVersion: true,
          lastLoginAt: true,
          createdAt: true,
          employee: { select: { id: true, name: true, surname: true, email: true } },
          roles: {
            select: {
              role: {
                select: {
                  id: true,
                  key: true,
                  name: true,
                  permissions: { select: { permission: { select: { key: true } } } },
                },
              },
            },
          },
        },
      });

      return {
        users: users.map((u) => ({
          ...serialise(u),
          roleKeys: u.roles.map((r) => r.role.key),
          roles: u.roles.map((r) => r.role),
          permissionCount: new Set(
            u.roles.flatMap((r) => r.role.permissions.map((rp) => rp.permission.key)),
          ).size,
        })),
      };
    },
  );

  app.get(
    '/api/admin/users/create-options',
    { preHandler: [app.authenticate, app.requirePermission('admin.user.write')] },
    async () => {
      const [employees, contractTypes] = await Promise.all([
        prisma.employee.findMany({
          where: { endDate: null, appUser: null },
          orderBy: [{ surname: 'asc' }, { name: 'asc' }],
          select: { id: true, name: true, surname: true, email: true },
        }),
        prisma.employeeContractType.findMany({
          where: { isArchived: false },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
      ]);
      return { employees, contractTypes };
    },
  );

  app.post(
    '/api/admin/users',
    { preHandler: [app.authenticate, app.requirePermission('admin.user.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createUserSchema.parse(request.body);

      const existing = await prisma.appUser.findUnique({ where: { email: body.email } });
      if (existing) {
        throw new HttpError(409, 'EMAIL_TAKEN', `${body.email} already has an account.`);
      }

      const roles = await resolveRoles(body.roleKeys);

      let passwordHash: string;
      try {
        passwordHash = await hashPassword(body.password);
      } catch (e) {
        if (e instanceof PasswordPolicyError) {
          throw new HttpError(422, 'WEAK_PASSWORD', e.message);
        }
        throw e;
      }

      // Employee selection and account creation share one transaction. The
      // unique employee_id constraint is the final guard against concurrent
      // attempts to attach two accounts to the same person.
      const result = await prisma.$transaction(async (tx) => {
        let employeeId: number;
        if (body.employee.mode === 'existing') {
          const employee = await tx.employee.findUnique({
            where: { id: body.employee.employeeId },
            select: { id: true, endDate: true, appUser: { select: { id: true } } },
          });
          if (!employee || employee.endDate !== null) {
            throw new HttpError(
              422,
              'EMPLOYEE_NOT_ELIGIBLE',
              'Select an active employee without an application user.',
            );
          }
          if (employee.appUser) {
            throw new HttpError(409, 'EMPLOYEE_HAS_USER', 'This employee already has an account.');
          }
          employeeId = employee.id;
        } else {
          const contractType = await tx.employeeContractType.findUnique({
            where: { id: body.employee.contractTypeId },
            select: { id: true, isArchived: true },
          });
          if (!contractType || contractType.isArchived) {
            throw new HttpError(422, 'INVALID_CONTRACT_TYPE', 'Select an active contract type.');
          }
          const employee = await tx.employee.create({
            data: {
              name: body.employee.name,
              surname: body.employee.surname,
              email: body.email,
              startDate: new Date(`${body.employee.startDate}T00:00:00.000Z`),
              contractTypeId: contractType.id,
            },
            select: { id: true },
          });
          employeeId = employee.id;
        }

        const user = await tx.appUser.create({
          data: {
            employeeId,
            email: body.email,
            passwordHash,
            isActive: true,
            roles: { create: roles.map((r) => ({ roleId: r.id })) },
          },
          select: { id: true, email: true },
        });
        return { user, employeeId };
      });

      return reply.code(201).send({
        user: {
          id: result.user.id,
          email: result.user.email,
          employeeId: result.employeeId,
          roleKeys: body.roleKeys,
        },
      });
    },
  );

  app.patch(
    '/api/admin/users/:id',
    { preHandler: [app.authenticate, app.requirePermission('admin.user.write')] },
    async (request: FastifyRequest) => {
      const { id } = idParam.parse(request.params);
      const body = updateUserSchema.parse(request.body);
      const actor = request.principal!;

      const existing = await prisma.appUser.findUnique({
        where: { id },
        select: { id: true, email: true, roles: { select: { roleId: true } } },
      });
      if (!existing) throw new HttpError(404, 'USER_NOT_FOUND', `User ${id} does not exist.`);

      const isSelf = actor.userId === id;

      if (body.roleKeys !== undefined) {
        const roles = await resolveRoles(body.roleKeys);
        if (await holdsAdministratorRole(id)) await assertNotLastAdministrator(id, body.roleKeys);

        if (isSelf && !body.roleKeys.includes('administrator')) {
          throw new HttpError(
            409,
            'SELF_LOCKOUT',
            'You cannot remove your own administrator role. Ask another administrator to do it.',
          );
        }

        await prisma.appUserRole.deleteMany({ where: { userId: id } });
        await prisma.appUserRole.createMany({
          data: roles.map((r) => ({ userId: id, roleId: r.id, assignedBy: actor.userId })),
        });
      }

      if (body.isActive !== undefined) {
        if (!body.isActive && isSelf) {
          throw new HttpError(
            409,
            'SELF_LOCKOUT',
            'You cannot deactivate your own account. Ask another administrator to do it.',
          );
        }
        if (!body.isActive && (await holdsAdministratorRole(id))) {
          await assertNotLastAdministrator(id, []);
        }

        await prisma.appUser.update({
          where: { id },
          // Bumping tokenVersion invalidates every existing session for the user,
          // so a deactivated or re-roled account loses access immediately rather
          // than at token expiry.
          data: {
            isActive: body.isActive,
            ...(body.isActive === false && { tokenVersion: { increment: 1 } }),
          },
        });
      }

      if (body.password !== undefined) {
        let passwordHash: string;
        try {
          passwordHash = await hashPassword(body.password);
        } catch (e) {
          if (e instanceof PasswordPolicyError) {
            throw new HttpError(422, 'WEAK_PASSWORD', e.message);
          }
          throw e;
        }
        await prisma.appUser.update({
          where: { id },
          data: { passwordHash, tokenVersion: { increment: 1 } },
        });
      }

      const updated = await prisma.appUser.findUniqueOrThrow({
        where: { id },
        select: {
          id: true,
          email: true,
          isActive: true,
          roles: {
            select: {
              role: {
                select: {
                  key: true,
                  permissions: { select: { permission: { select: { key: true } } } },
                },
              },
            },
          },
        },
      });

      return {
        user: {
          id: updated.id,
          email: updated.email,
          isActive: updated.isActive,
          roleKeys: updated.roles.map((r) => r.role.key),
        },
      };
    },
  );

  /** Deactivates rather than deletes. See the module docstring for why. */
  app.delete(
    '/api/admin/users/:id',
    { preHandler: [app.authenticate, app.requirePermission('admin.user.write')] },
    async (request: FastifyRequest) => {
      const { id } = idParam.parse(request.params);
      const actor = request.principal!;

      if (actor.userId === id) {
        throw new HttpError(409, 'SELF_LOCKOUT', 'You cannot deactivate your own account.');
      }

      const existing = await prisma.appUser.findUnique({
        where: { id },
        select: { id: true, roles: { select: { role: { select: { key: true } } } } },
      });
      if (!existing) throw new HttpError(404, 'USER_NOT_FOUND', `User ${id} does not exist.`);

      if (existing.roles.some((r) => r.role.key === 'administrator')) {
        await assertNotLastAdministrator(id, []);
      }

      await prisma.appUser.update({
        where: { id },
        data: { isActive: false, tokenVersion: { increment: 1 } },
      });

      return { user: { id, isActive: false, deleted: false, deactivated: true } };
    },
  );

  // =======================================================================
  // Audit log (read-only)
  // =======================================================================

  app.get(
    '/api/admin/audit',
    { preHandler: [app.authenticate, app.requirePermission('admin.audit.read')] },
    async (request: FastifyRequest) => {
      const query = z
        .object({
          model: z.string().trim().min(1).optional(),
          actorUserId: z.coerce.number().int().positive().optional(),
          action: z.enum(['CREATE', 'UPDATE', 'DELETE']).optional(),
          from: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          to: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          search: z.string().trim().min(1).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .parse(request.query ?? {});

      // The query schema yields ISO date strings; the service wants Dates. Build
      // the filter explicitly rather than spreading, so a stray string can never
      // reach Prisma as a date.
      const result = await queryAudit({
        model: query.model,
        actorUserId: query.actorUserId,
        action: query.action,
        search: query.search,
        limit: query.limit,
        offset: query.offset,
        ...(query.from !== undefined && { from: new Date(`${query.from}T00:00:00Z`) }),
        // Inclusive of the whole `to` day.
        ...(query.to !== undefined && { to: new Date(`${query.to}T23:59:59.999Z`) }),
      });

      return { ...result, limit: query.limit ?? 100, offset: query.offset ?? 0 };
    },
  );

  app.get(
    '/api/admin/audit/models',
    { preHandler: [app.authenticate, app.requirePermission('admin.audit.read')] },
    async () => ({ models: await auditModels() }),
  );

  app.get(
    '/api/admin/audit/summary',
    { preHandler: [app.authenticate, app.requirePermission('admin.audit.read')] },
    async (request: FastifyRequest) => {
      const query = z
        .object({
          from: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          to: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        })
        .parse(request.query ?? {});

      return {
        activity: await auditSummary(
          query.from !== undefined ? new Date(`${query.from}T00:00:00Z`) : undefined,
          query.to !== undefined ? new Date(`${query.to}T23:59:59.999Z`) : undefined,
        ),
        // Surfaced so a silently failing audit hook cannot go unnoticed.
        auditWriteFailures: auditFailureCount(),
      };
    },
  );
}
