/**
 * Tier 2 — service code pricing.
 *
 * Two categories, per the specification:
 *
 *   Activity     — Calculated Unit Rate = SUM(Crew Quantity x Hours per Unit x
 *                  Labour Master Full Loaded Rate)
 *   R1 Material  — Calculated Unit Rate = SUM(Unit Procurement Cost x Quantity)
 *                                      x (1 + Material Markup %)
 *
 * Rounding: labour lines and unit rates are held to 4dp, matching
 * `numeric(12,4)` on `service_code_labour_item.line_subtotal` and
 * `service_code.calculated_unit_rate`. This precision is required, not cosmetic:
 * the reference activity `S00247970` prices at 17.5226 ZAR/m, which is only
 * representable at 4dp.
 *
 * The rate is recomputed as the sum of *rounded* line subtotals. That mirrors how
 * the baseline rollups were produced (each stored line subtotal is already
 * rounded, and the rollup equals their sum) and keeps the stored rollup
 * reconcilable against its own stored lines.
 */
import { roundRate, sumExact, toNumber } from '../money';
import type { ServiceCodeCategory } from '../schemas/enums';

export interface LabourRecipeLine {
  crewQuantity: number | string;
  hoursPerUnit: number | string;
  /** Tier 1 full loaded rate of the referenced labour master rate. */
  fullLoadedRate: number | string;
}

export interface ComputedLabourLine extends LabourRecipeLine {
  /** crewQuantity x hoursPerUnit x fullLoadedRate, rounded to 4dp. */
  lineSubtotal: number;
}

export interface MaterialRecipeLine {
  unitCost: number | string;
  quantity: number | string;
}

export interface ComputedMaterialLine extends MaterialRecipeLine {
  /** unitCost x quantity, rounded to 4dp. */
  subtotalCost: number;
}

export interface ComputeActivityResult {
  category: 'Activity';
  lines: ComputedLabourLine[];
  /** Sum of the rounded line subtotals. */
  calculatedUnitRate: number;
  /** Total crew hours consumed per unit, useful for sanity-checking a recipe. */
  totalHoursPerUnit: number;
}

export interface ComputeMaterialResult {
  category: 'R1 Material';
  lines: ComputedMaterialLine[];
  /** Sum of the procurement costs, before markup. */
  subtotalCost: number;
  /** Material markup applied, as a fraction (0.10 = 10%). */
  materialMarkupPct: number;
  /** subtotalCost x (1 + markup). */
  calculatedUnitRate: number;
  /** Markup value actually applied, for display. */
  markupAmount: number;
}

/** Activity recipe: labour only. */
export function computeActivityRate(lines: readonly LabourRecipeLine[]): ComputeActivityResult {
  const computed: ComputedLabourLine[] = lines.map((line) => ({
    ...line,
    lineSubtotal: roundRate(
      toNumber(line.crewQuantity, 'crewQuantity') *
        toNumber(line.hoursPerUnit, 'hoursPerUnit') *
        toNumber(line.fullLoadedRate, 'fullLoadedRate'),
      'lineSubtotal',
    ),
  }));

  return {
    category: 'Activity',
    lines: computed,
    calculatedUnitRate: roundRate(
      sumExact(
        computed.map((l) => l.lineSubtotal),
        'calculatedUnitRate',
      ),
      'calculatedUnitRate',
    ),
    totalHoursPerUnit: sumExact(
      lines.map(
        (l) => toNumber(l.crewQuantity, 'crewQuantity') * toNumber(l.hoursPerUnit, 'hoursPerUnit'),
      ),
      'totalHoursPerUnit',
    ),
  };
}

/** R1 material recipe: procurement BOM with a markup. */
export function computeMaterialRate(
  lines: readonly MaterialRecipeLine[],
  materialMarkupPct: number | string,
): ComputeMaterialResult {
  const computed: ComputedMaterialLine[] = lines.map((line) => ({
    ...line,
    subtotalCost: roundRate(
      toNumber(line.unitCost, 'unitCost') * toNumber(line.quantity, 'quantity'),
      'subtotalCost',
    ),
  }));

  const subtotalCost = sumExact(
    computed.map((l) => l.subtotalCost),
    'subtotalCost',
  );
  const markup = toNumber(materialMarkupPct, 'materialMarkupPct');

  return {
    category: 'R1 Material',
    lines: computed,
    subtotalCost: roundRate(subtotalCost, 'subtotalCost'),
    materialMarkupPct: markup,
    calculatedUnitRate: roundRate(subtotalCost * (1 + markup), 'calculatedUnitRate'),
    markupAmount: roundRate(subtotalCost * markup, 'markupAmount'),
  };
}

/** Dispatches on the service code's category. */
export function computeServiceCodeRate(
  category: ServiceCodeCategory,
  input: {
    labourLines?: readonly LabourRecipeLine[];
    materialLines?: readonly MaterialRecipeLine[];
    materialMarkupPct?: number | string;
  },
): ComputeActivityResult | ComputeMaterialResult {
  if (category === 'R1 Material') {
    return computeMaterialRate(input.materialLines ?? [], input.materialMarkupPct ?? 0);
  }
  return computeActivityRate(input.labourLines ?? []);
}

export interface RateVariance {
  /** The freshly computed rate. */
  computed: number;
  /** The rate currently stored on the service code. */
  stored: number;
  /** computed - stored. */
  delta: number;
  /** True when they agree to within a half-cent. */
  matches: boolean;
}

/**
 * Compares a computed rate against the stored `calculated_unit_rate`.
 *
 * The API surfaces this instead of silently overwriting. ADR-001 Q2 requires
 * that service code `S00167401` keeps its historical 27.9158 even though a
 * recomputation yields 27.8639, because invoice INV-2026-03-0042 already billed
 * at the stored rate. Callers decide what to do with a mismatch.
 */
/**
 * Rate at which two unit rates are considered equal.
 *
 * 0.00005 ZAR is a twentieth of a cent, which is well below the 4dp precision
 * these rates carry yet well above the ~1e-15 noise of binary floating point.
 * Using a half-cent threshold here would wrongly report a genuine 0.0001 ZAR
 * difference as a match.
 */
export const RATE_MATCH_EPSILON = 0.00005;

export function compareWithStored(computed: number, stored: number | string): RateVariance {
  const storedNumber = toNumber(stored, 'stored');
  const delta = roundRate(computed - storedNumber, 'delta');
  return {
    computed,
    stored: storedNumber,
    delta,
    matches: Math.abs(computed - storedNumber) <= RATE_MATCH_EPSILON,
  };
}
