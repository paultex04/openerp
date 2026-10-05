/**
 * Request/response schemas for the organisation surface (Phase 7).
 *
 * These four tables — Broker, EmployeeContractType, Employee and Contact — had no
 * server routes at all before Phase 7, so they get their schemas here rather than
 * being appended to the commercial or operations files. See ADR-007.
 *
 * Shared so the client forms and the server validation cannot drift.
 */
import { z } from 'zod';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD).')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Not a valid calendar date.');

// ---------------------------------------------------------------------------
// Brokers
// ---------------------------------------------------------------------------

export const brokerUpsertSchema = z.object({
  name: z.string().trim().min(1, 'A broker needs a name.').max(150),
});
export type BrokerUpsertInput = z.infer<typeof brokerUpsertSchema>;

// ---------------------------------------------------------------------------
// Employee contract types
// ---------------------------------------------------------------------------

export const employeeContractTypeUpsertSchema = z.object({
  name: z.string().trim().min(1, 'A contract type needs a name.').max(100),
});
export type EmployeeContractTypeUpsertInput = z.infer<typeof employeeContractTypeUpsertSchema>;

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

/**
 * An employee record.
 *
 * `email` and `idNumber` are unique in the schema but nullable, and both are
 * validated as "absent or well formed" rather than required. A field crew
 * member with no email and no ID number on file is a normal state for this
 * business, and making either mandatory would push people to invent values.
 */
export const employeeUpsertSchema = z.object({
  name: z.string().trim().min(1, 'An employee needs a first name.').max(100),
  surname: z.string().trim().min(1, 'An employee needs a surname.').max(100),
  mobile: z.string().trim().max(50).optional().nullable(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Enter a valid email address.')
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  idNumber: z.string().trim().max(50).optional().nullable(),
  startDate: isoDate,
  /** Set to terminate the employee. This is how an employee is deactivated. */
  endDate: isoDate.optional().nullable(),
  brokerId: z.coerce.number().int().positive().optional().nullable(),
  contractTypeId: z.coerce.number().int().positive(),
  managerId: z.coerce.number().int().positive().optional().nullable(),
  rate: z.coerce.number().min(0).max(100_000).optional().nullable(),
});
export type EmployeeUpsertInput = z.infer<typeof employeeUpsertSchema>;

/**
 * Partial update.
 *
 * Declared independently of `employeeUpsertSchema.partial()` for one concrete
 * reason: `contractTypeId` is required on create, and an employee whose contract
 * type has been retired should be editable without one being re-sent. Leaving it
 * undefined must mean "untouched", not "cleared".
 */
export const employeeUpdateSchema = employeeUpsertSchema.partial().omit({ startDate: true });
export type EmployeeUpdateInput = z.infer<typeof employeeUpdateSchema>;

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export const contactUpsertSchema = z.object({
  clientId: z.coerce.number().int().positive(),
  name: z.string().trim().min(1, 'A contact needs a name.').max(150),
  mobile: z.string().trim().max(50).optional().nullable(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Enter a valid email address.')
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  /**
   * Phase 8 item 4. Free text rather than a lookup table: the set is small, varies
   * by client, and a fixed enumeration would be wrong more often than right. A
   * picker fed from the values already in use is added in the UI.
   */
  role: z.string().trim().max(100).optional().nullable(),
});
export type ContactUpsertInput = z.infer<typeof contactUpsertSchema>;

export const contactUpdateSchema = contactUpsertSchema.partial().omit({ clientId: true });
export type ContactUpdateInput = z.infer<typeof contactUpdateSchema>;

// ---------------------------------------------------------------------------
// Crew assignments
// ---------------------------------------------------------------------------

/**
 * Adding an employee to a job's crew.
 *
 * Kept here rather than in `operations.ts` so the whole Phase 7 organisation
 * surface is readable in one file, even though the route lives with the other
 * job sub-resources.
 */
export const jobAssignmentUpsertSchema = z.object({
  employeeId: z.coerce.number().int().positive(),
  role: z.string().trim().max(100).optional().nullable(),
  assignedDate: isoDate.optional().nullable(),
});
export type JobAssignmentUpsertInput = z.infer<typeof jobAssignmentUpsertSchema>;

export const jobAssignmentUpdateSchema = jobAssignmentUpsertSchema.partial().omit({
  employeeId: true,
});
export type JobAssignmentUpdateInput = z.infer<typeof jobAssignmentUpdateSchema>;
