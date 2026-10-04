/**
 * Request schemas for the billing surface (Phase 4).
 *
 * Shared so client forms and server validation cannot drift. Financial figures
 * are never accepted from the caller: quantities, rates, VAT and totals are all
 * derived server-side from the job's deliverables and the amendment, because a
 * total the client supplies is a total the client can forge.
 */
import { z } from 'zod';
import { invoiceStatusSchema } from './enums';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD).')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Not a valid calendar date.');

/**
 * Generates a draft invoice from a job's measured actuals.
 *
 * `deliverableIds` selects a subset of the job's deliverables for partial
 * invoicing; omitted means every deliverable with a measured actual. Lines with
 * no actual recorded are always skipped — an invoice bills measured work, and a
 * zero line would be a placeholder, not a charge. At least one billable line
 * must remain or generation is refused.
 */
export const invoiceGenerateSchema = z.object({
  deliverableIds: z.array(z.coerce.number().int().positive()).max(500).optional(),
  dueDate: isoDate.optional(),
  notes: z.string().trim().max(2000).optional().nullable(),
});
export type InvoiceGenerateInput = z.infer<typeof invoiceGenerateSchema>;

/**
 * Edits a draft invoice.
 *
 * Only `notes` and `dueDate`: the financial figures are derived, never edited.
 * Correcting a figure means the underlying actual was wrong, and that correction
 * belongs in the field view — after which the draft can be deleted and
 * regenerated. Letting totals be edited in place would fork the invoice from
 * the actuals it claims to bill.
 */
export const invoiceUpdateSchema = z
  .object({
    dueDate: isoDate.optional(),
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Provide at least one field to update.',
  });
export type InvoiceUpdateInput = z.infer<typeof invoiceUpdateSchema>;

export const invoiceTransitionSchema = z.object({
  status: invoiceStatusSchema,
});
export type InvoiceTransitionInput = z.infer<typeof invoiceTransitionSchema>;
