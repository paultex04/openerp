/**
 * Request/response schemas for the timesheet and costing surface (Phase 16).
 *
 * Shared so client forms and server validation cannot drift, exactly like the
 * other `schemas/*` modules.
 */
import { z } from 'zod';
import { shiftTypeSchema } from './enums';
import { HOURS_STEP, MAX_HOURS_PER_LINE, isStepHours } from '../costing';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD).')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Not a valid calendar date.');

const hoursSchema = z.coerce
  .number()
  .min(HOURS_STEP, `Hours must be at least ${HOURS_STEP}.`)
  .max(MAX_HOURS_PER_LINE, `A single line cannot exceed ${MAX_HOURS_PER_LINE} hours.`)
  .refine((v) => Number.isFinite(v) && isStepHours(v), 'Hours must be in quarter-hour steps.');

const costRate = z.coerce.number().min(0, 'Cost rate cannot be negative.').max(100_000);

// ---------------------------------------------------------------------------
// Timesheets (headers)
// ---------------------------------------------------------------------------

/**
 * Opens (or returns) a draft week for an employee.
 *
 * `periodStart` is the Monday; the server derives the Sunday, so a client can
 * never create a header whose period is inconsistent with its own bounds.
 * `employeeId` is only honoured for a caller holding `timesheet.write`
 * (entering on someone's behalf); otherwise the server uses the caller.
 */
export const timesheetCreateSchema = z.object({
  employeeId: z.coerce.number().int().positive().optional(),
  periodStart: isoDate,
});
export type TimesheetCreateInput = z.infer<typeof timesheetCreateSchema>;

export const timesheetUpdateSchema = z
  .object({
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });
export type TimesheetUpdateInput = z.infer<typeof timesheetUpdateSchema>;

// ---------------------------------------------------------------------------
// Timesheet entries (lines)
// ---------------------------------------------------------------------------

/**
 * A line: hours on one job, on one day, of one labour type and shift.
 *
 * `jobId` is required — the entire purpose of the module is assigning hours to
 * jobs. `jobServiceCodeId` is the optional deliverable link that lets the
 * costing engine attribute hours to a specific line of the job.
 */
export const timesheetEntryCreateSchema = z
  .object({
    jobId: z.coerce.number().int().positive(),
    jobServiceCodeId: z.coerce.number().int().positive().nullish(),
    workDate: isoDate,
    labourType: z.string().trim().min(1).max(100),
    shiftType: shiftTypeSchema.default('NT'),
    hours: hoursSchema,
    isBillable: z.boolean().default(true),
    notes: z.string().trim().max(500).optional().nullable(),
    /** Manual cost-rate override (requires `timesheet.override`). */
    costRateOverride: costRate.optional().nullable(),
    overrideReason: z.string().trim().max(500).optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.costRateOverride !== null && value.costRateOverride !== undefined) {
      if (!value.overrideReason || value.overrideReason.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['overrideReason'],
          message: 'A reason is required when overriding the cost rate.',
        });
      }
    }
  });
export type TimesheetEntryCreateInput = z.infer<typeof timesheetEntryCreateSchema>;

export const timesheetEntryUpdateSchema = z
  .object({
    jobId: z.coerce.number().int().positive().optional(),
    jobServiceCodeId: z.coerce.number().int().positive().nullish(),
    workDate: isoDate.optional(),
    labourType: z.string().trim().min(1).max(100).optional(),
    shiftType: shiftTypeSchema.optional(),
    hours: hoursSchema.optional(),
    isBillable: z.boolean().optional(),
    notes: z.string().trim().max(500).optional().nullable(),
    costRateOverride: costRate.optional().nullable(),
    overrideReason: z.string().trim().max(500).optional().nullable(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });
export type TimesheetEntryUpdateInput = z.infer<typeof timesheetEntryUpdateSchema>;

// ---------------------------------------------------------------------------
// Workflow actions
// ---------------------------------------------------------------------------

export const timesheetSubmitSchema = z.object({
  note: z.string().trim().max(500).optional(),
});
export type TimesheetSubmitInput = z.infer<typeof timesheetSubmitSchema>;

export const timesheetApproveSchema = z.object({
  note: z.string().trim().max(500).optional(),
});
export type TimesheetApproveInput = z.infer<typeof timesheetApproveSchema>;

export const timesheetRejectSchema = z.object({
  note: z.string().trim().min(1, 'A reason is required when rejecting a timesheet.').max(500),
});
export type TimesheetRejectInput = z.infer<typeof timesheetRejectSchema>;

export const timesheetReopenSchema = z.object({
  note: z.string().trim().min(1, 'A reason is required when reopening a timesheet.').max(500),
});
export type TimesheetReopenInput = z.infer<typeof timesheetReopenSchema>;
