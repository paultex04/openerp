/**
 * Zod mirrors of the PostgreSQL enum types.
 *
 * These are the single definitions used for API validation on the server and
 * for form validation on the client, giving the schema parity the stack
 * requires. The literal values must stay byte-identical to the database labels,
 * including spaces, dots, slashes and hyphens.
 */
import { z } from 'zod';

/*
 * Job statuses are deliberately absent here. Since Phase 15 they are rows in
 * `job_statuses`, validated against the live catalogue rather than a compile-time
 * enum; see `../job-status.ts` for the types and the engine.
 */

export const jobPriorityValues = [
  'P1 - Emergency / Breakdown',
  'P2 - Urgent',
  'P3 - Routine / Normal',
  'P4 - Planned Shutdown',
  'P5 - Low',
] as const;
export const jobPrioritySchema = z.enum(jobPriorityValues);
export type JobPriority = z.infer<typeof jobPrioritySchema>;

export const serviceCodeCategoryValues = ['Activity', 'R1 Material'] as const;
export const serviceCodeCategorySchema = z.enum(serviceCodeCategoryValues);
export type ServiceCodeCategory = z.infer<typeof serviceCodeCategorySchema>;

export const shiftTypeValues = ['NT', 'OT1.5', 'DT2.0', 'NS', 'ST'] as const;
export const shiftTypeSchema = z.enum(shiftTypeValues);
export type ShiftType = z.infer<typeof shiftTypeSchema>;

export const contractAmendmentStatusValues = [
  'Draft',
  'Pending Approval',
  'Active',
  'Superseded',
  'Terminated',
] as const;
export const contractAmendmentStatusSchema = z.enum(contractAmendmentStatusValues);
export type ContractAmendmentStatus = z.infer<typeof contractAmendmentStatusSchema>;

export const amendmentTypeValues = [
  'Base Agreement',
  'Annual Escalation',
  'Scope Change',
  'CPI / Index Adjustment',
  'Ad-Hoc Revision',
] as const;
export const amendmentTypeSchema = z.enum(amendmentTypeValues);
export type AmendmentType = z.infer<typeof amendmentTypeSchema>;

export const costParameterCategoryValues = [
  'PPE',
  'Transport',
  'Equipment',
  'Overheads',
  'Margin',
  'Material Markup',
] as const;
export const costParameterCategorySchema = z.enum(costParameterCategoryValues);
export type CostParameterCategory = z.infer<typeof costParameterCategorySchema>;

export const invoiceStatusValues = [
  'Draft',
  'Submitted',
  'Approved',
  'Partially Paid',
  'Paid',
  'Disputed',
  'Cancelled',
] as const;
export const invoiceStatusSchema = z.enum(invoiceStatusValues);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;
