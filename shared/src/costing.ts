/**
 * Job costing mathematics — turning hours into a cost, and cost into margin.
 *
 * The commercial side already answers "what was this job worth?": a deliverable
 * carries an immutable `applied_rate` and an `actual_subtotal`, and invoices
 * follow. Nothing answered "what did this job cost to deliver?" until
 * timesheets existed. This module is the other half:
 *
 *   revenue (from actuals/invoices) − labour cost − material cost = gross margin
 *
 * ## Why the numbers are trusted
 *
 *  * **Rates are snapshotted, never re-read.** An approved timesheet line stores
 *    the whole `LabourRateComponents` vector, so an edit to a rate card tomorrow
 *    cannot rewrite yesterday's cost. That mirrors `job_service_code`'s
 *    `applied_rate` (see `deliverables.ts`) and ADR-001's "authoritative once
 *    written" rule. `costRateForBasis` is therefore applied to a *snapshot*, and
 *    a change of cost basis is a policy change, not a data migration.
 *  * **Rounding happens once, on output.** Every intermediate stays at full
 *    precision and passes through `money.ts`. Cost chains have many addends;
 *    rounding each one is how off-by-a-cent errors are born.
 *
 * The module is pure and isomorphic — the client runs it for the live preview in
 * the entry grid, the server runs it authoritatively.
 */
import { round, roundMoney, roundRate, sumExact, toNumber, type DecimalLike } from './money';

// ---------------------------------------------------------------------------
// Cost basis
// ---------------------------------------------------------------------------

/**
 * The component vector of a Tier-1 labour rate card row (`ServiceMasterRate`).
 *
 * Held as a whole rather than collapsed to a single number so that "the rate on
 * the day" stays defensible and a future basis can be answered from history.
 */
export interface LabourRateComponents {
  manInPocket: DecimalLike;
  leavePay: DecimalLike;
  totalStatutoryCost: DecimalLike;
  ppeCost: DecimalLike;
  transportCost: DecimalLike;
  equipmentCost: DecimalLike;
  overheadCost: DecimalLike;
  sgaCost: DecimalLike;
  profitCost: DecimalLike;
  fullLoadedRate: DecimalLike;
}

/**
 * Which slice of the build-up is "cost".
 *
 *  * `direct`               – employer's direct employment cost (wage + leave +
 *                             statutory). Gross-margin view.
 *  * `fully_loaded_ex_profit` – everything except company profit. The default:
 *                             profit is not a cost of delivering a job.
 *  * `fully_loaded`         – the published rate. Used when a job is measured
 *                             against its own charge-out rate.
 */
export type CostBasis = 'direct' | 'fully_loaded_ex_profit' | 'fully_loaded';

export const DEFAULT_COST_BASIS: CostBasis = 'fully_loaded_ex_profit';

export const COST_BASIS_LABELS: Readonly<Record<CostBasis, string>> = {
  direct: 'Direct employment cost',
  fully_loaded_ex_profit: 'Fully loaded (excluding profit)',
  fully_loaded: 'Fully loaded (including profit)',
};

/** Applies a cost basis to a frozen component vector. */
export function costRateForBasis(
  components: LabourRateComponents,
  basis: CostBasis = DEFAULT_COST_BASIS,
): number {
  switch (basis) {
    case 'direct':
      return roundRate(
        sumExact([components.manInPocket, components.leavePay, components.totalStatutoryCost]),
      );
    case 'fully_loaded':
      return roundRate(components.fullLoadedRate);
    case 'fully_loaded_ex_profit':
      return roundRate(toNumber(components.fullLoadedRate) - toNumber(components.profitCost));
  }
}

// ---------------------------------------------------------------------------
// Rate resolution
// ---------------------------------------------------------------------------

export type CostRateSource = 'override' | 'service_master_rate' | 'employee_rate';

/** A rate-card row matched to a line's labour type and shift. */
export interface CostRateCandidate {
  labourType: string;
  shiftType: string;
  components: LabourRateComponents;
}

export interface ResolveCostRateInput {
  /** A manual override typed on the line, if any. Wins outright. */
  overrideRate?: DecimalLike | null;
  /** The rate card row for the job's amendment + labour type + shift. */
  candidate?: CostRateCandidate | null;
  /** The dormant `employee.rate`, used only when no rate-card row exists. */
  employeeRate?: DecimalLike | null;
  basis?: CostBasis;
}

export interface ResolvedCostRate {
  costRate: number;
  basis: CostBasis;
  source: CostRateSource;
  /** Null when the rate came from the employee record or an override. */
  components: LabourRateComponents | null;
}

/**
 * Raised when a line has no rate at all: no override, no matched rate-card row
 * and no employee rate. The timesheet API maps it to `EMPLOYEE_RATE_REQUIRED`.
 */
export class MissingCostRateError extends Error {
  constructor(
    readonly labourType: string,
    readonly shiftType: string,
  ) {
    super(`No cost rate found for labour type "${labourType}" / shift "${shiftType}".`);
    this.name = 'MissingCostRateError';
  }
}

/**
 * Resolves the cost rate for a line, in precedence order:
 *
 *   1. an explicit override (audited; `timesheet.override`),
 *   2. the job amendment's Tier-1 rate card row,
 *   3. the employee's own `rate` as a last resort.
 *
 * Throws {@link MissingCostRateError} rather than silently costing an hour at
 * zero — a missing rate is a data problem, not a free hour.
 */
export function resolveCostRate(input: ResolveCostRateInput): ResolvedCostRate {
  const basis = input.basis ?? DEFAULT_COST_BASIS;
  // Captured before the candidate is narrowed away, for the error message.
  const candidateLabourType = input.candidate?.labourType ?? '(unknown)';
  const candidateShiftType = input.candidate?.shiftType ?? '(unknown)';

  if (
    input.overrideRate !== null &&
    input.overrideRate !== undefined &&
    input.overrideRate !== ''
  ) {
    return { costRate: roundRate(input.overrideRate), basis, source: 'override', components: null };
  }

  if (input.candidate) {
    return {
      costRate: costRateForBasis(input.candidate.components, basis),
      basis,
      source: 'service_master_rate',
      components: input.candidate.components,
    };
  }

  if (
    input.employeeRate !== null &&
    input.employeeRate !== undefined &&
    input.employeeRate !== ''
  ) {
    return {
      costRate: roundRate(input.employeeRate),
      basis,
      source: 'employee_rate',
      components: null,
    };
  }

  throw new MissingCostRateError(candidateLabourType, candidateShiftType);
}

// ---------------------------------------------------------------------------
// Hours helpers
// ---------------------------------------------------------------------------

/** The entry step: hours are recorded to a quarter hour. */
export const HOURS_STEP = 0.25;
/** A single line may not record more than a day. */
export const MAX_HOURS_PER_LINE = 24;

/** True when `value` lands on the quarter-hour grid (0.25, 0.5, …). */
export function isStepHours(value: DecimalLike): boolean {
  const n = toNumber(value, 'hours');
  const steps = n / HOURS_STEP;
  return Number.isFinite(steps) && Math.abs(steps - Math.round(steps)) < 1e-9;
}

/** Sums hours, rounding once. */
export function sumHours(hours: readonly DecimalLike[]): number {
  return round(sumExact(hours, 'hours'), 2);
}

/**
 * The cost of a line: hours × cost rate, rounded to cents.
 *
 * Rounded once, here, so a client previewing a draft line and the server
 * freezing an approved one cannot disagree about the last cent.
 */
export function entryCost(hours: DecimalLike, costRate: DecimalLike): number {
  return roundMoney(toNumber(hours, 'hours') * toNumber(costRate, 'costRate'));
}

// ---------------------------------------------------------------------------
// Planned labour
// ---------------------------------------------------------------------------

/**
 * A planned labour line, derived from the pricing recipe:
 *
 *   plannedHours = crewQuantity × hoursPerUnit × plannedQuantity
 *
 * No new data is needed for this — it falls out of `ServiceCodeLabourItem` and
 * `job_service_code.planned_quantity`, which is why planned-vs-actual labour
 * variance is available on day one.
 */
export interface PlannedLabourLine {
  plannedQuantity: DecimalLike;
  crewQuantity: DecimalLike;
  hoursPerUnit: DecimalLike;
  labourType: string;
  shiftType: string;
  /** The cost rate for this line's labour type, in ZAR per hour. */
  costRate: DecimalLike;
}

export interface LabourGroup {
  labourType: string;
  shiftType: string;
  hoursPlanned: number;
  hoursActual: number;
  costPlanned: number;
  costActual: number;
  costVariance: number;
}

function groupKey(labourType: string, shiftType: string): string {
  return `${labourType}\u0000${shiftType}`;
}

/** Planned hours and cost per line, grouped by labour type and shift. */
export function plannedLabour(lines: readonly PlannedLabourLine[]): {
  hours: number;
  cost: number;
  byLabourType: LabourGroup[];
} {
  const groups = new Map<string, LabourGroup>();
  let hours = 0;
  let cost = 0;

  for (const line of lines) {
    const lineHours =
      toNumber(line.crewQuantity, 'crewQuantity') *
      toNumber(line.hoursPerUnit, 'hoursPerUnit') *
      toNumber(line.plannedQuantity, 'plannedQuantity');
    const lineCost = lineHours * toNumber(line.costRate, 'costRate');

    hours += lineHours;
    cost += lineCost;

    const key = groupKey(line.labourType, line.shiftType);
    const group =
      groups.get(key) ??
      ({
        labourType: line.labourType,
        shiftType: line.shiftType,
        hoursPlanned: 0,
        hoursActual: 0,
        costPlanned: 0,
        costActual: 0,
        costVariance: 0,
      } satisfies LabourGroup);
    group.hoursPlanned += lineHours;
    group.costPlanned += lineCost;
    groups.set(key, group);
  }

  return {
    hours: round(hours, 2),
    cost: roundMoney(cost),
    byLabourType: [...groups.values()].map(finaliseGroup),
  };
}

function finaliseGroup(group: LabourGroup): LabourGroup {
  const costVariance = roundMoney(group.costActual - group.costPlanned);
  return {
    labourType: group.labourType,
    shiftType: group.shiftType,
    hoursPlanned: round(group.hoursPlanned, 2),
    hoursActual: round(group.hoursActual, 2),
    costPlanned: roundMoney(group.costPlanned),
    costActual: roundMoney(group.costActual),
    costVariance,
  };
}

// ---------------------------------------------------------------------------
// Actual labour & material
// ---------------------------------------------------------------------------

/**
 * An approved timesheet line's contribution to cost.
 *
 * `costAmount` is the frozen figure recorded at approval (hours × costRate).
 * Read the frozen value rather than recomputing wherever possible: that is the
 * whole point of snapshotting.
 */
export interface ActualLabourLine {
  hours: DecimalLike;
  labourType: string;
  shiftType: string;
  costAmount: DecimalLike;
  isBillable?: boolean;
}

/** A material cost line, derived from a deliverable's snapshotted BOM. */
export interface MaterialCostLine {
  quantity: DecimalLike;
  unitCost: DecimalLike;
}

/** Material cost for actual quantities, rounded once. */
export function materialCost(lines: readonly MaterialCostLine[]): number {
  return roundMoney(
    sumExact(
      lines.map(
        (line) => toNumber(line.quantity, 'quantity') * toNumber(line.unitCost, 'unitCost'),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Job summary
// ---------------------------------------------------------------------------

export interface JobCostingInput {
  plans?: readonly PlannedLabourLine[];
  entries?: readonly ActualLabourLine[];
  materials?: readonly MaterialCostLine[];
  revenueActual?: DecimalLike;
  revenueInvoiced?: DecimalLike;
}

export interface JobCostingSummary {
  /** Σ `job_service_code.actual_subtotal` — work done, at charge-out rates. */
  revenueActual: number;
  /** Σ non-cancelled `invoice.subtotal_amount` — what has been billed. */
  revenueInvoiced: number;

  hoursPlanned: number;
  costPlanned: number;

  hoursActual: number;
  labourCostActual: number;
  materialCostActual: number;
  /** labour + material. The figure margin is measured against. */
  costActual: number;

  /** revenueActual − costActual. */
  grossMargin: number;
  /** grossMargin ÷ revenueActual, as a fraction (0.15 = 15%). Zero when there is no revenue. */
  grossMarginPct: number;

  /** actual − planned. Negative means under the plan. */
  hoursVariance: number;
  costVariance: number;

  byLabourType: LabourGroup[];
}

/**
 * The single per-job costing calculation. Everything that displays a margin —
 * the job detail panel, the profitability register, the API — calls this, so
 * there is exactly one definition of "margin" in the system.
 */
export function summariseJobCosting(input: JobCostingInput): JobCostingSummary {
  const plan = plannedLabour(input.plans ?? []);

  const groups = new Map<string, LabourGroup>();
  for (const group of plan.byLabourType) {
    groups.set(groupKey(group.labourType, group.shiftType), { ...group });
  }

  let hoursActual = 0;
  let labourCostActual = 0;
  for (const entry of input.entries ?? []) {
    const hours = toNumber(entry.hours, 'hours');
    const cost = toNumber(entry.costAmount, 'costAmount');
    hoursActual += hours;
    labourCostActual += cost;

    const key = groupKey(entry.labourType, entry.shiftType);
    const group =
      groups.get(key) ??
      ({
        labourType: entry.labourType,
        shiftType: entry.shiftType,
        hoursPlanned: 0,
        hoursActual: 0,
        costPlanned: 0,
        costActual: 0,
        costVariance: 0,
      } satisfies LabourGroup);
    group.hoursActual += hours;
    group.costActual += cost;
    groups.set(key, group);
  }

  const materialCostActual = materialCost(input.materials ?? []);
  const labourCostActualRounded = roundMoney(labourCostActual);
  const costActual = roundMoney(labourCostActualRounded + materialCostActual);

  const revenueActual = roundMoney(input.revenueActual ?? 0);
  const revenueInvoiced = roundMoney(input.revenueInvoiced ?? 0);
  const grossMargin = roundMoney(revenueActual - costActual);

  return {
    revenueActual,
    revenueInvoiced,
    hoursPlanned: plan.hours,
    costPlanned: plan.cost,
    hoursActual: round(hoursActual, 2),
    labourCostActual: labourCostActualRounded,
    materialCostActual,
    costActual,
    grossMargin,
    grossMarginPct: revenueActual === 0 ? 0 : round(grossMargin / revenueActual, 4),
    hoursVariance: round(hoursActual - plan.hours, 2),
    costVariance: roundMoney(costActual - plan.cost),
    byLabourType: [...groups.values()].map(finaliseGroup).sort((a, b) => {
      if (a.labourType !== b.labourType) return a.labourType < b.labourType ? -1 : 1;
      return a.shiftType < b.shiftType ? -1 : 1;
    }),
  };
}
