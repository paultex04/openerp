/**
 * Tier 1 labour master rates.
 *
 * RBAC: `ratemaster.read` for reads, `ratemaster.write` for every mutation
 * including the build-up preview. Non-commercial roles are refused outright.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { serviceMasterRateUpsertSchema } from '@openerp/shared';
import { prisma } from '../db/client.js';
import { HttpError } from '../auth/plugin.js';
import {
  computeRateCard,
  previewRateCard,
  PricingConfigurationError,
  saveRateCard,
} from '../pricing/service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Serialises a rate card row, converting Decimals and dates. */
function serialise<T extends Record<string, unknown>>(row: T) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      out[key] = value.toISOString().slice(0, 10);
    } else if (value !== null && typeof value === 'object' && 'toNumber' in value) {
      out[key] = (value as { toNumber(): number }).toNumber();
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function registerRateMasterRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/service-master-rates',
    { preHandler: [app.authenticate, app.requirePermission('ratemaster.read')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { amendmentId, search } = z
        .object({
          amendmentId: z.coerce.number().int().positive().optional(),
          search: z.string().trim().min(1).optional(),
        })
        .parse(request.query ?? {});

      const rates = await prisma.serviceMasterRate.findMany({
        where: {
          ...(amendmentId !== undefined && { amendmentId }),
          ...(search
            ? {
                OR: [
                  { labourType: { contains: search, mode: 'insensitive' as const } },
                  { serviceMasterCode: { contains: search, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        orderBy: [{ labourType: 'asc' }, { shiftType: 'asc' }],
        select: {
          id: true,
          amendmentId: true,
          serviceMasterCode: true,
          labourType: true,
          shiftType: true,
          uom: true,
          bargainingCouncilDesc: true,
          councilRate: true,
          customRate: true,
          wagePremiumPct: true,
          manInPocket: true,
          leavePay: true,
          totalStatutoryCost: true,
          ppeCost: true,
          transportCost: true,
          equipmentCost: true,
          overheadCost: true,
          sgaCost: true,
          profitCost: true,
          fullLoadedRate: true,
          _count: { select: { labourItems: true } },
        },
      });

      return { rates: rates.map(serialise) };
    },
  );

  /**
   * Recomputes a stored rate card without writing, so the UI can show whether the
   * persisted build-up still agrees with the engine.
   */
  app.get(
    '/api/service-master-rates/:id/compute',
    { preHandler: [app.authenticate, app.requirePermission('ratemaster.read')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);

      const card = await prisma.serviceMasterRate.findUnique({
        where: { id },
        select: {
          id: true,
          fullLoadedRate: true,
          overheadCost: true,
          sgaCost: true,
          amendmentId: true,
        },
      });
      if (!card) throw new HttpError(404, 'NOT_FOUND', `Rate card ${id} does not exist.`);

      try {
        const computed = await computeRateCard(id);
        return {
          computed,
          stored: {
            fullLoadedRate: card.fullLoadedRate.toNumber(),
            overheadCost: card.overheadCost.toNumber(),
            sgaCost: card.sgaCost.toNumber(),
          },
          agrees: Math.abs(computed.fullLoadedRate - card.fullLoadedRate.toNumber()) < 0.005,
        };
      } catch (e) {
        if (e instanceof PricingConfigurationError) {
          throw new HttpError(422, 'PRICING_NOT_CONFIGURED', e.message);
        }
        throw e;
      }
    },
  );

  /** Dry-run build-up for the interactive sheet. */
  app.post(
    '/api/service-master-rates/preview',
    { preHandler: [app.authenticate, app.requirePermission('ratemaster.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = serviceMasterRateUpsertSchema.parse(request.body);
      try {
        return reply.code(200).send(await previewRateCard({ ...body, id: undefined }));
      } catch (e) {
        if (e instanceof PricingConfigurationError) {
          throw new HttpError(422, 'PRICING_NOT_CONFIGURED', e.message);
        }
        throw e;
      }
    },
  );

  app.post(
    '/api/service-master-rates',
    { preHandler: [app.authenticate, app.requireAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = serviceMasterRateUpsertSchema.parse(request.body);

      try {
        const result = await saveRateCard({ ...body, id: undefined });
        const created = await prisma.serviceMasterRate.findUniqueOrThrow({
          where: { id: result.id },
        });
        return reply.code(201).send({ rate: serialise(created), ...result });
      } catch (e) {
        if (e instanceof PricingConfigurationError) {
          throw new HttpError(422, 'PRICING_NOT_CONFIGURED', e.message);
        }
        throw e;
      }
    },
  );

  app.put(
    '/api/service-master-rates/:id',
    { preHandler: [app.authenticate, app.requirePermission('ratemaster.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = serviceMasterRateUpsertSchema.parse(request.body);

      const existing = await prisma.serviceMasterRate.findUnique({
        where: { id },
        select: { id: true, amendmentId: true },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Rate card ${id} does not exist.`);

      if (existing.amendmentId !== body.amendmentId) {
        throw new HttpError(
          400,
          'AMENDMENT_IMMUTABLE',
          'A rate card cannot be moved between amendments. Create a new rate card on the target amendment.',
        );
      }

      try {
        const result = await saveRateCard({ ...body, id });
        const updated = await prisma.serviceMasterRate.findUniqueOrThrow({ where: { id } });
        return reply.code(200).send({ rate: serialise(updated), ...result });
      } catch (e) {
        if (e instanceof PricingConfigurationError) {
          throw new HttpError(422, 'PRICING_NOT_CONFIGURED', e.message);
        }
        throw e;
      }
    },
  );

  app.delete(
    '/api/service-master-rates/:id',
    { preHandler: [app.authenticate, app.requirePermission('ratemaster.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);

      const existing = await prisma.serviceMasterRate.findUnique({
        where: { id },
        select: { id: true, _count: { select: { labourItems: true } } },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Rate card ${id} does not exist.`);

      if (existing._count.labourItems > 0) {
        throw new HttpError(
          409,
          'CONFLICT',
          `Rate card ${id} is referenced by ${existing._count.labourItems} recipe line(s). ` +
            'Remove those lines first so historical service codes keep their labour basis.',
        );
      }

      await prisma.serviceMasterRate.delete({ where: { id } });
      return reply.code(204).send();
    },
  );
}
