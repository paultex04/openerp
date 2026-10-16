/**
 * Request/response schemas for the commercial surface (Phase 2).
 *
 * These are shared so the client forms and the server validation cannot drift.
 * Percentages are always **fractions** (0.07 = 7%) — see shared/src/money.ts.
 */
import { z } from 'zod';
import {
  amendmentTypeSchema,
  contractAmendmentStatusSchema,
  costParameterCategorySchema,
  serviceCodeCategorySchema,
  shiftTypeSchema,
} from './enums';

/** A monetary amount. Two decimal places, non-negative. */
export const moneySchema = z.coerce.number().min(0, 'Amount cannot be negative.').multipleOf(0.01, {
  message: 'Amount has more than 2 decimal places.',
});

/** A unit rate. Four decimal places — `S00247970` prices at 17.5226 ZAR/m. */
export const rateSchema = z.coerce.number().min(0).multipleOf(0.0001, {
  message: 'Rate has more than 4 decimal places.',
});

/** A percentage expressed as a fraction: 0.07 = 7%. */
export const pctSchema = z.coerce
  .number()
  .min(0)
  .max(1, 'Use a fraction between 0 and 1 (0.07 = 7%).');

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD).')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Not a valid calendar date.');

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export const clientUpsertSchema = z.object({
  name: z.string().trim().min(1).max(150),
  email: z.string().trim().toLowerCase().email(),
  address: z.string().trim().min(1).optional().nullable(),
  isVatRegistered: z.coerce.boolean().default(true),
  vatNumber: z
    .string()
    .trim()
    .transform((v) => v.replace(/\s/g, ''))
    .refine((v) => v === '' || /^\d{10}$/.test(v), 'A South African VAT number is 10 digits.')
    .optional()
    .nullable(),
});
export type ClientUpsertInput = z.infer<typeof clientUpsertSchema>;

/**
 * Partial update.
 *
 * `.partial()` is not enough on its own: zod still applies a field's
 * `.default()` through `.partial()` (verified on zod 4.6.7), so a PATCH that
 * omitted `isVatRegistered` parsed to `true` and silently re-registered a
 * VAT-exempt client. `isVatRegistered` is re-declared without its default;
 * everything else was already presence-based.
 */
export const clientUpdateSchema = clientUpsertSchema.partial().extend({
  isVatRegistered: z.coerce.boolean().optional(),
});
export type ClientUpdateInput = z.infer<typeof clientUpdateSchema>;

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export const contractUpsertSchema = z.object({
  clientId: z.coerce.number().int().positive(),
  number: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1),
  type: z.string().trim().max(100).optional().nullable(),
});
export type ContractUpsertInput = z.infer<typeof contractUpsertSchema>;

// ---------------------------------------------------------------------------
// Amendments
// ---------------------------------------------------------------------------

export const amendmentUpsertSchema = z.object({
  contractId: z.coerce.number().int().positive(),
  amendmentNumber: z.string().trim().min(1).max(50),
  amendmentType: amendmentTypeSchema.default('Annual Escalation'),
  effectiveDate: isoDate,
  expiryDate: isoDate.optional().nullable(),
  status: contractAmendmentStatusSchema.default('Active'),
  signedDate: isoDate.optional().nullable(),
  notes: z.string().trim().optional().nullable(),
  /** Default VAT fraction applied to invoices raised under this amendment. */
  vatRate: pctSchema.default(0.15),
});
export type AmendmentUpsertInput = z.infer<typeof amendmentUpsertSchema>;

/**
 * Partial update.
 *
 * `.partial()` alone is not enough here: zod still applies a field's
 * `.default()` through `.partial()` (verified on zod 4.6.7), so an edit that
 * omitted `amendmentType`, `status` or `vatRate` silently wrote the
 * create-time defaults back over stored values — a custom VAT rate of 0 was
 * reset to 0.15 by any unrelated amendment edit. The three defaulted fields
 * are re-declared without defaults; the rest were already presence-based.
 */
export const amendmentUpdateSchema = amendmentUpsertSchema
  .partial()
  .omit({ contractId: true })
  .extend({
    amendmentType: amendmentTypeSchema.optional(),
    status: contractAmendmentStatusSchema.optional(),
    vatRate: pctSchema.optional(),
  });
export type AmendmentUpdateInput = z.infer<typeof amendmentUpdateSchema>;

// ---------------------------------------------------------------------------
// Cost parameters
// ---------------------------------------------------------------------------

export const costParameterUpsertSchema = z.object({
  amendmentId: z.coerce.number().int().positive(),
  category: costParameterCategorySchema,
  parameterName: z.string().trim().min(1).max(100),
  numericValue: z.coerce.number().finite(),
  uom: z.string().trim().min(1).max(50),
  notes: z.string().trim().optional().nullable(),
});
export type CostParameterUpsertInput = z.infer<typeof costParameterUpsertSchema>;

// ---------------------------------------------------------------------------
// Tier 1 service master rates
// ---------------------------------------------------------------------------

/**
 * Tier 1 rate card.
 *
 * `councilRate` and `customRate` are mutually optional but at least one is
 * required; the refinement mirrors `resolveBaseRate` so the client can show the
 * error inline before submitting.
 */
export const serviceMasterRateUpsertSchema = z
  .object({
    amendmentId: z.coerce.number().int().positive(),
    serviceMasterCode: z.string().trim().min(1).max(20),
    labourType: z.string().trim().min(1).max(100),
    shiftType: shiftTypeSchema.default('NT'),
    uom: z.string().trim().max(30).default('per Hour'),
    bargainingCouncilDesc: z.string().trim().max(150).optional().nullable(),

    councilRate: moneySchema.optional().nullable(),
    customRate: moneySchema.optional().nullable(),
    wagePremiumPct: pctSchema.default(0),

    leavePay: moneySchema.default(0),
    totalStatutoryCost: moneySchema.default(0),
    ppeCost: moneySchema.default(0),
    transportCost: moneySchema.default(0),
    equipmentCost: moneySchema.default(0),

    /**
     * Overheads are authoritative stored inputs (ADR-001 Q1). The optional
     * `overheadPct` / `sgaPct` are only used to *seed* a brand new card from the
     * amendment's parameters.
     */
    overheadCost: moneySchema.optional().nullable(),
    sgaCost: moneySchema.optional().nullable(),
    overheadPct: pctSchema.optional(),
    sgaPct: pctSchema.optional(),
    profitPct: pctSchema.default(0),

    /**
     * When true the server re-derives overhead and SG&A from `overheadPct` /
     * `sgaPct` instead of using the supplied amounts. Guarded by
     * `ratemaster.write` and audited in Phase 5.
     */
    deriveOverheads: z.coerce.boolean().default(false),
  })
  .refine(
    (v) =>
      (v.councilRate !== null && v.councilRate !== undefined) ||
      (v.customRate !== null && v.customRate !== undefined),
    { message: 'Provide either a council rate or a custom rate.', path: ['councilRate'] },
  );
export type ServiceMasterRateUpsertInput = z.infer<typeof serviceMasterRateUpsertSchema>;

// ---------------------------------------------------------------------------
// Tier 2 service codes and recipes
// ---------------------------------------------------------------------------

export const serviceCodeUpsertSchema = z.object({
  amendmentId: z.coerce.number().int().positive(),
  code: z.string().trim().min(1).max(50),
  description: z.string().trim().min(1),
  category: serviceCodeCategorySchema.default('Activity'),
  uom: z.string().trim().min(1).max(20),
  materialMarkupPct: pctSchema.default(0),
});
export type ServiceCodeUpsertInput = z.infer<typeof serviceCodeUpsertSchema>;

/**
 * Partial update. Same `.partial()` + `.default()` correction as the amendment
 * schema above: without it, every service-code edit re-wrote `category` and
 * `materialMarkupPct` to their create-time defaults (and, as a side effect,
 * re-ran the recipe rollup on edits that touched neither).
 */
export const serviceCodeUpdateSchema = serviceCodeUpsertSchema
  .partial()
  .omit({ amendmentId: true })
  .extend({
    category: serviceCodeCategorySchema.optional(),
    materialMarkupPct: pctSchema.optional(),
  });
export type ServiceCodeUpdateInput = z.infer<typeof serviceCodeUpdateSchema>;

export const labourItemUpsertSchema = z.object({
  serviceCodeId: z.coerce.number().int().positive(),
  serviceMasterRateId: z.coerce.number().int().positive(),
  crewQuantity: z.coerce.number().min(0).max(999).default(1),
  hoursPerUnit: z.coerce.number().min(0),
});
export type LabourItemUpsertInput = z.infer<typeof labourItemUpsertSchema>;

export const labourItemUpdateSchema = z
  .object({
    crewQuantity: z.coerce.number().min(0).max(999).optional(),
    hoursPerUnit: z.coerce.number().min(0).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Provide at least one field to update.',
  });
export type LabourItemUpdateInput = z.infer<typeof labourItemUpdateSchema>;

export const materialItemUpsertSchema = z.object({
  serviceCodeId: z.coerce.number().int().positive(),
  itemCode: z.string().trim().max(50).optional().nullable(),
  description: z.string().trim().min(1),
  supplierName: z.string().trim().max(150).optional().nullable(),
  unitCost: z.coerce.number().min(0),
  quantity: z.coerce.number().min(0).default(1),
  uom: z.string().trim().max(20).default('EA'),
});
export type MaterialItemUpsertInput = z.infer<typeof materialItemUpsertSchema>;

export const materialItemUpdateSchema = z
  .object({
    itemCode: z.string().trim().max(50).optional().nullable(),
    description: z.string().trim().min(1).optional(),
    supplierName: z.string().trim().max(150).optional().nullable(),
    unitCost: z.coerce.number().min(0).optional(),
    quantity: z.coerce.number().min(0).optional(),
    uom: z.string().trim().max(20).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });
export type MaterialItemUpdateInput = z.infer<typeof materialItemUpdateSchema>;
