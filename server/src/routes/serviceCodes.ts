/**
 * Tier 2 service codes, labour recipes and R1 material BOMs.
 *
 * RBAC:
 *   servicecode.read     — list / read
 *   servicecode.write    — create, edit, delete
 *   recipe.labour.write  — attach trade roles, crew size, hours per unit
 *   recipe.material.write— build and edit procurement BOM lines
 *
 * Per ADR-001 Q2, recipe mutations recompute the parent and return the variance
 * against the stored rate instead of silently overwriting it. `?applyRate=true`
 * is required to accept a recomputed rollup.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  labourItemUpdateSchema,
  labourItemUpsertSchema,
  materialItemUpdateSchema,
  materialItemUpsertSchema,
  serviceCodeCategoryToKey,
  serviceCodeCategoryToLabel,
  serviceCodeUpdateSchema,
  serviceCodeUpsertSchema,
  type PrismaServiceCodeCategory,
} from '@openerp/shared';
import { prisma } from '../db/client.js';
import { HttpError } from '../auth/plugin.js';
import { applyServiceCodeRate, refreshServiceCodeLines } from '../pricing/service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const boolQuery = z.object({ applyRate: z.coerce.boolean().optional() });

function serialise<T extends Record<string, unknown>>(row: T) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && typeof value === 'object' && 'toNumber' in value) {
      out[key] = (value as { toNumber(): number }).toNumber();
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Recipe mutations always recompute; this returns the result plus variance. */
async function recomputeAndReport(
  serviceCodeId: number,
  applyRate: boolean,
  refreshLines: boolean,
): Promise<Record<string, unknown>> {
  if (refreshLines) await refreshServiceCodeLines(serviceCodeId);
  const computation = await applyServiceCodeRate(serviceCodeId, { accept: applyRate });
  return { computation };
}

export async function registerServiceCodeRoutes(app: FastifyInstance): Promise<void> {
  // --- Service code master ----------------------------------------------
  app.get(
    '/api/service-codes',
    { preHandler: [app.authenticate, app.requirePermission('servicecode.read')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { amendmentId, category, search } = z
        .object({
          amendmentId: z.coerce.number().int().positive().optional(),
          category: z.string().trim().min(1).optional(),
          search: z.string().trim().min(1).optional(),
        })
        .parse(request.query ?? {});

      const codes = await prisma.serviceCode.findMany({
        where: {
          ...(amendmentId !== undefined && { amendmentId }),
          ...(category !== undefined && {
            category: serviceCodeCategoryToKey(category) as PrismaServiceCodeCategory,
          }),
          ...(search
            ? {
                OR: [
                  { code: { contains: search, mode: 'insensitive' as const } },
                  { description: { contains: search, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        orderBy: { code: 'asc' },
        include: {
          _count: { select: { labourItems: true, materialItems: true } },
        },
      });

      // Return the business label, never the Prisma enum key.
      return {
        serviceCodes: codes.map((c) => ({
          ...serialise({ ...c, createdAt: undefined }),
          category: serviceCodeCategoryToLabel(c.category),
        })),
      };
    },
  );

  app.get(
    '/api/service-codes/:id',
    { preHandler: [app.authenticate, app.requirePermission('servicecode.read')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);

      const code = await prisma.serviceCode.findUnique({
        where: { id },
        include: {
          labourItems: {
            include: {
              serviceMasterRate: {
                select: {
                  id: true,
                  serviceMasterCode: true,
                  labourType: true,
                  fullLoadedRate: true,
                },
              },
            },
            orderBy: { id: 'asc' },
          },
          materialItems: { orderBy: { id: 'asc' } },
          amendment: { select: { id: true, amendmentNumber: true, vatRate: true } },
        },
      });

      if (!code) throw new HttpError(404, 'NOT_FOUND', `Service code ${id} does not exist.`);

      // Always surface the current computation, so the UI can flag a stale rate.
      const computation = await applyServiceCodeRate(id, { accept: false });

      return {
        serviceCode: {
          ...serialise({ ...code, createdAt: undefined }),
          category: serviceCodeCategoryToLabel(code.category),
          amendment: { ...code.amendment, vatRate: code.amendment.vatRate.toNumber() },
          labourItems: code.labourItems.map((l) => serialise(l)),
          materialItems: code.materialItems.map((m) => serialise(m)),
        },
        computation,
      };
    },
  );

  app.post(
    '/api/service-codes',
    { preHandler: [app.authenticate, app.requirePermission('servicecode.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = serviceCodeUpsertSchema.parse(request.body);

      const amendment = await prisma.contractAmendment.findUnique({
        where: { id: body.amendmentId },
        select: { id: true },
      });
      if (!amendment) {
        throw new HttpError(
          400,
          'INVALID_REFERENCE',
          `Amendment ${body.amendmentId} does not exist.`,
        );
      }

      const code = await prisma.serviceCode.create({
        data: {
          amendmentId: body.amendmentId,
          code: body.code,
          description: body.description,
          category: serviceCodeCategoryToKey(body.category),
          uom: body.uom,
          materialMarkupPct: body.materialMarkupPct,
          calculatedUnitRate: 0,
        },
      });

      return reply.code(201).send({
        serviceCode: {
          ...serialise({ ...code, createdAt: undefined }),
          category: serviceCodeCategoryToLabel(code.category),
        },
      });
    },
  );

  app.patch(
    '/api/service-codes/:id',
    { preHandler: [app.authenticate, app.requirePermission('servicecode.write')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = serviceCodeUpdateSchema.parse(request.body);

      const existing = await prisma.serviceCode.findUnique({
        where: { id },
        select: { id: true, category: true },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Service code ${id} does not exist.`);

      const code = await prisma.serviceCode.update({
        where: { id },
        data: {
          ...(body.code !== undefined && { code: body.code }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.category !== undefined && {
            category: serviceCodeCategoryToKey(body.category),
          }),
          ...(body.uom !== undefined && { uom: body.uom }),
          ...(body.materialMarkupPct !== undefined && {
            materialMarkupPct: body.materialMarkupPct,
          }),
        },
      });

      // A category or markup change alters the rollup.
      const computation =
        body.category !== undefined || body.materialMarkupPct !== undefined
          ? await applyServiceCodeRate(id, { accept: false })
          : null;

      return {
        serviceCode: {
          ...serialise({ ...code, createdAt: undefined }),
          category: serviceCodeCategoryToLabel(code.category),
        },
        computation,
      };
    },
  );

  app.delete(
    '/api/service-codes/:id',
    { preHandler: [app.authenticate, app.requirePermission('servicecode.delete')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);

      const existing = await prisma.serviceCode.findUnique({
        where: { id },
        select: { id: true, _count: { select: { jobServiceCodes: true, invoiceItems: true } } },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Service code ${id} does not exist.`);

      if (existing._count.jobServiceCodes > 0 || existing._count.invoiceItems > 0) {
        throw new HttpError(
          409,
          'CONFLICT',
          `Service code ${id} is referenced by ${existing._count.jobServiceCodes} job deliverable(s) ` +
            `and ${existing._count.invoiceItems} invoice line(s) and cannot be deleted.`,
        );
      }

      await prisma.serviceCode.delete({ where: { id } });
      return reply.code(204).send();
    },
  );

  /** Explicitly accept a recomputed rollup (ADR-001 Q2 contract). */
  app.post(
    '/api/service-codes/:id/apply-rate',
    { preHandler: [app.authenticate, app.requirePermission('servicecode.write')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const computation = await applyServiceCodeRate(id, { accept: true });
      if (!computation) throw new HttpError(404, 'NOT_FOUND', `Service code ${id} does not exist.`);
      return { computation };
    },
  );

  // --- Labour recipes ----------------------------------------------------
  app.post(
    '/api/service-code-labour-items',
    { preHandler: [app.authenticate, app.requirePermission('recipe.labour.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = labourItemUpsertSchema.parse(request.body);

      const [code, rate] = await Promise.all([
        prisma.serviceCode.findUnique({
          where: { id: body.serviceCodeId },
          select: { id: true, category: true },
        }),
        prisma.serviceMasterRate.findUnique({
          where: { id: body.serviceMasterRateId },
          select: { id: true, amendmentId: true, fullLoadedRate: true },
        }),
      ]);

      if (!code) {
        throw new HttpError(
          400,
          'INVALID_REFERENCE',
          `Service code ${body.serviceCodeId} does not exist.`,
        );
      }
      if (!rate) {
        throw new HttpError(
          400,
          'INVALID_REFERENCE',
          `Rate card ${body.serviceMasterRateId} does not exist.`,
        );
      }
      if (code.category !== 'ACTIVITY') {
        throw new HttpError(
          422,
          'CATEGORY_MISMATCH',
          `Service code ${body.serviceCodeId} is an R1 Material code and cannot hold labour lines.`,
        );
      }

      const amendment = await prisma.serviceCode.findUniqueOrThrow({
        where: { id: code.id },
        select: { amendmentId: true },
      });
      if (rate.amendmentId !== amendment.amendmentId) {
        throw new HttpError(
          422,
          'AMENDMENT_MISMATCH',
          `Rate card ${rate.id} belongs to amendment ${rate.amendmentId}, but service code ` +
            `${code.id} belongs to amendment ${amendment.amendmentId}. Recipes may only mix rates ` +
            'from the same amendment.',
        );
      }

      const item = await prisma.serviceCodeLabourItem.create({
        data: {
          serviceCodeId: body.serviceCodeId,
          serviceMasterRateId: body.serviceMasterRateId,
          crewQuantity: body.crewQuantity,
          hoursPerUnit: body.hoursPerUnit,
          // Provisional; recomputed immediately below from the authoritative rate.
          lineSubtotal: 0,
        },
      });

      return reply.code(201).send({
        item: serialise(item),
        ...(await recomputeAndReport(body.serviceCodeId, false, true)),
      });
    },
  );

  app.patch(
    '/api/service-code-labour-items/:id',
    { preHandler: [app.authenticate, app.requirePermission('recipe.labour.write')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = labourItemUpdateSchema.parse(request.body);

      const existing = await prisma.serviceCodeLabourItem.findUnique({
        where: { id },
        select: { id: true, serviceCodeId: true },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Recipe line ${id} does not exist.`);

      const item = await prisma.serviceCodeLabourItem.update({
        where: { id },
        data: {
          ...(body.crewQuantity !== undefined && { crewQuantity: body.crewQuantity }),
          ...(body.hoursPerUnit !== undefined && { hoursPerUnit: body.hoursPerUnit }),
        },
      });

      return {
        item: serialise(item),
        ...(await recomputeAndReport(existing.serviceCodeId, false, true)),
      };
    },
  );

  app.delete(
    '/api/service-code-labour-items/:id',
    { preHandler: [app.authenticate, app.requirePermission('recipe.labour.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);

      const existing = await prisma.serviceCodeLabourItem.findUnique({
        where: { id },
        select: { id: true, serviceCodeId: true },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Recipe line ${id} does not exist.`);

      await prisma.serviceCodeLabourItem.delete({ where: { id } });
      const report = await recomputeAndReport(existing.serviceCodeId, false, true);
      return reply.code(200).send(report);
    },
  );

  // --- Material BOMs -----------------------------------------------------
  app.post(
    '/api/service-code-material-items',
    { preHandler: [app.authenticate, app.requirePermission('recipe.material.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = materialItemUpsertSchema.parse(request.body);

      const code = await prisma.serviceCode.findUnique({
        where: { id: body.serviceCodeId },
        select: { id: true, category: true },
      });
      if (!code) {
        throw new HttpError(
          400,
          'INVALID_REFERENCE',
          `Service code ${body.serviceCodeId} does not exist.`,
        );
      }
      if (code.category !== 'R1_MATERIAL') {
        throw new HttpError(
          422,
          'CATEGORY_MISMATCH',
          `Service code ${body.serviceCodeId} is an Activity code and cannot hold R1 material lines.`,
        );
      }

      const item = await prisma.serviceCodeMaterialItem.create({
        data: {
          serviceCodeId: body.serviceCodeId,
          itemCode: body.itemCode ?? null,
          description: body.description,
          supplierName: body.supplierName ?? null,
          unitCost: body.unitCost,
          quantity: body.quantity,
          uom: body.uom,
          subtotalCost: 0,
        },
      });

      return reply.code(201).send({
        item: serialise(item),
        ...(await recomputeAndReport(body.serviceCodeId, false, true)),
      });
    },
  );

  app.patch(
    '/api/service-code-material-items/:id',
    { preHandler: [app.authenticate, app.requirePermission('recipe.material.write')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = materialItemUpdateSchema.parse(request.body);

      const existing = await prisma.serviceCodeMaterialItem.findUnique({
        where: { id },
        select: { id: true, serviceCodeId: true },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Material line ${id} does not exist.`);

      const item = await prisma.serviceCodeMaterialItem.update({
        where: { id },
        data: {
          ...(body.itemCode !== undefined && { itemCode: body.itemCode }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.supplierName !== undefined && { supplierName: body.supplierName }),
          ...(body.unitCost !== undefined && { unitCost: body.unitCost }),
          ...(body.quantity !== undefined && { quantity: body.quantity }),
          ...(body.uom !== undefined && { uom: body.uom }),
        },
      });

      return {
        item: serialise(item),
        ...(await recomputeAndReport(existing.serviceCodeId, false, true)),
      };
    },
  );

  app.delete(
    '/api/service-code-material-items/:id',
    { preHandler: [app.authenticate, app.requirePermission('recipe.material.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);

      const existing = await prisma.serviceCodeMaterialItem.findUnique({
        where: { id },
        select: { id: true, serviceCodeId: true },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Material line ${id} does not exist.`);

      await prisma.serviceCodeMaterialItem.delete({ where: { id } });
      const report = await recomputeAndReport(existing.serviceCodeId, false, true);
      return reply.code(200).send(report);
    },
  );

  /** Preview endpoint for the recipe builder; never writes. */
  app.get(
    '/api/service-codes/:id/computation',
    { preHandler: [app.authenticate, app.requirePermission('servicecode.read')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const { applyRate } = boolQuery.parse(request.query ?? {});

      const computation = await applyServiceCodeRate(id, { accept: applyRate === true });
      if (!computation) throw new HttpError(404, 'NOT_FOUND', `Service code ${id} does not exist.`);
      return { computation };
    },
  );
}
