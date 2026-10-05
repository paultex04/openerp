/**
 * Organisation: brokers, employee contract types, employees and client contacts.
 *
 * RBAC: `broker.*`, `contracttype.*`, `employee.*`, `contact.*`, plus the Phase 8
 * `*.archive` keys. Clients deliberately do NOT appear here — they live in
 * `contracts.ts` behind `contract.*`. See ADR-007 Q1.
 *
 * Before Phase 7 none of these four tables had a single server route. Employees
 * could only be created as a side-effect of `POST /api/admin/users`, which means
 * a site supervisor who never gets a login could not be recorded at all. That was
 * the gap; these routes are the fix.
 *
 * Two deletions are intentionally impossible:
 *
 *  - **Employees are never hard-deleted.** An employee supervises jobs, is
 *    attached to crews and manages reports, and `app_user.employee_id` is a
 *    non-nullable 1-to-1. Deleting one voids the record of work people actually
 *    did, so `DELETE` sets `endDate` instead. See ADR-007 Q4.
 *  - **Contacts and contract types refuse while referenced**, with a 409 that
 *    names the count, matching the contract and client deletes.
 *
 * ## Archiving, and who may see an archived row
 *
 * Phase 8 item 3. The rule, applied consistently:
 *
 *  - **A list endpoint hides archived rows by default** and takes
 *    `?includeArchived=true` to show them. The default matters more than the flag:
 *    a register that quietly accumulates retired rows stops being readable.
 *  - **A picker excludes archived rows, always.** There is no flag. You cannot
 *    scope new work against an archived contract or attach a retired broker to a
 *    crew. This is what makes archiving safe, and it is why the column exists at
 *    all rather than a `status` enum with more states.
 *  - **Archiving never cascades.** It is one row, explicitly, every time. A cascade
 *    here would be invisible and could retire a contract four live jobs depend on.
 *  - **The server is the judge of whether a row may be archived**, not the client:
 *    `archiveBlockedBy` re-checks the references at write time rather than trusting
 *    a count the browser rendered earlier.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  brokerUpsertSchema,
  contactUpdateSchema,
  contactUpsertSchema,
  employeeContractTypeUpsertSchema,
  employeeUpdateSchema,
  employeeUpsertSchema,
} from '@openerp/shared';
import { prisma } from '../db/client.js';
import { HttpError } from '../auth/plugin.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Shared `?search=` parsing. Every list here is searchable and bounded. */
const listQuery = z.object({ search: z.string().trim().min(1).optional() });

/** Lists take this; pickers must not, which is the whole point of the column. */
const listQueryWithArchive = listQuery.extend({
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

/** `where` fragment that hides archived rows unless explicitly asked for them. */
const notArchived = { isArchived: false };
const includeArchived = {};

export async function registerOrganisationRoutes(app: FastifyInstance): Promise<void> {
  // =======================================================================
  // Brokers
  // =======================================================================
  app.get(
    '/api/brokers',
    { preHandler: [app.authenticate, app.requirePermission('broker.read')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { search, includeArchived: showArchived } = listQueryWithArchive.parse(
        request.query ?? {},
      );
      const brokers = await prisma.broker.findMany({
        where: {
          ...(showArchived ? includeArchived : notArchived),
          ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
        },
        orderBy: [{ isArchived: 'asc' }, { name: 'asc' }],
        include: {
          _count: { select: { employees: { where: { endDate: null } } } },
        },
      });
      return {
        brokers: brokers.map((b) => ({
          id: b.id,
          name: b.name,
          isArchived: b.isArchived,
          activeEmployees: b._count.employees,
        })),
      };
    },
  );

  app.post(
    '/api/brokers',
    { preHandler: [app.authenticate, app.requirePermission('broker.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = brokerUpsertSchema.parse(request.body);
      const broker = await prisma.broker.create({ data: { name: body.name } });
      return reply.code(201).send({ broker });
    },
  );

  app.patch(
    '/api/brokers/:id',
    { preHandler: [app.authenticate, app.requirePermission('broker.write')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = brokerUpsertSchema.partial().parse(request.body);
      const existing = await prisma.broker.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Broker ${id} does not exist.`);
      const broker = await prisma.broker.update({
        where: { id },
        data: { ...(body.name !== undefined && { name: body.name }) },
      });
      return { broker };
    },
  );

  app.delete(
    '/api/brokers/:id',
    { preHandler: [app.authenticate, app.requirePermission('broker.delete')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const existing = await prisma.broker.findUnique({
        where: { id },
        select: { id: true, name: true, _count: { select: { employees: true } } },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Broker ${id} does not exist.`);
      if (existing._count.employees > 0) {
        throw new HttpError(
          409,
          'CONFLICT',
          `Broker "${existing.name}" is still attached to ${existing._count.employees} employee(s). ` +
            `Reassign them first, or leave the broker in place as the historical record.`,
        );
      }
      await prisma.broker.delete({ where: { id } });
      return reply.code(204).send();
    },
  );

  // =======================================================================
  // Employee contract types
  // =======================================================================
  app.get(
    '/api/employee-contract-types',
    { preHandler: [app.authenticate, app.requirePermission('contracttype.read')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { search, includeArchived: showArchived } = listQueryWithArchive.parse(
        request.query ?? {},
      );
      const types = await prisma.employeeContractType.findMany({
        where: {
          ...(showArchived ? includeArchived : notArchived),
          ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
        },
        orderBy: [{ isArchived: 'asc' }, { name: 'asc' }],
        include: { _count: { select: { employees: true } } },
      });
      return {
        types: types.map((t) => ({
          id: t.id,
          name: t.name,
          isArchived: t.isArchived,
          employees: t._count.employees,
        })),
      };
    },
  );

  app.post(
    '/api/employee-contract-types',
    { preHandler: [app.authenticate, app.requirePermission('contracttype.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = employeeContractTypeUpsertSchema.parse(request.body);
      // `name` is unique; a duplicate is a 409 with a useful message rather than
      // a raw Prisma error surfacing as a 500.
      const clash = await prisma.employeeContractType.findUnique({
        where: { name: body.name },
        select: { id: true },
      });
      if (clash) {
        throw new HttpError(
          409,
          'CONFLICT',
          `A contract type named "${body.name}" already exists.`,
        );
      }
      const type = await prisma.employeeContractType.create({ data: { name: body.name } });
      return reply.code(201).send({ type });
    },
  );

  app.patch(
    '/api/employee-contract-types/:id',
    { preHandler: [app.authenticate, app.requirePermission('contracttype.write')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = employeeContractTypeUpsertSchema.partial().parse(request.body);
      const existing = await prisma.employeeContractType.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!existing) {
        throw new HttpError(404, 'NOT_FOUND', `Contract type ${id} does not exist.`);
      }
      const type = await prisma.employeeContractType.update({
        where: { id },
        data: { ...(body.name !== undefined && { name: body.name }) },
      });
      return { type };
    },
  );

  app.delete(
    '/api/employee-contract-types/:id',
    { preHandler: [app.authenticate, app.requirePermission('contracttype.delete')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const existing = await prisma.employeeContractType.findUnique({
        where: { id },
        select: { id: true, name: true, _count: { select: { employees: true } } },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Contract type ${id} does not exist.`);
      // `contractTypeId` is non-nullable on Employee, so there is no "unassign"
      // that would make this safe while anyone holds it.
      if (existing._count.employees > 0) {
        throw new HttpError(
          409,
          'CONFLICT',
          `${existing._count.employees} employee(s) are on the "${existing.name}" contract type. ` +
            `Move them to another type first.`,
        );
      }
      await prisma.employeeContractType.delete({ where: { id } });
      return reply.code(204).send();
    },
  );

  // =======================================================================
  // Employees
  // =======================================================================
  app.get(
    '/api/employees',
    { preHandler: [app.authenticate, app.requirePermission('employee.read')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { search, active } = z
        .object({
          search: z.string().trim().min(1).optional(),
          active: z.enum(['true', 'false']).optional(),
        })
        .parse(request.query ?? {});

      const employees = await prisma.employee.findMany({
        where: {
          ...(search
            ? {
                OR: [
                  { name: { contains: search, mode: 'insensitive' as const } },
                  { surname: { contains: search, mode: 'insensitive' as const } },
                  { email: { contains: search, mode: 'insensitive' as const } },
                  { mobile: { contains: search, mode: 'insensitive' as const } },
                ],
              }
            : {}),
          ...(active === 'true' ? { endDate: null } : {}),
          ...(active === 'false' ? { endDate: { not: null } } : {}),
        },
        orderBy: [{ surname: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          surname: true,
          mobile: true,
          email: true,
          idNumber: true,
          startDate: true,
          endDate: true,
          rate: true,
          brokerId: true,
          contractTypeId: true,
          managerId: true,
          broker: { select: { id: true, name: true } },
          contractType: { select: { id: true, name: true } },
          manager: { select: { id: true, name: true, surname: true } },
          _count: { select: { jobAssignments: true, supervisedJobs: true } },
        },
      });

      return {
        employees: employees.map((e) => ({
          ...e,
          startDate: e.startDate.toISOString().slice(0, 10),
          endDate: e.endDate?.toISOString().slice(0, 10) ?? null,
          rate: e.rate?.toNumber() ?? null,
          fullName: `${e.name} ${e.surname}`,
          isActive: e.endDate === null,
        })),
      };
    },
  );

  app.get(
    '/api/employees/:id',
    { preHandler: [app.authenticate, app.requirePermission('employee.read')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const employee = await prisma.employee.findUnique({
        where: { id },
        include: {
          broker: { select: { id: true, name: true } },
          contractType: { select: { id: true, name: true } },
          manager: { select: { id: true, name: true, surname: true } },
          reports: { select: { id: true, name: true, surname: true, endDate: true } },
        },
      });
      if (!employee) throw new HttpError(404, 'NOT_FOUND', `Employee ${id} does not exist.`);
      return {
        employee: {
          ...employee,
          startDate: employee.startDate.toISOString().slice(0, 10),
          endDate: employee.endDate?.toISOString().slice(0, 10) ?? null,
          rate: employee.rate?.toNumber() ?? null,
        },
      };
    },
  );

  app.post(
    '/api/employees',
    { preHandler: [app.authenticate, app.requirePermission('employee.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = employeeUpsertSchema.parse(request.body);
      await assertEmployeeReferences(body);

      const employee = await prisma.employee.create({
        data: {
          name: body.name,
          surname: body.surname,
          mobile: body.mobile || null,
          email: body.email || null,
          idNumber: body.idNumber || null,
          startDate: new Date(body.startDate),
          endDate: body.endDate ? new Date(body.endDate) : null,
          brokerId: body.brokerId ?? null,
          contractTypeId: body.contractTypeId,
          managerId: body.managerId ?? null,
          rate: body.rate ?? null,
        },
        select: { id: true },
      });
      return reply.code(201).send({ employee });
    },
  );

  app.patch(
    '/api/employees/:id',
    { preHandler: [app.authenticate, app.requirePermission('employee.write')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = employeeUpdateSchema.parse(request.body);

      const existing = await prisma.employee.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Employee ${id} does not exist.`);

      // An employee cannot manage themselves: `managerId` is a self-referencing
      // relation, and a cycle would make the org chart impossible to render.
      if (body.managerId === id) {
        throw new HttpError(400, 'VALIDATION', 'An employee cannot be their own manager.');
      }
      await assertEmployeeReferences(body);

      const employee = await prisma.employee.update({
        where: { id },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.surname !== undefined && { surname: body.surname }),
          ...(body.mobile !== undefined && { mobile: body.mobile || null }),
          ...(body.email !== undefined && { email: body.email || null }),
          ...(body.idNumber !== undefined && { idNumber: body.idNumber || null }),
          ...(body.endDate !== undefined && {
            endDate: body.endDate ? new Date(body.endDate) : null,
          }),
          ...(body.brokerId !== undefined && { brokerId: body.brokerId ?? null }),
          ...(body.contractTypeId !== undefined && { contractTypeId: body.contractTypeId }),
          ...(body.managerId !== undefined && { managerId: body.managerId ?? null }),
          ...(body.rate !== undefined && { rate: body.rate ?? null }),
        },
        select: { id: true },
      });
      return { employee };
    },
  );

  /**
   * Terminates an employee rather than deleting them. See the module header.
   *
   * The name is `DELETE` because that is the verb the rest of the API uses for
   * "remove this record", and because ADR-005 established that a hard delete of
   * a person cascades away the operational record. But it sets `endDate` and
   * keeps the row.
   */
  app.delete(
    '/api/employees/:id',
    { preHandler: [app.authenticate, app.requirePermission('employee.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const existing = await prisma.employee.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          surname: true,
          endDate: true,
          appUser: { select: { id: true } },
        },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Employee ${id} does not exist.`);
      if (existing.endDate !== null) return reply.code(204).send();

      const today = new Date().toISOString().slice(0, 10);
      await prisma.employee.update({
        where: { id },
        data: {
          endDate: new Date(today),
          // A signed-in account cannot outlive the person behind it. Matches the
          // admin deactivate rule: the account goes, the audit trail stays.
          ...(existing.appUser ? { appUser: { update: { isActive: false } } } : {}),
        },
      });

      return reply.code(204).send();
    },
  );

  // =======================================================================
  // Contacts
  // =======================================================================
  app.get(
    '/api/contacts',
    { preHandler: [app.authenticate, app.requirePermission('contact.read')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const {
        search,
        clientId,
        includeArchived: showArchived,
      } = z
        .object({
          search: z.string().trim().min(1).optional(),
          clientId: z.coerce.number().int().positive().optional(),
          includeArchived: z
            .enum(['true', 'false'])
            .optional()
            .transform((v) => v === 'true'),
        })
        .parse(request.query ?? {});

      const contacts = await prisma.contact.findMany({
        where: {
          ...(showArchived ? includeArchived : notArchived),
          ...(clientId !== undefined ? { clientId } : {}),
          ...(search
            ? {
                OR: [
                  { name: { contains: search, mode: 'insensitive' as const } },
                  { email: { contains: search, mode: 'insensitive' as const } },
                  { mobile: { contains: search, mode: 'insensitive' as const } },
                  { role: { contains: search, mode: 'insensitive' as const } },
                  { client: { name: { contains: search, mode: 'insensitive' as const } } },
                ],
              }
            : {}),
        },
        orderBy: [{ clientId: 'asc' }, { isArchived: 'asc' }, { name: 'asc' }],
        include: {
          client: { select: { id: true, name: true } },
          _count: { select: { jobs: true } },
        },
      });

      return { contacts };
    },
  );

  app.post(
    '/api/contacts',
    { preHandler: [app.authenticate, app.requirePermission('contact.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = contactUpsertSchema.parse(request.body);
      const client = await prisma.client.findUnique({
        where: { id: body.clientId },
        select: { id: true },
      });
      if (!client) {
        throw new HttpError(400, 'INVALID_REFERENCE', `Client ${body.clientId} does not exist.`);
      }

      const contact = await prisma.contact.create({
        data: {
          clientId: body.clientId,
          name: body.name,
          mobile: body.mobile || null,
          email: body.email || null,
          role: body.role || null,
        },
        include: { client: { select: { id: true, name: true } } },
      });
      return reply.code(201).send({ contact });
    },
  );

  app.patch(
    '/api/contacts/:id',
    { preHandler: [app.authenticate, app.requirePermission('contact.write')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = contactUpdateSchema.parse(request.body);
      const existing = await prisma.contact.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Contact ${id} does not exist.`);

      const contact = await prisma.contact.update({
        where: { id },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.mobile !== undefined && { mobile: body.mobile || null }),
          ...(body.email !== undefined && { email: body.email || null }),
          ...(body.role !== undefined && { role: body.role || null }),
        },
        include: { client: { select: { id: true, name: true } } },
      });
      return { contact };
    },
  );

  app.delete(
    '/api/contacts/:id',
    { preHandler: [app.authenticate, app.requirePermission('contact.delete')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const existing = await prisma.contact.findUnique({
        where: { id },
        select: { id: true, name: true, _count: { select: { jobs: true } } },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Contact ${id} does not exist.`);

      // A contact named on a job card is the person who placed the order. Removing
      // them would leave a job pointing at nobody.
      if (existing._count.jobs > 0) {
        throw new HttpError(
          409,
          'CONFLICT',
          `${existing.name} is the named contact on ${existing._count.jobs} job(s). ` +
            `Reassign those jobs before deleting the contact.`,
        );
      }

      await prisma.contact.delete({ where: { id } });
      return reply.code(204).send();
    },
  );

  // =======================================================================
  // Archiving (Phase 8 item 3)
  // =======================================================================

  archive('/api/brokers/:id/archive', 'broker.archive', 'broker', 'Broker');
  archive(
    '/api/employee-contract-types/:id/archive',
    'contracttype.archive',
    'employeeContractType',
    'Contract type',
  );
  archive('/api/contacts/:id/archive', 'contact.archive', 'contact', 'Contact');

  /** Registers POST (archive) / DELETE (restore) for one archivable resource. */
  function archive(
    path: string,
    permission: string,
    model: 'broker' | 'employeeContractType' | 'contact',
    label: string,
  ): void {
    app.post(
      path,
      { preHandler: [app.authenticate, app.requirePermission(permission)] },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = idParam.parse(request.params);
        const updated = await setArchived(model, id, true, label);
        return reply.code(200).send({ archived: { id: updated.id, isArchived: true, label } });
      },
    );

    app.delete(
      path,
      { preHandler: [app.authenticate, app.requirePermission(permission)] },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = idParam.parse(request.params);
        const updated = await setArchived(model, id, false, label);
        return reply.code(200).send({ archived: { id: updated.id, isArchived: false, label } });
      },
    );
  }
}

/**
 * Checks that every foreign key in an employee payload actually resolves.
 *
 * Prisma would otherwise raise a P2003 that surfaces as an opaque 500. Naming the
 * bad field turns it into a 400 the form can display.
 */
async function assertEmployeeReferences(body: {
  brokerId?: number | null;
  contractTypeId?: number;
  managerId?: number | null;
}): Promise<void> {
  if (body.brokerId !== undefined && body.brokerId !== null) {
    const broker = await prisma.broker.findUnique({
      where: { id: body.brokerId },
      select: { id: true },
    });
    if (!broker) {
      throw new HttpError(400, 'INVALID_REFERENCE', `Broker ${body.brokerId} does not exist.`);
    }
  }
  if (body.contractTypeId !== undefined) {
    const type = await prisma.employeeContractType.findUnique({
      where: { id: body.contractTypeId },
      select: { id: true },
    });
    if (!type) {
      throw new HttpError(
        400,
        'INVALID_REFERENCE',
        `Employee contract type ${body.contractTypeId} does not exist.`,
      );
    }
  }
  if (body.managerId !== undefined && body.managerId !== null) {
    const manager = await prisma.employee.findUnique({
      where: { id: body.managerId },
      select: { id: true },
    });
    if (!manager) {
      throw new HttpError(400, 'INVALID_REFERENCE', `Employee ${body.managerId} does not exist.`);
    }
  }
}

// =============================================================================
// Archiving
//
// One row at a time, explicitly, never cascaded. The `*.archive` permissions are
// separate from the `*.delete` ones on purpose: archiving is reversible and is what
// you reach for when a record cannot be deleted because something references it.
// Giving both verbs the same permission is what made "cannot delete" feel like a
// dead end in the first place.
//
// The block check lives here, on the server, rather than in the browser. A count
// the client rendered thirty seconds ago is not a fact about the row, and
// "archive anyway?" is a question that must be answered at write time.
// =============================================================================

/** Sets `isArchived` and returns the row, refusing if live references remain. */
async function setArchived(
  model: 'broker' | 'employeeContractType' | 'contact',
  id: number,
  archived: boolean,
  label: string,
): Promise<{ id: number; isArchived: boolean }> {
  const delegate = prisma[model] as {
    findUnique(args: unknown): Promise<Record<string, unknown> | null>;
    update(args: unknown): Promise<{ id: number; isArchived: boolean }>;
  };

  const existing = (await delegate.findUnique({
    where: { id },
    select: { id: true, name: true, _count: { select: referenceCounts[model] } },
  })) as { id: number; name: string; _count: Record<string, number> } | null;

  if (!existing) throw new HttpError(404, 'NOT_FOUND', `${label} ${id} does not exist.`);

  if (archived) {
    const blocking = Object.entries(existing._count).filter(([, count]) => count > 0);
    if (blocking.length > 0) {
      const detail = blocking
        .map(
          ([relation, count]) => `${count} ${relation.replace(/([A-Z])/g, ' $1').toLowerCase()}(s)`,
        )
        .join(' and ');
      throw new HttpError(
        409,
        'CONFLICT',
        `${label} "${existing.name}" is still referenced by ${detail}. ` +
          `Archiving would hide a record those rows still need.`,
      );
    }
  }

  const updated = await delegate.update({
    where: { id },
    data: { isArchived: archived },
    select: { id: true, isArchived: true },
  });
  return updated;
}

/** What still references each archivable row, for the refusal message. */
const referenceCounts = {
  broker: { employees: true },
  employeeContractType: { employees: true },
  contact: { jobs: true },
} as const;
