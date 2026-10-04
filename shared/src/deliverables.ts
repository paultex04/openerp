/**
 * Job deliverable (job_service_code) mathematics.
 *
 * A deliverable pairs a service code with a scoped quantity and an **immutable
 * price snapshot**:
 *
 *   applied_rate      the service code's unit rate at the moment of scoping
 *   planned_subtotal  planned_quantity x applied_rate
 *   actual_subtotal   actual_quantity  x applied_rate
 *
 * ## Why the snapshot matters
 *
 * `applied_rate` is a snapshot, never a live join to the service code. Two
 * reasons, and both are contractual:
 *
 *  1. If a service code's rate were read live, re-pricing it tomorrow would
 *     silently rewrite every job already scoped and invoiced against it.
 *  2. Phase 4 copies `applied_rate` into invoice lines, so the figure that was
 *     invoiced must remain reproducible for the life of the invoice.
 *
 * The Phase 3 acceptance criterion "changing a master service rate does not
 * retroactively mutate applied_rate or historical subtotals" is satisfied
 * structurally: nothing in this module reads a service code's current rate.
 */
import { roundMoney, roundRate } from './money.js';

export interface DeliverableLine {
  plannedQuantity: number | string;
  actualQuantity: number | string;
  /** Immutable price snapshot, in ZAR per unit. */
  appliedRate: number | string;
  /** Present for variance reporting only; never used to compute a subtotal. */
  currentServiceCodeRate?: number | string | null;
}

export interface DeliverableTotals {
  plannedQuantity: number;
  actualQuantity: number;
  plannedSubtotal: number;
  actualSubtotal: number;
  /** actual - planned. Negative means under-recovered against plan. */
  quantityVariance: number;
  /** actual_subtotal - planned_subtotal, in ZAR. */
  valueVariance: number;
  /**
   * True when the current service code rate differs from the applied snapshot.
   *
   * Purely informational: the snapshot stays authoritative regardless. Surfaced
   * so a QS can see that a rate card moved after this job was scoped.
   */
  rateHasDrifted: boolean;
  currentRate: number | null;
}

export function computeDeliverableTotals(line: DeliverableLine): DeliverableTotals {
  const plannedQuantity = Number(line.plannedQuantity) || 0;
  const actualQuantity = Number(line.actualQuantity) || 0;
  const appliedRate = Number(line.appliedRate) || 0;

  // Both subtotals use the SAME snapshot rate. Recomputing the applied rate
  // from the service code here would be the bug this module exists to prevent.
  const plannedSubtotal = roundMoney(plannedQuantity * appliedRate);
  const actualSubtotal = roundMoney(actualQuantity * appliedRate);

  const currentRate =
    line.currentServiceCodeRate === null || line.currentServiceCodeRate === undefined
      ? null
      : roundRate(line.currentServiceCodeRate);

  return {
    plannedQuantity,
    actualQuantity,
    plannedSubtotal,
    actualSubtotal,
    quantityVariance: roundRate(actualQuantity - plannedQuantity),
    valueVariance: roundMoney(actualSubtotal - plannedSubtotal),
    rateHasDrifted: currentRate !== null && Math.abs(currentRate - appliedRate) > 0.00005,
    currentRate,
  };
}

/** Sums per-deliverable totals for a job. */
export function aggregateTotals(lines: readonly DeliverableTotals[]): {
  plannedSubtotal: number;
  actualSubtotal: number;
  valueVariance: number;
  lineCount: number;
  /** Deliverables where an actual quantity has been recorded. */
  linesWithActuals: number;
  /** Deliverables whose actual quantity exceeds the plan. */
  linesOverrun: number;
} {
  let plannedSubtotal = 0;
  let actualSubtotal = 0;
  let linesWithActuals = 0;
  let linesOverrun = 0;

  for (const line of lines) {
    plannedSubtotal += line.plannedSubtotal;
    actualSubtotal += line.actualSubtotal;
    if (line.actualQuantity > 0) linesWithActuals++;
    if (line.actualQuantity > line.plannedQuantity) linesOverrun++;
  }

  return {
    plannedSubtotal: roundMoney(plannedSubtotal),
    actualSubtotal: roundMoney(actualSubtotal),
    valueVariance: roundMoney(actualSubtotal - plannedSubtotal),
    lineCount: lines.length,
    linesWithActuals,
    linesOverrun,
  };
}

/**
 * Which field of a deliverable the caller is trying to change, and whether that
 * is permitted at the job's current status.
 *
 * Returned as a discriminated result so the API can answer 403 with a precise
 * reason instead of a generic refusal.
 */
export type DeliverableField = 'plannedQuantity' | 'actualQuantity' | 'appliedRate';

export interface FieldGuardResult {
  allowed: boolean;
  field: DeliverableField;
  reason: string;
}
