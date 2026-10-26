/**
 * Boundary conversion between database enum labels and Prisma enum keys.
 *
 * The PostgreSQL enum labels are the business's own vocabulary ("R1 Material",
 * "P1 - Emergency / Breakdown", "Active"). Prisma identifiers cannot contain
 * spaces, dots or slashes, so `schema.prisma` maps every variant to a safe name
 * via `@map`:
 *
 *   database label          Prisma key
 *   ---------------------   -----------------
 *   'R1 Material'           R1_MATERIAL
 *   'Active'                ACTIVE
 *   'P1 - Emergency / ...'  P1_EMERGENCY_BREAKDOWN
 *
 * The API speaks the **labels**, because that is what the specification and the
 * users use. Prisma speaks the **keys**. This module is the single place that
 * translates, so no route has to guess and no cast is needed.
 *
 * The mappings are exhaustive: `assertNever` below makes the compiler fail if a
 * variant is ever added to an enum without being wired up here.
 */
import {
  amendmentTypeValues,
  contractAmendmentStatusValues,
  costParameterCategoryValues,
  invoiceStatusValues,
  jobPriorityValues,
  serviceCodeCategoryValues,
  shiftTypeValues,
  timesheetStatusValues,
  taskStatusValues,
  taskPriorityValues,
  type InvoiceStatus,
  type ShiftType,
  type TimesheetStatus,
  type TaskStatus,
  type TaskPriority,
} from './enums';

/** Compile-time exhaustiveness guard. */
export function assertNever(value: never, enumName: string): never {
  throw new Error(`Unhandled ${enumName} variant: ${JSON.stringify(value)}`);
}

/**
 * Builds a bidirectional label <-> key lookup.
 *
 * `toKey` is derived mechanically from the label so the two sides can never
 * drift: 'Ad-Hoc Revision' -> AD_HOC_REVISION, 'R1 Material' -> R1_MATERIAL,
 * '01A. Scoped' -> JOB_SCOPED (explicit override where the derivation differs).
 */
function buildMapping<L extends string>(
  labels: readonly L[],
  prismaKeys: readonly string[],
  overrides: Partial<Record<L, string>> = {},
) {
  if (labels.length !== prismaKeys.length) {
    throw new Error(
      `Enum mapping arity mismatch: ${labels.length} labels vs ${prismaKeys.length} keys.`,
    );
  }

  const labelToKey = new Map<string, string>();
  const keyToLabel = new Map<string, string>();

  labels.forEach((label, index) => {
    const key = overrides[label] ?? prismaKeys[index]!;
    if (labelToKey.has(key)) {
      throw new Error(`Duplicate Prisma key "${key}" while mapping enum.`);
    }
    labelToKey.set(label, key);
    keyToLabel.set(key, label);
  });

  return {
    toKey(label: string): string {
      const key = labelToKey.get(label);
      if (!key) throw new Error(`Unknown enum label "${label}".`);
      return key;
    },
    toLabel(key: string): string {
      const label = keyToLabel.get(key);
      if (!label) throw new Error(`Unknown Prisma enum key "${key}".`);
      return label;
    },
    labels: [...labels],
    keys: [...prismaKeys],
  };
}

// ---------------------------------------------------------------------------
// Job status — since Phase 15 the statuses are catalogue rows, not an enum, so
// the API speaks the stored key directly and no mapping is needed. See
// `../job-status.ts`.
// ---------------------------------------------------------------------------

export const JOB_PRIORITY = buildMapping(jobPriorityValues, [
  'P1_EMERGENCY_BREAKDOWN',
  'P2_URGENT',
  'P3_ROUTINE_NORMAL',
  'P4_PLANNED_SHUTDOWN',
  'P5_LOW',
]);

export const SERVICE_CODE_CATEGORY = buildMapping(serviceCodeCategoryValues, [
  'ACTIVITY',
  'R1_MATERIAL',
]);

/** 'OT1.5' and 'DT2.0' cannot be derived mechanically from their multiplier. */
export const SHIFT_TYPE = buildMapping(shiftTypeValues, ['NT', 'OT', 'DT', 'NS', 'ST'], {
  'OT1.5': 'OT',
  'DT2.0': 'DT',
});

export const CONTRACT_AMENDMENT_STATUS = buildMapping(contractAmendmentStatusValues, [
  'DRAFT',
  'PENDING_APPROVAL',
  'ACTIVE',
  'SUPERSEDED',
  'TERMINATED',
]);

export const AMENDMENT_TYPE = buildMapping(amendmentTypeValues, [
  'BASE_AGREEMENT',
  'ANNUAL_ESCALATION',
  'SCOPE_CHANGE',
  'CPI_INDEX_ADJUSTMENT',
  'AD_HOC_REVISION',
]);

export const COST_PARAMETER_CATEGORY = buildMapping(costParameterCategoryValues, [
  'PPE',
  'TRANSPORT',
  'EQUIPMENT',
  'OVERHEADS',
  'MARGIN',
  'MATERIAL_MARKUP',
]);

export const INVOICE_STATUS = buildMapping(invoiceStatusValues, [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'PARTIALLY_PAID',
  'PAID',
  'DISPUTED',
  'CANCELLED',
]);

export const TIMESHEET_STATUS = buildMapping(timesheetStatusValues, [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
]);

export const TASK_STATUS = buildMapping(taskStatusValues, [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'DONE',
  'CANCELLED',
]);

export const TASK_PRIORITY = buildMapping(taskPriorityValues, [
  'LOW',
  'MEDIUM',
  'HIGH',
  'URGENT',
]);

// ---------------------------------------------------------------------------
// Convenience typed accessors for the most frequently converted fields.
// ---------------------------------------------------------------------------

/**
 * Direct lookups between a Prisma enum key and its business label.
 *
 * Reading a database row gives the Prisma key while the shared state machine
 * and every API payload use the label. This map keeps that translation in one
 * place rather than at each call site. (Job status needs no entry: it is stored
 * as its own key.)
 */
export const JOB_PRIORITY_TO_KEY: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(JOB_PRIORITY.labels.map((label) => [JOB_PRIORITY.toKey(label), label])),
);

export type PrismaServiceCodeCategory = 'ACTIVITY' | 'R1_MATERIAL';

export function serviceCodeCategoryToKey(label: string): PrismaServiceCodeCategory {
  return SERVICE_CODE_CATEGORY.toKey(label) as PrismaServiceCodeCategory;
}

export function serviceCodeCategoryToLabel(key: string): string {
  return SERVICE_CODE_CATEGORY.toLabel(key);
}

/** Business label -> Prisma job status key, typed for Prisma writes. */
export function jobPriorityToKey(label: string): string {
  return JOB_PRIORITY.toKey(label);
}

/** Prisma enum key ('P2_URGENT') -> business label ('P2 - Urgent'). */
export function jobPriorityFromKey(key: string): string {
  return JOB_PRIORITY.toLabel(key);
}

/** Business label ('Partially Paid') -> Prisma enum key ('PARTIALLY_PAID'). */
export function invoiceStatusToKey(label: string): string {
  return INVOICE_STATUS.toKey(label);
}

/**
 * Prisma enum key ('PARTIALLY_PAID') -> business label ('Partially Paid').
 *
 * Throws on an unknown key rather than returning `undefined`, matching the
 * job-status accessors above.
 */
export function invoiceStatusFromKey(key: string): InvoiceStatus {
  return INVOICE_STATUS.toLabel(key) as InvoiceStatus;
}

export type PrismaTimesheetStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';

/** Business label ('Rejected') -> Prisma enum key ('REJECTED'). */
export function timesheetStatusToKey(label: string): PrismaTimesheetStatus {
  return TIMESHEET_STATUS.toKey(label) as PrismaTimesheetStatus;
}

/** Prisma enum key ('APPROVED') -> business label ('Approved'). */
export function timesheetStatusFromKey(key: string): TimesheetStatus {
  return TIMESHEET_STATUS.toLabel(key) as TimesheetStatus;
}

export type PrismaShiftType = 'NT' | 'OT' | 'DT' | 'NS' | 'ST';

export function shiftTypeToKey(label: string): PrismaShiftType {
  return SHIFT_TYPE.toKey(label) as PrismaShiftType;
}

/** Prisma enum key ('OT') -> business label ('OT1.5'). */
export function shiftTypeFromKey(key: string): ShiftType {
  return SHIFT_TYPE.toLabel(key) as ShiftType;
}

export type PrismaAmendmentType =
  | 'BASE_AGREEMENT'
  | 'ANNUAL_ESCALATION'
  | 'SCOPE_CHANGE'
  | 'CPI_INDEX_ADJUSTMENT'
  | 'AD_HOC_REVISION';

export type PrismaContractAmendmentStatus =
  'DRAFT' | 'PENDING_APPROVAL' | 'ACTIVE' | 'SUPERSEDED' | 'TERMINATED';

export type PrismaCostParameterCategory =
  'PPE' | 'TRANSPORT' | 'EQUIPMENT' | 'OVERHEADS' | 'MARGIN' | 'MATERIAL_MARKUP';

export type PrismaTaskStatus = 'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELLED';
export function taskStatusToKey(label: string): PrismaTaskStatus {
  return TASK_STATUS.toKey(label) as PrismaTaskStatus;
}
export function taskStatusFromKey(key: string): TaskStatus {
  return TASK_STATUS.toLabel(key) as TaskStatus;
}

export type PrismaTaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export function taskPriorityToKey(label: string): PrismaTaskPriority {
  return TASK_PRIORITY.toKey(label) as PrismaTaskPriority;
}
export function taskPriorityFromKey(key: string): TaskPriority {
  return TASK_PRIORITY.toLabel(key) as TaskPriority;
}
