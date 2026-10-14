/**
 * Server-side pricing service.
 *
 * Thin orchestration over the pure engines in `@openerp/shared`: this module
 * owns the database reads/writes and the decisions, while `shared` owns the
 * arithmetic. That split is what lets the client render an identical inline
 * preview using the same code that produced the persisted figure.
 *
 * Two behaviours are load-bearing and must not be "simplified":
 *
 *  1. `overheadCost` / `sgaCost` on a rate card are authoritative once written
 *     (ADR-001 Q1). They are only derived from the amendment's parameters when
 *     a caller explicitly asks to derive.
 *  2. Recomputing a service code **never** silently overwrites a stored rate
 *     that disagrees (ADR-001 Q2). It returns the variance so the caller can
 *     decide.
 */
import type { Prisma } from '../generated/prisma/client.js';
import type { ServiceCodeCategory, ShiftType } from '../generated/prisma/enums.js';
import { prisma } from '../db/client.js';
import {
  compareWithStored,
  computeActivityRate,
  computeFullLoadedRate,
  computeMaterialRate,
  compareAgainstDerived,
  readCostParameters,
  roundMoney,
  serviceCodeCategoryToLabel,
  roundRate,
  type RateVariance,
  type Tier1BaseInputs,
  type Tier1OverheadPolicy,
  type Tier1Result,
} from '@openerp/shared';

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Converts a Prisma `Decimal` to a JSON-safe number.
 *
 * Decimal serialises inconsistently across versions, so every monetary and rate
 * field is converted explicitly rather than relying on `JSON.stringify`.
 */
export function num(value: { toNumber(): number } | null | undefined): number | null {
  return value === null || value === undefined ? null : value.toNumber();
}

// ---------------------------------------------------------------------------
// Cost parameters
// ---------------------------------------------------------------------------

export async function loadAmendmentCostParameters(amendmentId: number) {
  const rows = await prisma.contractCostParameter.findMany({
    where: { amendmentId },
    select: { category: true, parameterName: true, numericValue: true },
  });
  return readCostParameters(rows.map((r) => ({ ...r, numericValue: r.numericValue.toString() })));
}

// ---------------------------------------------------------------------------
// Tier 1
// ---------------------------------------------------------------------------

/** The subset of a `service_master_rates` row the engine needs. */
interface RateCardRow {
  councilRate: Prisma.Decimal | null;
  customRate: Prisma.Decimal | null;
  wagePremiumPct: Prisma.Decimal;
  leavePay: Prisma.Decimal;
  totalStatutoryCost: Prisma.Decimal;
  ppeCost: Prisma.Decimal;
  transportCost: Prisma.Decimal;
  equipmentCost: Prisma.Decimal;
  overheadCost: Prisma.Decimal;
  sgaCost: Prisma.Decimal;
}

function toTier1Inputs(row: RateCardRow, profitPct: number): Tier1BaseInputs {
  return {
    councilRate: row.councilRate?.toString() ?? null,
    customRate: row.customRate?.toString() ?? null,
    wagePremiumPct: row.wagePremiumPct.toString(),
    leavePay: row.leavePay.toString(),
    totalStatutoryCost: row.totalStatutoryCost.toString(),
    ppeCost: row.ppeCost.toString(),
    transportCost: row.transportCost.toString(),
    equipmentCost: row.equipmentCost.toString(),
    profitPct,
  };
}

/**
 * Resolves the profit margin fraction.
 *
 * The baseline `service_master_rates` table has no `profit_pct` column — margin
 * lives only in `contract_cost_parameters` (`Fair Profit Margin %`). Where that
 * parameter is absent the rate is **not** recomputed, because doing so would
 * silently produce a zero-profit figure. Callers get an explicit error instead.
 */
async function resolveProfitPct(amendmentId: number): Promise<number> {
  const params = await loadAmendmentCostParameters(amendmentId);
  if (params.profitPct === undefined) {
    throw new PricingConfigurationError(
      `Amendment ${amendmentId} has no "Fair Profit Margin %" cost parameter, so ` +
        'profit and full loaded rate cannot be derived. Add the parameter first.',
    );
  }
  return params.profitPct;
}

/**
 * Computes a rate card using its stored authoritative overheads.
 *
 * This is the path used whenever an existing rate card is validated or
 * displayed, and it reproduces the published 227.61 ZAR/hr vector.
 */
export async function computeRateCard(rateId: number): Promise<Tier1Result> {
  const card = await prisma.serviceMasterRate.findUniqueOrThrow({
    where: { id: rateId },
    select: {
      amendmentId: true,
      councilRate: true,
      customRate: true,
      wagePremiumPct: true,
      leavePay: true,
      totalStatutoryCost: true,
      ppeCost: true,
      transportCost: true,
      equipmentCost: true,
      overheadCost: true,
      sgaCost: true,
    },
  });

  const profitPct = await resolveProfitPct(card.amendmentId);

  return computeFullLoadedRate(toTier1Inputs(card, profitPct), {
    mode: 'authoritative',
    overheadCost: card.overheadCost.toString(),
    sgaCost: card.sgaCost.toString(),
  });
}

export class PricingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingConfigurationError';
  }
}

export interface UpsertRateCardInput {
  amendmentId: number;
  serviceMasterCode: string;
  labourType: string;
  shiftType: string;
  uom?: string;
  bargainingCouncilDesc?: string | null;
  councilRate?: number | null;
  customRate?: number | null;
  wagePremiumPct: number;
  leavePay: number;
  totalStatutoryCost: number;
  ppeCost: number;
  transportCost: number;
  equipmentCost: number;
  profitPct: number;
  /** Supplied amounts; ignored when `deriveOverheads` is true. */
  overheadCost?: number | null;
  sgaCost?: number | null;
  /** Used to derive overheads when `deriveOverheads` is true. */
  overheadPct?: number;
  sgaPct?: number;
  deriveOverheads: boolean;
  id?: number;
}

export interface RateCardWriteResult {
  id: number;
  computed: Tier1Result;
  policy: Tier1OverheadPolicy;
  /**
   * Present when both policies are computable: the rate as persisted
   * (`authoritative`) against what deriving from the amendment's parameters
   * would give (`derived`), and the difference.
   */
  derivedComparison?: {
    authoritative: Tier1Result;
    derived: Tier1Result;
    fullLoadedRateDelta: number;
  };
}

/**
 * Creates or updates a rate card and persists the computed build-up.
 *
 * `deriveOverheads` decides where overhead and SG&A come from. It defaults to
 * false so that an ordinary edit preserves the authoritative stored figures; a
 * QS must ask for a re-derivation explicitly, which keeps the ADR-001 F2
 * divergence a conscious decision.
 */
export async function saveRateCard(input: UpsertRateCardInput): Promise<RateCardWriteResult> {
  const params = await loadAmendmentCostParameters(input.amendmentId);

  const effectiveOverheadPct = input.overheadPct ?? params.overheadPct;
  const effectiveSgaPct = input.sgaPct ?? params.sgaPct;

  // Seed a brand new card from the amendment parameters when the caller did not
  // supply authoritative amounts.
  const hasAuthoritativeAmounts =
    input.overheadCost !== null &&
    input.overheadCost !== undefined &&
    input.sgaCost !== null &&
    input.sgaCost !== undefined;

  if (!hasAuthoritativeAmounts && effectiveOverheadPct === undefined) {
    throw new PricingConfigurationError(
      `Amendment ${input.amendmentId} has no "Operational Overhead %" parameter, and no ` +
        'authoritative overhead cost was supplied. Provide overheadCost/sgaCost, or add the ' +
        'parameter to the amendment.',
    );
  }

  const provisional = {
    councilRate: input.councilRate ?? null,
    customRate: input.customRate ?? null,
    wagePremiumPct: input.wagePremiumPct,
    leavePay: input.leavePay,
    totalStatutoryCost: input.totalStatutoryCost,
    ppeCost: input.ppeCost,
    transportCost: input.transportCost,
    equipmentCost: input.equipmentCost,
    profitPct: input.profitPct,
  };

  const policy: Tier1OverheadPolicy = input.deriveOverheads
    ? {
        mode: 'derived',
        overheadPct: effectiveOverheadPct ?? 0,
        sgaPct: effectiveSgaPct ?? 0,
      }
    : {
        mode: 'authoritative',
        overheadCost: input.overheadCost ?? 0,
        sgaCost: input.sgaCost ?? 0,
      };

  const computed = computeFullLoadedRate(provisional, policy);

  const data = {
    amendmentId: input.amendmentId,
    serviceMasterCode: input.serviceMasterCode,
    labourType: input.labourType,
    shiftType: input.shiftType as ShiftType,
    uom: input.uom ?? 'per Hour',
    bargainingCouncilDesc: input.bargainingCouncilDesc ?? null,
    councilRate: input.councilRate ?? null,
    customRate: input.customRate ?? null,
    wagePremiumPct: input.wagePremiumPct,
    manInPocket: computed.manInPocket,
    leavePay: input.leavePay,
    totalStatutoryCost: input.totalStatutoryCost,
    ppeCost: input.ppeCost,
    transportCost: input.transportCost,
    equipmentCost: input.equipmentCost,
    overheadCost: computed.overheadCost,
    sgaCost: computed.sgaCost,
    profitCost: computed.profitCost,
    fullLoadedRate: computed.fullLoadedRate,
  } as const;

  const saved = input.id
    ? await prisma.serviceMasterRate.update({ where: { id: input.id }, data, select: { id: true } })
    : await prisma.serviceMasterRate.create({ data, select: { id: true } });

  // Offer the ADR-001 F2 comparison whenever both policies are available.
  let derivedComparison: RateCardWriteResult['derivedComparison'];
  if (effectiveOverheadPct !== undefined && effectiveSgaPct !== undefined) {
    // The authoritative side is whatever was actually persisted: the supplied
    // amounts when not deriving, otherwise the just-derived values.
    const comparison = compareAgainstDerived(
      provisional,
      hasAuthoritativeAmounts && !input.deriveOverheads
        ? input.overheadCost!
        : computed.overheadCost,
      hasAuthoritativeAmounts && !input.deriveOverheads ? input.sgaCost! : computed.sgaCost,
      effectiveOverheadPct,
      effectiveSgaPct,
    );
    derivedComparison = {
      authoritative: comparison.authoritative,
      derived: comparison.derived,
      fullLoadedRateDelta: comparison.fullLoadedRateDelta,
    };
  }

  return { id: saved.id, computed, policy, derivedComparison };
}

/**
 * Resolves the stored authoritative overheads for a rate card on an amendment.
 *
 * Used only by the preview path, where the caller may be deriving overheads and
 * therefore cannot supply the authoritative amounts in the request.
 */
async function resolveStoredOverheads(
  amendmentId: number,
  serviceMasterCode: string,
  fallbackOverhead: number,
  fallbackSga: number,
): Promise<{ overheadCost: number; sgaCost: number }> {
  const stored = await prisma.serviceMasterRate.findFirst({
    where: { amendmentId, serviceMasterCode },
    orderBy: { id: 'asc' },
    select: { overheadCost: true, sgaCost: true },
  });

  if (stored) {
    return {
      overheadCost: stored.overheadCost.toNumber(),
      sgaCost: stored.sgaCost.toNumber(),
    };
  }

  // No stored card yet (previewing a brand new rate): fall back to whatever the
  // caller supplied, which for a new card is normally absent.
  return { overheadCost: fallbackOverhead, sgaCost: fallbackSga };
}

/**
 * Dry-run build-up for the interactive sheet: computes without persisting.
 */
export async function previewRateCard(inputs: UpsertRateCardInput): Promise<{
  computed: Tier1Result;
  derivedComparison?: RateCardWriteResult['derivedComparison'];
}> {
  const params = await loadAmendmentCostParameters(inputs.amendmentId);
  const overheadPct = inputs.overheadPct ?? params.overheadPct;
  const sgaPct = inputs.sgaPct ?? params.sgaPct;

  const provisional = {
    councilRate: inputs.councilRate ?? null,
    customRate: inputs.customRate ?? null,
    wagePremiumPct: inputs.wagePremiumPct,
    leavePay: inputs.leavePay,
    totalStatutoryCost: inputs.totalStatutoryCost,
    ppeCost: inputs.ppeCost,
    transportCost: inputs.transportCost,
    equipmentCost: inputs.equipmentCost,
    profitPct: inputs.profitPct,
  };

  const hasAmounts =
    inputs.overheadCost !== null &&
    inputs.overheadCost !== undefined &&
    inputs.sgaCost !== null &&
    inputs.sgaCost !== undefined;

  const computed = computeFullLoadedRate(
    provisional,
    hasAmounts && !inputs.deriveOverheads
      ? {
          mode: 'authoritative',
          overheadCost: inputs.overheadCost!,
          sgaCost: inputs.sgaCost!,
        }
      : { mode: 'derived', overheadPct: overheadPct ?? 0, sgaPct: sgaPct ?? 0 },
  );

  if (overheadPct === undefined || sgaPct === undefined) {
    return { computed };
  }

  const useAuthoritative = hasAmounts && !inputs.deriveOverheads;

  // The authoritative baseline is whatever was actually persisted. When the
  // caller asked to derive, the request's amounts are ignored, so the baseline
  // must come from the stored card — comparing the derived figures against
  // themselves would give a delta of zero and hide the ADR-001 F2 divergence.
  const baseline = useAuthoritative
    ? { overheadCost: inputs.overheadCost!, sgaCost: inputs.sgaCost! }
    : await resolveStoredOverheads(
        inputs.amendmentId,
        inputs.serviceMasterCode,
        inputs.overheadCost ?? 0,
        inputs.sgaCost ?? 0,
      );

  const comparison = compareAgainstDerived(
    provisional,
    baseline.overheadCost,
    baseline.sgaCost,
    overheadPct,
    sgaPct,
  );

  return {
    computed,
    derivedComparison: {
      authoritative: comparison.authoritative,
      derived: comparison.derived,
      fullLoadedRateDelta: comparison.fullLoadedRateDelta,
    },
  };
}

// ---------------------------------------------------------------------------
// Tier 2
// ---------------------------------------------------------------------------

export interface ServiceCodeComputation {
  serviceCodeId: number;
  category: ServiceCodeCategory;
  computed: number;
  variance: RateVariance;
  lines: Array<Record<string, unknown>>;
  subtotalCost?: number;
  markupAmount?: number;
  totalHoursPerUnit?: number;
}

/**
 * Recomputes a service code's unit rate from its recipe.
 *
 * **Does not persist.** Returns the variance against the stored rate so the
 * caller decides whether to accept it. This is what protects `S00167401` per
 * ADR-001 Q2.
 */
export async function computeServiceCode(
  serviceCodeId: number,
): Promise<ServiceCodeComputation | null> {
  const code = await prisma.serviceCode.findUnique({
    where: { id: serviceCodeId },
    select: {
      id: true,
      category: true,
      materialMarkupPct: true,
      calculatedUnitRate: true,
      labourItems: {
        select: {
          crewQuantity: true,
          hoursPerUnit: true,
          lineSubtotal: true,
          serviceMasterRate: { select: { fullLoadedRate: true } },
        },
      },
      materialItems: { select: { unitCost: true, quantity: true, subtotalCost: true } },
    },
  });

  if (!code) return null;

  if (code.category === 'R1_MATERIAL') {
    const result = computeMaterialRate(
      code.materialItems.map((i) => ({
        unitCost: i.unitCost.toString(),
        quantity: i.quantity.toString(),
      })),
      code.materialMarkupPct.toString(),
    );
    return {
      serviceCodeId: code.id,
      category: serviceCodeCategoryToLabel(code.category) as ServiceCodeCategory,
      computed: result.calculatedUnitRate,
      variance: compareWithStored(result.calculatedUnitRate, code.calculatedUnitRate.toString()),
      lines: result.lines as unknown as Array<Record<string, unknown>>,
      subtotalCost: result.subtotalCost,
      markupAmount: result.markupAmount,
    };
  }

  const result = computeActivityRate(
    code.labourItems.map((i) => ({
      crewQuantity: i.crewQuantity.toString(),
      hoursPerUnit: i.hoursPerUnit.toString(),
      fullLoadedRate: i.serviceMasterRate.fullLoadedRate.toString(),
    })),
  );

  return {
    serviceCodeId: code.id,
    category: serviceCodeCategoryToLabel(code.category) as ServiceCodeCategory,
    computed: result.calculatedUnitRate,
    variance: compareWithStored(result.calculatedUnitRate, code.calculatedUnitRate.toString()),
    lines: result.lines as unknown as Array<Record<string, unknown>>,
    totalHoursPerUnit: result.totalHoursPerUnit,
  };
}

/**
 * Recomputes a service code and, only if the caller insists, writes the result.
 *
 * `accept` must be explicit. With `accept: false` (the default) a mismatch is
 * reported and nothing is written.
 */
export async function applyServiceCodeRate(
  serviceCodeId: number,
  options: { accept: boolean },
): Promise<ServiceCodeComputation | null> {
  const computation = await computeServiceCode(serviceCodeId);
  if (!computation) return null;

  // Only an explicit `accept` writes. Otherwise the stored rate is left exactly
  // as it is and the variance is simply reported (ADR-001 Q2).
  if (options.accept) {
    await prisma.serviceCode.update({
      where: { id: serviceCodeId },
      data: { calculatedUnitRate: roundRate(computation.computed) },
    });
  }

  return computation;
}

/**
 * Rewrites every labour line subtotal and the service code rollup.
 *
 * Used when a rate card changes and the caller has accepted that dependent
 * service codes should follow. Still respects the store/compare contract for
 * the rollup itself.
 */
export async function refreshServiceCodeLines(
  serviceCodeId: number,
): Promise<ServiceCodeComputation | null> {
  const computation = await computeServiceCode(serviceCodeId);
  if (!computation) return null;

  const code = await prisma.serviceCode.findUniqueOrThrow({
    where: { id: serviceCodeId },
    select: { category: true, materialItems: true },
  });

  if (code.category === 'R1_MATERIAL') {
    await prisma.$transaction(
      code.materialItems.map((item, index) =>
        prisma.serviceCodeMaterialItem.update({
          where: { id: item.id },
          data: { subtotalCost: computation.lines[index]!['subtotalCost'] ?? item.subtotalCost },
        }),
      ),
    );
  } else {
    const items = await prisma.serviceCodeLabourItem.findMany({
      where: { serviceCodeId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    await prisma.$transaction(
      items.map((item, index) =>
        prisma.serviceCodeLabourItem.update({
          where: { id: item.id },
          data: { lineSubtotal: computation.lines[index]!['lineSubtotal'] ?? 0 },
        }),
      ),
    );
  }

  return computation;
}

export { roundMoney };
