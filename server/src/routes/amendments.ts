/**
 * Contract amendments and global cost parameters.
 *
 * RBAC: `amendment.*` for amendment versioning, `costparameter.*` for the
 * parameter table that seeds new rate cards.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  amendmentUpdateSchema,
  amendmentUpsertSchema,
  AMENDMENT_TYPE,
  CONTRACT_AMENDMENT_STATUS,
  costParameterUpsertSchema,
  COST_PARAMETER_CATEGORY,
  type PrismaAmendmentType,
  type PrismaContractAmendmentStatus,
  type PrismaCostParameterCategory,
} from '@openerp/shared';
import { prisma } from '../db/client.js';
import { HttpError } from '../auth/plugin.js';
import { loadAmendmentCostParameters } from '../pricing/service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

export async function registerAmendmentRoutes(app: FastifyInstance): Promise<void> {
  // --- Amendments --------------------------------------------------------
  app.get(
    '/api/amendments',
    { preHandler: [app.authenticate, app.requirePermission('amendment.read')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { contractId, status } = z
        .object({
          contractId: z.coerce.number().int().positive().optional(),
          status: z.string().trim().min(1).optional(),
        })
        .parse(request.query ?? {});

      const amendments = await prisma.contractAmendment.findMany({
        where: {
          ...(contractId !== undefined && { contractId }),
          ...(status !== undefined && {
            status: CONTRACT_AMENDMENT_STATUS.toKey(status) as PrismaContractAmendmentStatus,
          }),
        },
        orderBy: [{ contractId: 'asc' }, { effectiveDate: 'desc' }],
        include: {
          contract: { select: { id: true, number: true, client: { select: { name: true } } } },
          _count: { select: { serviceMasterRates: true, serviceCodes: true } },
        },
      });

      return {
        amendments: amendments.map((a) => ({
          ...a,
          effectiveDate: a.effectiveDate.toISOString().slice(0, 10),
          expiryDate: a.expiryDate?.toISOString().slice(0, 10) ?? null,
          signedDate: a.signedDate?.toISOString().slice(0, 10) ?? null,
          vatRate: a.vatRate.toNumber(),
        })),
      };
    },
  );

  app.post(
    '/api/amendments',
    { preHandler: [app.authenticate, app.requirePermission('amendment.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = amendmentUpsertSchema.parse(request.body);

      const contract = await prisma.contract.findUnique({
        where: { id: body.contractId },
        select: { id: true },
      });
      if (!contract) {
        throw new HttpError(
          400,
          'INVALID_REFERENCE',
          `Contract ${body.contractId} does not exist.`,
        );
      }

      const amendment = await prisma.contractAmendment.create({
        data: {
          contractId: body.contractId,
          amendmentNumber: body.amendmentNumber,
          amendmentType: AMENDMENT_TYPE.toKey(body.amendmentType) as PrismaAmendmentType,
          effectiveDate: new Date(body.effectiveDate),
          expiryDate: body.expiryDate ? new Date(body.expiryDate) : null,
          status: CONTRACT_AMENDMENT_STATUS.toKey(body.status) as PrismaContractAmendmentStatus,
          signedDate: body.signedDate ? new Date(body.signedDate) : null,
          notes: body.notes ?? null,
          vatRate: body.vatRate,
        },
      });

      return reply.code(201).send({
        amendment: { ...amendment, vatRate: amendment.vatRate.toNumber() },
      });
    },
  );

  app.patch(
    '/api/amendments/:id',
    { preHandler: [app.authenticate, app.requirePermission('amendment.write')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = amendmentUpdateSchema.parse(request.body);

      const existing = await prisma.contractAmendment.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Amendment ${id} does not exist.`);

      const amendment = await prisma.contractAmendment.update({
        where: { id },
        data: {
          ...(body.amendmentNumber !== undefined && { amendmentNumber: body.amendmentNumber }),
          ...(body.amendmentType !== undefined && {
            amendmentType: AMENDMENT_TYPE.toKey(body.amendmentType) as PrismaAmendmentType,
          }),
          ...(body.effectiveDate !== undefined && { effectiveDate: new Date(body.effectiveDate) }),
          ...(body.expiryDate !== undefined && {
            expiryDate: body.expiryDate ? new Date(body.expiryDate) : null,
          }),
          ...(body.status !== undefined && {
            status: CONTRACT_AMENDMENT_STATUS.toKey(body.status) as PrismaContractAmendmentStatus,
          }),
          ...(body.signedDate !== undefined && {
            signedDate: body.signedDate ? new Date(body.signedDate) : null,
          }),
          ...(body.notes !== undefined && { notes: body.notes }),
          ...(body.vatRate !== undefined && { vatRate: body.vatRate }),
        },
      });

      return { amendment: { ...amendment, vatRate: amendment.vatRate.toNumber() } };
    },
  );

  // --- Cost parameters ---------------------------------------------------
  app.get(
    '/api/amendments/:id/cost-parameters',
    { preHandler: [app.authenticate, app.requirePermission('costparameter.read')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);

      const amendment = await prisma.contractAmendment.findUnique({
        where: { id },
        select: { id: true, amendmentNumber: true, vatRate: true },
      });
      if (!amendment) throw new HttpError(404, 'NOT_FOUND', `Amendment ${id} does not exist.`);

      const parameters = await prisma.contractCostParameter.findMany({
        where: { amendmentId: id },
        orderBy: [{ category: 'asc' }, { parameterName: 'asc' }],
      });

      return {
        amendment: {
          id: amendment.id,
          amendmentNumber: amendment.amendmentNumber,
          vatRate: amendment.vatRate.toNumber(),
        },
        parameters: parameters.map((p) => ({ ...p, numericValue: p.numericValue.toNumber() })),
        // Convenience projection for the rate build-up sheet.
        engine: await loadAmendmentCostParameters(id),
      };
    },
  );

  app.put(
    '/api/amendments/:id/cost-parameters',
    { preHandler: [app.authenticate, app.requirePermission('costparameter.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ parameters: z.array(costParameterUpsertSchema) }).parse(request.body);

      const amendment = await prisma.contractAmendment.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!amendment) throw new HttpError(404, 'NOT_FOUND', `Amendment ${id} does not exist.`);

      // Upsert on the (amendment_id, parameter_name) unique constraint, and drop
      // any parameter the caller has removed from the set.
      const desiredNames = body.parameters.map((p) => p.parameterName);

      await prisma.$transaction(async (tx) => {
        for (const parameter of body.parameters) {
          const data = {
            amendmentId: id,
            category: COST_PARAMETER_CATEGORY.toKey(
              parameter.category,
            ) as PrismaCostParameterCategory,
            parameterName: parameter.parameterName,
            numericValue: parameter.numericValue,
            uom: parameter.uom,
            notes: parameter.notes ?? null,
          };
          await tx.contractCostParameter.upsert({
            where: {
              amendmentId_parameterName: {
                amendmentId: id,
                parameterName: parameter.parameterName,
              },
            },
            update: data,
            create: data,
          });
        }
        if (desiredNames.length > 0) {
          await tx.contractCostParameter.deleteMany({
            where: { amendmentId: id, parameterName: { notIn: desiredNames } },
          });
        }
      });

      const parameters = await prisma.contractCostParameter.findMany({
        where: { amendmentId: id },
        orderBy: [{ category: 'asc' }, { parameterName: 'asc' }],
      });

      return reply.code(200).send({
        parameters: parameters.map((p) => ({ ...p, numericValue: p.numericValue.toNumber() })),
        engine: await loadAmendmentCostParameters(id),
      });
    },
  );
}
