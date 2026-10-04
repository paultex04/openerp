/**
 * Clients and contracts.
 *
 * RBAC: `contract.read` / `contract.write` / `contract.delete`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { clientUpsertSchema, contractUpsertSchema } from '@openerp/shared';
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
      const { search } = z
        .object({ search: z.string().trim().min(1).optional() })
        .parse(request.query ?? {});

      const clients = await prisma.client.findMany({
        where: search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            }
          : undefined,
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          email: true,
          address: true,
          isVatRegistered: true,
          vatNumber: true,
          _count: { select: { contracts: true } },
        },
      });
      return { clients };
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
      const body = clientUpsertSchema.partial().parse(request.body);

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
  app.get(
    '/api/contracts',
    { preHandler: [app.authenticate, app.requirePermission('contract.read')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { search, status } = z
        .object({
          search: z.string().trim().min(1).optional(),
          status: z.string().trim().min(1).optional(),
        })
        .parse(request.query ?? {});

      const contracts = await prisma.contract.findMany({
        where: {
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
          number: true,
          description: true,
          type: true,
          client: { select: { id: true, name: true, isVatRegistered: true, vatNumber: true } },
          amendments: {
            select: {
              id: true,
              amendmentNumber: true,
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
          : contracts.filter((c) => c.amendments.some((a) => a.status === status));

      return {
        contracts: filtered.map((c) => ({
          ...c,
          // Serialise the amendment VAT rate from Decimal to number.
          amendments: c.amendments.map((a) => ({
            ...a,
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
