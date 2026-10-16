/**
 * Clients and contracts.
 *
 * RBAC: `contract.read` / `contract.write` / `contract.delete`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AMENDMENT_TYPE,
  CONTRACT_AMENDMENT_STATUS,
  clientUpdateSchema,
  clientUpsertSchema,
  contractUpsertSchema,
} from '@openerp/shared';
import { prisma } from '../db/client.js';
import { HttpError } from '../auth/plugin.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const contractIdParam = z.object({ id: z.coerce.number().int().positive() });

export async function registerClientRoutes(app: FastifyInstance): Promise<void> {
  // --- Clients -----------------------------------------------------------
  app.get(
    '/api/clients',
    { preHandler: [app.authenticate, app.requirePermission('contract.read')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { search, includeArchived } = z
        .object({
          search: z.string().trim().min(1).optional(),
          includeArchived: z
            .enum(['true', 'false'])
            .optional()
            .transform((v) => v === 'true'),
        })
        .parse(request.query ?? {});

      const clients = await prisma.client.findMany({
        where: {
          // Archived clients are hidden unless asked for. The default is what
          // matters: a register that quietly fills with retired rows stops being
          // readable, and every picker would offer dead clients.
          ...(includeArchived ? {} : { isArchived: false }),
          ...(search
            ? {
                OR: [
                  { name: { contains: search, mode: 'insensitive' } },
                  { email: { contains: search, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        orderBy: [{ isArchived: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          email: true,
          address: true,
          isVatRegistered: true,
          vatNumber: true,
          isArchived: true,
          _count: { select: { contracts: true } },
        },
      });
      return { clients };
    },
  );

  app.delete(
    '/api/clients/:id',
    { preHandler: [app.authenticate, app.requirePermission('contract.delete')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);

      const existing = await prisma.client.findUnique({
        where: { id },
        select: { id: true, _count: { select: { contracts: true, contacts: true } } },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Client ${id} does not exist.`);

      // Refuse rather than cascade, same rule as contracts: a client with
      // commercial history is the evidence for every invoice raised against it.
      if (existing._count.contracts > 0 || existing._count.contacts > 0) {
        throw new HttpError(
          409,
          'CONFLICT',
          `Client ${id} still has ${existing._count.contracts} contract(s) and ` +
            `${existing._count.contacts} contact(s). Delete those first, or leave the ` +
            `client in place as the historical record.`,
        );
      }

      await prisma.client.delete({ where: { id } });
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/clients/:id/archive',
    { preHandler: [app.authenticate, app.requirePermission('client.archive')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);

      const existing = await prisma.client.findUnique({
        where: { id },
        select: { id: true, isArchived: true, name: true },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Client ${id} does not exist.`);
      if (existing.isArchived) return reply.code(200).send({ archived: { id, isArchived: true } });

      // Archiving a client does NOT archive its contracts. A cascade here would be
      // invisible, one keystroke wide, and capable of retiring a contract that four
      // live jobs depend on. The warning belongs in the UI; the refusal belongs here.
      await prisma.client.update({ where: { id }, data: { isArchived: true } });
      return reply.code(200).send({ archived: { id, isArchived: true } });
    },
  );

  app.delete(
    '/api/clients/:id/archive',
    { preHandler: [app.authenticate, app.requirePermission('client.archive')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const existing = await prisma.client.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Client ${id} does not exist.`);
      await prisma.client.update({ where: { id }, data: { isArchived: false } });
      return reply.code(200).send({ archived: { id, isArchived: false } });
    },
  );

  app.post(
    '/api/clients',
    { preHandler: [app.authenticate, app.requirePermission('contract.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = clientUpsertSchema.parse(request.body);

      const client = await prisma.client.create({
        data: {
          name: body.name,
          email: body.email,
          address: body.address ?? null,
          isVatRegistered: body.isVatRegistered,
          vatNumber: body.vatNumber || null,
        },
      });

      return reply.code(201).send({ client });
    },
  );

  app.patch(
    '/api/clients/:id',
    { preHandler: [app.authenticate, app.requirePermission('contract.write')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      // `clientUpdateSchema`, not `clientUpsertSchema.partial()`: `.partial()`
      // still applies `isVatRegistered`'s default, silently re-registering a
      // VAT-exempt client on any edit that did not mention it. See the schema.
      const body = clientUpdateSchema.parse(request.body);

      const existing = await prisma.client.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Client ${id} does not exist.`);

      const client = await prisma.client.update({
        where: { id },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.email !== undefined && { email: body.email }),
          ...(body.address !== undefined && { address: body.address }),
          ...(body.isVatRegistered !== undefined && { isVatRegistered: body.isVatRegistered }),
          ...(body.vatNumber !== undefined && { vatNumber: body.vatNumber || null }),
        },
      });
      return { client };
    },
  );

  // --- Contracts ---------------------------------------------------------
  app.post(
    '/api/contracts/:id/archive',
    { preHandler: [app.authenticate, app.requirePermission('contract.archive')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const existing = await prisma.contract.findUnique({
        where: { id },
        select: {
          id: true,
          isArchived: true,
          number: true,
          projects: {
            select: {
              jobs: { select: { id: true, status: true } },
            },
          },
        },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Contract ${id} does not exist.`);
      if (existing.isArchived) return reply.code(200).send({ archived: { id, isArchived: true } });

      // The one place where the engine, not the interface, has to be the judge.
      // A contract whose work is still running cannot be archived: the jobs are
      // priced against it and its amendments are their legal basis. Once every job
      // is Cancelled or Invoiced, archiving is safe and reversible.
      const live = existing.projects.flatMap((p) =>
        p.jobs.filter(
          (j) =>
            !String(j.status).startsWith('CANCELLED') &&
            !String(j.status).startsWith('INVOICED') &&
            !String(j.status).startsWith('PARTIALLY'),
        ),
      );
      if (live.length > 0) {
        throw new HttpError(
          409,
          'CONFLICT',
          `Contract ${existing.number} still has ${live.length} job(s) that are not cancelled or ` +
            `invoiced. Finish or cancel them before archiving the contract.`,
        );
      }

      await prisma.contract.update({ where: { id }, data: { isArchived: true } });
      return reply.code(200).send({ archived: { id, isArchived: true } });
    },
  );

  app.delete(
    '/api/contracts/:id/archive',
    { preHandler: [app.authenticate, app.requirePermission('contract.archive')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const existing = await prisma.contract.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Contract ${id} does not exist.`);
      await prisma.contract.update({ where: { id }, data: { isArchived: false } });
      return reply.code(200).send({ archived: { id, isArchived: false } });
    },
  );

  app.get(
    '/api/contracts',
    { preHandler: [app.authenticate, app.requirePermission('contract.read')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { search, status, includeArchived } = z
        .object({
          search: z.string().trim().min(1).optional(),
          status: z.string().trim().min(1).optional(),
          includeArchived: z
            .enum(['true', 'false'])
            .optional()
            .transform((v) => v === 'true'),
        })
        .parse(request.query ?? {});

      const contracts = await prisma.contract.findMany({
        where: {
          ...(includeArchived ? {} : { isArchived: false }),
          ...(search
            ? {
                OR: [
                  { number: { contains: search, mode: 'insensitive' as const } },
                  { description: { contains: search, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        orderBy: { number: 'asc' },
        select: {
          id: true,
          // Echoed alongside the nested `client` so the edit form can preselect
          // the current client without inferring it from the sub-object.
          clientId: true,
          isArchived: true,
          number: true,
          description: true,
          type: true,
          client: { select: { id: true, name: true, isVatRegistered: true, vatNumber: true } },
          amendments: {
            select: {
              id: true,
              amendmentNumber: true,
              amendmentType: true,
              status: true,
              effectiveDate: true,
              expiryDate: true,
              vatRate: true,
            },
            orderBy: { effectiveDate: 'desc' },
          },
          _count: { select: { projects: true } },
        },
      });

      const filtered =
        status === undefined
          ? contracts
          : contracts.filter((c) =>
              c.amendments.some((a) => CONTRACT_AMENDMENT_STATUS.toLabel(a.status) === status),
            );

      return {
        contracts: filtered.map((c) => ({
          ...c,
          // Serialise the amendment VAT rate from Decimal to number.
          amendments: c.amendments.map((a) => ({
            ...a,
            amendmentType: AMENDMENT_TYPE.toLabel(a.amendmentType),
            status: CONTRACT_AMENDMENT_STATUS.toLabel(a.status),
            effectiveDate: a.effectiveDate.toISOString().slice(0, 10),
            expiryDate: a.expiryDate?.toISOString().slice(0, 10) ?? null,
            vatRate: a.vatRate.toNumber(),
          })),
        })),
      };
    },
  );

  app.get(
    '/api/contracts/:id',
    { preHandler: [app.authenticate, app.requirePermission('contract.read')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = contractIdParam.parse(request.params);

      const contract = await prisma.contract.findUnique({
        where: { id },
        include: {
          client: true,
          amendments: {
            orderBy: { effectiveDate: 'desc' },
            include: {
              costParameters: { orderBy: [{ category: 'asc' }, { parameterName: 'asc' }] },
              _count: { select: { serviceMasterRates: true, serviceCodes: true } },
            },
          },
          projects: { select: { id: true, code: true, description: true, year: true } },
        },
      });

      if (!contract) throw new HttpError(404, 'NOT_FOUND', `Contract ${id} does not exist.`);

      return {
        contract: {
          ...contract,
          amendments: contract.amendments.map((a) => ({
            ...a,
            amendmentType: AMENDMENT_TYPE.toLabel(a.amendmentType),
            status: CONTRACT_AMENDMENT_STATUS.toLabel(a.status),
            effectiveDate: a.effectiveDate.toISOString().slice(0, 10),
            expiryDate: a.expiryDate?.toISOString().slice(0, 10) ?? null,
            signedDate: a.signedDate?.toISOString().slice(0, 10) ?? null,
            vatRate: a.vatRate.toNumber(),
            costParameters: a.costParameters.map((p) => ({
              ...p,
              numericValue: p.numericValue.toNumber(),
            })),
          })),
        },
      };
    },
  );

  app.post(
    '/api/contracts',
    { preHandler: [app.authenticate, app.requirePermission('contract.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = contractUpsertSchema.parse(request.body);

      const client = await prisma.client.findUnique({
        where: { id: body.clientId },
        select: { id: true },
      });
      if (!client) {
        throw new HttpError(400, 'INVALID_REFERENCE', `Client ${body.clientId} does not exist.`);
      }

      const contract = await prisma.contract.create({
        data: {
          clientId: body.clientId,
          number: body.number,
          description: body.description,
          type: body.type ?? null,
        },
      });

      return reply.code(201).send({ contract });
    },
  );

  app.patch(
    '/api/contracts/:id',
    { preHandler: [app.authenticate, app.requirePermission('contract.write')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = contractIdParam.parse(request.params);
      const body = contractUpsertSchema.partial().parse(request.body);

      const existing = await prisma.contract.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Contract ${id} does not exist.`);

      const contract = await prisma.contract.update({
        where: { id },
        data: {
          ...(body.clientId !== undefined && { clientId: body.clientId }),
          ...(body.number !== undefined && { number: body.number }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.type !== undefined && { type: body.type }),
        },
      });
      return { contract };
    },
  );

  app.delete(
    '/api/contracts/:id',
    { preHandler: [app.authenticate, app.requirePermission('contract.delete')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = contractIdParam.parse(request.params);

      const existing = await prisma.contract.findUnique({
        where: { id },
        select: { id: true, _count: { select: { amendments: true, projects: true } } },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Contract ${id} does not exist.`);

      // Refuse rather than cascade: deleting commercial history silently is
      // unrecoverable.
      if (existing._count.amendments > 0 || existing._count.projects > 0) {
        throw new HttpError(
          409,
          'CONFLICT',
          `Contract ${id} still has ${existing._count.amendments} amendment(s) and ` +
            `${existing._count.projects} project(s). Terminate or supersede it instead of deleting.`,
        );
      }

      await prisma.contract.delete({ where: { id } });
      return reply.code(204).send();
    },
  );
}
