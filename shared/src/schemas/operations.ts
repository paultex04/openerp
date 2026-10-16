/**
 * Request/response schemas for the operations surface (Phase 3).
 *
 * Shared so client forms and server validation cannot drift.
 */
import { z } from 'zod';
import { jobPrioritySchema } from './enums';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD).')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Not a valid calendar date.');

const quantitySchema = z.coerce
  .number()
  .min(0, 'Quantity cannot be negative.')
  .max(1_000_000, 'Quantity is implausibly large.');

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projectUpsertSchema = z.object({
  contractId: z.coerce.number().int().positive(),
  /** Defaults to the contract's active amendment when omitted. */
  amendmentId: z.coerce.number().int().positive().optional(),
  code: z.string().trim().min(1).max(50),
  year: z.coerce.number().int().min(2000).max(2200),
  startDate: isoDate.optional().nullable(),
  endDate: isoDate.optional().nullable(),
  description: z.string().trim().optional().nullable(),
});
export type ProjectUpsertInput = z.infer<typeof projectUpsertSchema>;

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const jobUpsertSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  /**
   * Null means "inherit the project's amendment" (the Phase 3 resolution rule).
   * Left undefined the field is untouched on update.
   */
  amendmentId: z.coerce.number().int().positive().nullish(),
  supervisorId: z.coerce.number().int().positive().nullish(),
  clientContactId: z.coerce.number().int().positive().nullish(),
  priority: jobPrioritySchema.default('P3 - Routine / Normal'),
  workOrder: z.string().trim().max(100).optional().nullable(),
  workOrderReceivedDate: isoDate.optional().nullable(),
  purchaseOrder: z.string().trim().max(100).optional().nullable(),
  purchaseOrderReceivedDate: isoDate.optional().nullable(),
  plannedStartDate: isoDate.optional().nullable(),
  plannedEndDate: isoDate.optional().nullable(),
  actualStartDate: isoDate.optional().nullable(),
  actualEndDate: isoDate.optional().nullable(),
  area: z.string().trim().max(100).optional().nullable(),
  description: z.string().trim().optional().nullable(),
});
export type JobUpsertInput = z.infer<typeof jobUpsertSchema>;

/**
 * Partial update. Declared independently rather than via `.partial()` on
 * `jobUpsertSchema`, because `jobUpsertSchema` carries a `.default()` for
 * priority and a partial of a defaulted object re-applies that default,
 * silently resetting the priority on any unrelated edit.
 */
export const jobUpdateSchema = z
  .object({
    projectId: z.coerce.number().int().positive().optional(),
    amendmentId: z.coerce.number().int().positive().nullish(),
    supervisorId: z.coerce.number().int().positive().nullish(),
    clientContactId: z.coerce.number().int().positive().nullish(),
    priority: jobPrioritySchema.optional(),
    workOrder: z.string().trim().max(100).optional().nullable(),
    workOrderReceivedDate: isoDate.optional().nullable(),
    purchaseOrder: z.string().trim().max(100).optional().nullable(),
    purchaseOrderReceivedDate: isoDate.optional().nullable(),
    plannedStartDate: isoDate.optional().nullable(),
    plannedEndDate: isoDate.optional().nullable(),
    actualStartDate: isoDate.optional().nullable(),
    actualEndDate: isoDate.optional().nullable(),
    area: z.string().trim().max(100).optional().nullable(),
    description: z.string().trim().optional().nullable(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Provide at least one field to update.',
  });
export type JobUpdateInput = z.infer<typeof jobUpdateSchema>;

export const jobTransitionSchema = z.object({
  /**
   * A status key from the live catalogue. Deliberately a free string here: the
   * catalogue is data and the route validates against it, so a new status an
   * administrator invents works without a schema change.
   */
  status: z.string().trim().min(1).max(40),
  /** Optional note recorded with the transition. */
  note: z.string().trim().max(500).optional(),
});
export type JobTransitionInput = z.infer<typeof jobTransitionSchema>;

// ---------------------------------------------------------------------------
// Deliverables (job_service_code)
// ---------------------------------------------------------------------------

export const deliverableCreateSchema = z.object({
  serviceCodeId: z.coerce.number().int().positive(),
  plannedQuantity: quantitySchema.default(0),
  /**
   * Price snapshot override. Omit to snapshot the service code's current unit
   * rate, which is the normal case.
   */
  appliedRate: z.coerce.number().min(0).optional(),
});
export type DeliverableCreateInput = z.infer<typeof deliverableCreateSchema>;

/**
 * Updating planned quantities. Only accepted while the job is in a scoping
 * status — the server enforces that independently, see `canEditPlanned`.
 */
export const deliverablePlannedUpdateSchema = z.object({
  plannedQuantity: quantitySchema,
});
export type DeliverablePlannedUpdateInput = z.infer<typeof deliverablePlannedUpdateSchema>;

/**
 * Updating actuals. Field supervisors record these during execution.
 *
 * `appliedRate` is deliberately absent: the price snapshot is immutable for the
 * life of the deliverable, which is what keeps invoicing reproducible.
 */
export const deliverableActualUpdateSchema = z.object({
  actualQuantity: quantitySchema,
});
export type DeliverableActualUpdateInput = z.infer<typeof deliverableActualUpdateSchema>;

// ---------------------------------------------------------------------------
// Job assignments
// ---------------------------------------------------------------------------

export const assignmentCreateSchema = z.object({
  jobId: z.coerce.number().int().positive(),
  employeeId: z.coerce.number().int().positive(),
  role: z.string().trim().max(100).optional().nullable(),
  assignedDate: isoDate.optional().nullable(),
});
export type AssignmentCreateInput = z.infer<typeof assignmentCreateSchema>;

export const assignmentUpdateSchema = z
  .object({
    role: z.string().trim().max(100).optional().nullable(),
    assignedDate: isoDate.optional().nullable(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });
export type AssignmentUpdateInput = z.infer<typeof assignmentUpdateSchema>;
