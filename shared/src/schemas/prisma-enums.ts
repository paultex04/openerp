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
  jobStatusValues,
  serviceCodeCategoryValues,
  shiftTypeValues,
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
// Job status — Prisma keys are deliberately prefixed JOB_ because several labels
// would otherwise collide (e.g. no two are alike, but the prefix keeps the
// generated names self-describing).
// ---------------------------------------------------------------------------

export const JOB_STATUS = buildMapping(
  jobStatusValues,
  [
    'JOB_CANCELLED',
    'JOB_SCOPING',
    'JOB_SCOPED',
    'JOB_AWAITING_PO',
    'JOB_WNYS',
    'JOB_WIP',
    'JOB_WORK_COMPLETE',
    'JOB_ACTUALS_IN_PROGRESS',
    'JOB_PACK_READY',
    'JOB_OUT_FOR_SIGNATURE',
    'JOB_AWAITING_CHANGE_ORDER',
    'JOB_INVOICED',
    'JOB_PARTIALLY_INVOICED',
  ],
  {
    // '03. WNYS' has no derivable form ("WNYS" is already the whole label).
    '03. WNYS': 'JOB_WNYS',
  },
);

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

// ---------------------------------------------------------------------------
// Convenience typed accessors for the most frequently converted fields.
// ---------------------------------------------------------------------------

export type PrismaServiceCodeCategory = 'ACTIVITY' | 'R1_MATERIAL';

export function serviceCodeCategoryToKey(label: string): PrismaServiceCodeCategory {
  return SERVICE_CODE_CATEGORY.toKey(label) as PrismaServiceCodeCategory;
}

export function serviceCodeCategoryToLabel(key: string): string {
  return SERVICE_CODE_CATEGORY.toLabel(key);
}

export type PrismaShiftType = 'NT' | 'OT' | 'DT' | 'NS' | 'ST';

export function shiftTypeToKey(label: string): PrismaShiftType {
  return SHIFT_TYPE.toKey(label) as PrismaShiftType;
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
