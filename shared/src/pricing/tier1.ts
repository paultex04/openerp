/**
 * Tier 1 — hourly labour rate build-up.
 *
 * Specification:
 *
 *   Man in Pocket     = Base Rate x (1 + Wage Premium %)
 *   Base Direct Labour= Man in Pocket + Leave Pay + Total Statutory Costs
 *   Overhead Cost     = (Base Direct Labour + Equipment Cost) x Operational Overhead %
 *   SG&A Cost         = (Base Direct Labour + Equipment Cost + Overhead Cost) x SG&A %
 *   Profit Cost       = (Base Direct Labour + Equipment Cost + Overhead Cost + SG&A Cost
 *                        + PPE Cost + Transport Cost) x Profit %
 *   Full Loaded Rate  = Direct Labour + Equipment + PPE + Transport + Overhead + SG&A + Profit
 *
 * IMPORTANT — overheads policy (see ADR-001, decision Q1):
 *
 * The published reference vector for Artisan Electrical is 227.61 ZAR/hr. That
 * figure is **only** reproducible if `overhead_cost` and `sga_cost` are treated
 * as authoritative stored inputs. Recomputing them from
 * `contract_cost_parameters` (which says 7% and 15%) yields 226.72, because the
 * baseline data actually implies roughly 8.2% overhead.
 *
 * Therefore this module supports two policies and defaults to the authoritative
 * one:
 *
 *   - `authoritative` (default) — the caller supplies overhead and SG&A. Used
 *     when editing or validating an existing rate card.
 *   - `derived` — the caller supplies overhead and SG&A *fractions*, which come
 *     from `contract_cost_parameters`. Used only when building a NEW rate card,
 *     so the parameters still act as the default template.
 *
 * `profit_cost` and `full_loaded_rate` are always derived.
 *
 * Percentage convention: every `*Pct` input is a **fraction**, not a percentage.
 * 0.07 means 7%. This matches how the baseline database stores its `*_pct`
 * columns (e.g. `wage_premium_pct = 0.0050` for 0.5%).
 */
import { applyFraction, roundMoney, roundRate, sumExact, toNumber } from '../money';

export interface Tier1BaseInputs {
  /**
   * Negotiated rate. Takes precedence over `councilRate` when present, because a
   * custom rate is the rate actually agreed with the client for that contract.
   */
  customRate?: number | string | null;
  /** Bargaining council / industry rate, used when there is no custom rate. */
  councilRate?: number | string | null;
  /** Wage premium as a fraction: 0.005 = 0.5%. */
  wagePremiumPct: number | string;
  leavePay: number | string;
  totalStatutoryCost: number | string;
  ppeCost: number | string;
  transportCost: number | string;
  equipmentCost: number | string;
  /** Fair profit margin as a fraction: 0.095 = 9.5%. */
  profitPct: number | string;
}

/** Overheads are supplied as authoritative amounts. Default policy. */
export interface AuthoritativeOverheads {
  mode: 'authoritative';
  overheadCost: number | string;
  sgaCost: number | string;
}

/** Overheads are derived from the amendment's cost parameters. */
export interface DerivedOverheads {
  mode: 'derived';
  /** Operational overhead as a fraction: 0.07 = 7%. */
  overheadPct: number | string;
  /** SG&A as a fraction: 0.15 = 15%. */
  sgaPct: number | string;
}

export type Tier1OverheadPolicy = AuthoritativeOverheads | DerivedOverheads;

export interface Tier1Result {
  /** The rate the premium was applied to (custom if set, else council). */
  baseRate: number;
  /** Which input supplied `baseRate`. */
  baseRateSource: 'custom' | 'council';
  manInPocket: number;
  baseDirectLabour: number;
  overheadCost: number;
  sgaCost: number;
  profitCost: number;
  fullLoadedRate: number;
}

export class RateBuildupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateBuildupError';
  }
}

/**
 * Picks the rate the wage premium applies to.
 *
 * `customRate` wins when present. The baseline data never populates both, so
 * this ordering is not observable against the existing rows; it is documented
 * because new rate cards can carry both.
 */
export function resolveBaseRate(inputs: Pick<Tier1BaseInputs, 'customRate' | 'councilRate'>): {
  baseRate: number;
  source: 'custom' | 'council';
} {
  const custom = inputs.customRate;
  const council = inputs.councilRate;

  const hasCustom = custom !== null && custom !== undefined && custom !== '';
  const hasCouncil = council !== null && council !== undefined && council !== '';

  if (!hasCustom && !hasCouncil) {
    throw new RateBuildupError(
      'A rate card requires either a council rate or a custom rate; both were empty.',
    );
  }

  return hasCustom
    ? { baseRate: toNumber(custom as string, 'customRate'), source: 'custom' }
    : { baseRate: toNumber(council as string, 'councilRate'), source: 'council' };
}

/** Man in Pocket = Base Rate x (1 + Wage Premium %). */
export function computeManInPocket(
  baseRate: number | string,
  wagePremiumPct: number | string,
): number {
  return toNumber(baseRate, 'baseRate') * (1 + toNumber(wagePremiumPct, 'wagePremiumPct'));
}

/** Base Direct Labour = Man in Pocket + Leave Pay + Total Statutory Costs. */
export function computeBaseDirectLabour(
  manInPocket: number | string,
  leavePay: number | string,
  totalStatutoryCost: number | string,
): number {
  return sumExact([manInPocket, leavePay, totalStatutoryCost], 'baseDirectLabour');
}

/**
 * Overhead Cost = (Base Direct Labour + Equipment) x Operational Overhead %.
 *
 * Exposed separately so the build-up sheet can show the derivation even when the
 * authoritative policy is in force.
 */
export function deriveOverheadCost(
  baseDirectLabour: number | string,
  equipmentCost: number | string,
  overheadPct: number | string,
): number {
  return applyFraction(
    toNumber(baseDirectLabour, 'baseDirectLabour') + toNumber(equipmentCost, 'equipmentCost'),
    overheadPct,
  );
}

/** SG&A Cost = (Base Direct Labour + Equipment + Overhead) x SG&A %. */
export function deriveSgaCost(
  baseDirectLabour: number | string,
  equipmentCost: number | string,
  overheadCost: number | string,
  sgaPct: number | string,
): number {
  return applyFraction(
    sumExact([baseDirectLabour, equipmentCost, overheadCost], 'sgaBase'),
    sgaPct,
  );
}

/** Profit Cost = (BDL + Equipment + OH + SG&A + PPE + Transport) x Profit %. */
export function computeProfitCost(
  baseDirectLabour: number | string,
  equipmentCost: number | string,
  overheadCost: number | string,
  sgaCost: number | string,
  ppeCost: number | string,
  transportCost: number | string,
  profitPct: number | string,
): number {
  return applyFraction(
    sumExact(
      [baseDirectLabour, equipmentCost, overheadCost, sgaCost, ppeCost, transportCost],
      'profitBase',
    ),
    profitPct,
  );
}

/**
 * Full Tier 1 build-up.
 *
 * Intermediates are kept at full precision and rounded once per output value,
 * which is what reproduces the baseline figures (see ADR-001 F1).
 */
export function computeFullLoadedRate(
  inputs: Tier1BaseInputs,
  policy: Tier1OverheadPolicy,
): Tier1Result {
  const { baseRate, source } = resolveBaseRate(inputs);

  const manInPocket = computeManInPocket(baseRate, inputs.wagePremiumPct);
  const baseDirectLabour = computeBaseDirectLabour(
    manInPocket,
    inputs.leavePay,
    inputs.totalStatutoryCost,
  );
  const equipmentCost = toNumber(inputs.equipmentCost, 'equipmentCost');

  const overheadCost =
    policy.mode === 'authoritative'
      ? toNumber(policy.overheadCost, 'overheadCost')
      : deriveOverheadCost(baseDirectLabour, equipmentCost, policy.overheadPct);

  const sgaCost =
    policy.mode === 'authoritative'
      ? toNumber(policy.sgaCost, 'sgaCost')
      : deriveSgaCost(baseDirectLabour, equipmentCost, overheadCost, policy.sgaPct);

  const profitCost = computeProfitCost(
    baseDirectLabour,
    equipmentCost,
    overheadCost,
    sgaCost,
    inputs.ppeCost,
    inputs.transportCost,
    inputs.profitPct,
  );

  const fullLoadedRate = sumExact(
    [
      baseDirectLabour,
      equipmentCost,
      inputs.ppeCost,
      inputs.transportCost,
      overheadCost,
      sgaCost,
      profitCost,
    ],
    'fullLoadedRate',
  );

  return {
    baseRate: roundMoney(baseRate, 'baseRate'),
    baseRateSource: source,
    manInPocket: roundMoney(manInPocket, 'manInPocket'),
    baseDirectLabour: roundMoney(baseDirectLabour, 'baseDirectLabour'),
    overheadCost: roundMoney(overheadCost, 'overheadCost'),
    sgaCost: roundMoney(sgaCost, 'sgaCost'),
    profitCost: roundMoney(profitCost, 'profitCost'),
    fullLoadedRate: roundMoney(fullLoadedRate, 'fullLoadedRate'),
  };
}

/**
 * What the rate *would* be if overheads were derived from the amendment's
 * parameters rather than taken from the stored card.
 *
 * Used by the rate build-up sheet to expose the ADR-001 F2 divergence instead of
 * hiding it: a QS can see that deriving would move Artisan Electrical from
 * 227.61 to 226.72 and decide deliberately.
 */
export function compareAgainstDerived(
  inputs: Tier1BaseInputs,
  authoritativeOverheadCost: number | string,
  authoritativeSgaCost: number | string,
  overheadPct: number | string,
  sgaPct: number | string,
): {
  authoritative: Tier1Result;
  derived: Tier1Result;
  /** derived - authoritative. Negative means deriving would LOWER the rate. */
  fullLoadedRateDelta: number;
} {
  const authoritative = computeFullLoadedRate(inputs, {
    mode: 'authoritative',
    overheadCost: authoritativeOverheadCost,
    sgaCost: authoritativeSgaCost,
  });
  const derived = computeFullLoadedRate(inputs, { mode: 'derived', overheadPct, sgaPct });

  return {
    authoritative,
    derived,
    fullLoadedRateDelta: roundRate(
      derived.fullLoadedRate - authoritative.fullLoadedRate,
      'fullLoadedRateDelta',
    ),
  };
}

/**
 * Same comparison, but taking the authoritative overheads from the caller's own
 * computed result rather than requiring them to be restated.
 *
 * Used by the API when the caller asked to *derive*: in that case the
 * authoritative baseline is the stored card, which the server holds, not
 * whatever the request happened to send.
 */
export function compareComputedAgainstDerived(
  inputs: Tier1BaseInputs,
  storedOverheadCost: number | string,
  storedSgaCost: number | string,
  overheadPct: number | string,
  sgaPct: number | string,
): {
  authoritative: Tier1Result;
  derived: Tier1Result;
  fullLoadedRateDelta: number;
} {
  return compareAgainstDerived(inputs, storedOverheadCost, storedSgaCost, overheadPct, sgaPct);
}

/**
 * Reads a `contract_cost_parameters` set for one amendment into the shape the
 * derived policy needs.
 *
 * Falls back to `undefined` for absent parameters so the caller can decide
 * whether to fail or fall back to authoritative values; it does not invent
 * defaults.
 */
export interface CostParameterRow {
  category: string;
  parameterName: string;
  numericValue: number | string;
}

export interface AmendmentCostParameters {
  overheadPct?: number;
  sgaPct?: number;
  profitPct?: number;
  equipmentHourlyRate?: number;
  ppePerHour?: number;
  transportHourlyRate?: number;
  r1MaterialMarkupPct?: number;
}

export const COST_PARAMETER_NAMES = {
  overheadPct: 'Operational Overhead %',
  sgaPct: 'SG&A %',
  profitPct: 'Fair Profit Margin %',
  equipmentHourlyRate: 'EC&I Equipment Hourly Rate',
  ppePerHour: 'PPE Cost per Hour',
  transportHourlyRate: 'Transport Hourly Rate',
  r1MaterialMarkupPct: 'R1 Material Markup %',
} as const;

export type CostParameterKey = keyof typeof COST_PARAMETER_NAMES;

/**
 * Parameters the baseline stores as a **percent number** rather than a fraction.
 *
 * The database is inconsistent about percentage units, and reading these wrong
 * is catastrophic rather than cosmetic — treating 9.5 as a fraction inflates the
 * full loaded rate roughly tenfold. Observed values:
 *
 *   contract_cost_parameters.numeric_value  'Fair Profit Margin %'  =  9.500000 (9.5%)
 *   service_master_rates.wage_premium_pct                          =  0.0050   (0.5%)
 *   contract_cost_parameters.numeric_value  'R1 Material Markup %'  = 10.000000 (10%)
 *   service_code.material_markup_pct                               =  0.1000   (10%)
 *
 * So a percentage held in `numeric_value` is a percent number, whereas any column
 * literally named `*_pct` is already a fraction. This set is the explicit bridge:
 * values are divided by 100 on read so the engine only ever sees fractions.
 */
const PERCENT_NUMBER_KEYS: ReadonlySet<CostParameterKey> = new Set<CostParameterKey>([
  'overheadPct',
  'sgaPct',
  'profitPct',
  'r1MaterialMarkupPct',
]);

export function readCostParameters(rows: readonly CostParameterRow[]): AmendmentCostParameters {
  const byName = new Map(rows.map((r) => [r.parameterName, Number(r.numericValue)]));
  const out: AmendmentCostParameters = {};

  for (const [key, parameterName] of Object.entries(COST_PARAMETER_NAMES) as [
    CostParameterKey,
    string,
  ][]) {
    const raw = byName.get(parameterName);
    if (raw === undefined || !Number.isFinite(raw)) continue;

    // Normalise percent numbers down to fractions.
    out[key] = PERCENT_NUMBER_KEYS.has(key) ? raw / 100 : raw;
  }
  return out;
}
