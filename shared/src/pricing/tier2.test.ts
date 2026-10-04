/**
 * Tier 2 acceptance vectors, including the mandated `S00247970` recipe.
 */
import { describe, expect, it } from 'vitest';
import {
  compareWithStored,
  computeActivityRate,
  computeMaterialRate,
  computeServiceCodeRate,
  type LabourRecipeLine,
} from './tier2';

/**
 * S00247970 — "Remove, Cable (All Cores) Electrical & Instrumentation;
 * 1.5mm - 16mm", UOM M, unit rate 17.5226 ZAR/m.
 *
 * Verbatim from `service_code_labour_item` ids 1-4 joined to
 * `service_master_rates` for amendment 1.
 */
const S00247970_RECIPE: LabourRecipeLine[] = [
  { crewQuantity: 1, hoursPerUnit: 0.01, fullLoadedRate: 227.61 }, // Artisan Electrical
  { crewQuantity: 1, hoursPerUnit: 0.01, fullLoadedRate: 88.39 }, // Labourer
  { crewQuantity: 1, hoursPerUnit: 0.02, fullLoadedRate: 397.18 }, // Electrical Supervisor
  { crewQuantity: 1, hoursPerUnit: 0.02, fullLoadedRate: 320.95 }, // Safety Officer
];

describe('Tier 2 reference vector: S00247970 cable removal', () => {
  it('produces the published unit rate of 17.5226 ZAR/m', () => {
    const result = computeActivityRate(S00247970_RECIPE);
    expect(result.calculatedUnitRate).toBe(17.5226);
  });

  it('produces the exact stored line subtotals', () => {
    const result = computeActivityRate(S00247970_RECIPE);
    expect(result.lines.map((l) => l.lineSubtotal)).toEqual([2.2761, 0.8839, 7.9436, 6.419]);
  });

  it('reports total crew hours per unit', () => {
    // 0.01 + 0.01 + 0.02 + 0.02 = 0.06 crew-hours per metre.
    expect(computeActivityRate(S00247970_RECIPE).totalHoursPerUnit).toBeCloseTo(0.06, 10);
  });

  it('agrees with the stored rate', () => {
    const computed = computeActivityRate(S00247970_RECIPE).calculatedUnitRate;
    expect(compareWithStored(computed, 17.5226).matches).toBe(true);
  });
});

describe('S00167401 — the ADR-001 Q2 preserved discrepancy', () => {
  /**
   * Labour line id 8 (Safety Officer) stores line_subtotal 9.6804, but
   * 1 x 0.03 x 320.95 = 9.6285. The stored rollup of 27.9158 inherits it.
   *
   * Decision: preserve the stored rate, never silently overwrite it.
   */
  const S00167401_RECIPE: LabourRecipeLine[] = [
    { crewQuantity: 1, hoursPerUnit: 0.02, fullLoadedRate: 227.61 }, // 4.5522
    { crewQuantity: 1, hoursPerUnit: 0.02, fullLoadedRate: 88.39 }, // 1.7678
    { crewQuantity: 1, hoursPerUnit: 0.03, fullLoadedRate: 397.18 }, // 11.9154
    { crewQuantity: 1, hoursPerUnit: 0.03, fullLoadedRate: 320.95 }, // 9.6285
  ];

  it('computes 27.8639, which differs from the stored 27.9158', () => {
    const computed = computeActivityRate(S00167401_RECIPE).calculatedUnitRate;
    expect(computed).toBe(27.8639);
    expect(computed).not.toBe(27.9158);
  });

  it('surfaces the variance rather than hiding it', () => {
    const computed = computeActivityRate(S00167401_RECIPE).calculatedUnitRate;
    const variance = compareWithStored(computed, 27.9158);

    expect(variance.matches).toBe(false);
    expect(variance.delta).toBeCloseTo(-0.0519, 4);
    expect(variance.stored).toBe(27.9158);
  });

  it('matches when the stored rate agrees', () => {
    const computed = computeActivityRate(S00247970_RECIPE).calculatedUnitRate;
    expect(compareWithStored(computed, 17.5226).matches).toBe(true);
  });
});

describe('activity pricing behaviour', () => {
  it('prices a single-role recipe', () => {
    const result = computeActivityRate([
      { crewQuantity: 2, hoursPerUnit: 1.5, fullLoadedRate: 100 },
    ]);
    expect(result.lines[0]!.lineSubtotal).toBe(300);
    expect(result.calculatedUnitRate).toBe(300);
  });

  it('handles an empty recipe as zero rather than NaN', () => {
    const result = computeActivityRate([]);
    expect(result.calculatedUnitRate).toBe(0);
    expect(result.lines).toEqual([]);
    expect(Number.isNaN(result.calculatedUnitRate)).toBe(false);
  });

  it('keeps sub-cent precision to 4dp', () => {
    const result = computeActivityRate([
      { crewQuantity: 1, hoursPerUnit: 0.0001, fullLoadedRate: 88.39 },
    ]);
    // 0.0001 x 88.39 = 0.008839 -> 0.0088 at 4dp
    expect(result.lines[0]!.lineSubtotal).toBe(0.0088);
    expect(result.calculatedUnitRate).toBe(0.0088);
  });

  it('accepts Decimal strings for rates and quantities', () => {
    const result = computeActivityRate([
      { crewQuantity: '1.00', hoursPerUnit: '0.0100', fullLoadedRate: '227.61' },
    ]);
    expect(result.lines[0]!.lineSubtotal).toBe(2.2761);
  });

  it('sums rounded lines, matching how the baseline rollups were built', () => {
    // Two lines each 0.0088 round to 0.0176, not 0.0176 from 0.008839 x 2.
    const result = computeActivityRate([
      { crewQuantity: 1, hoursPerUnit: 0.0001, fullLoadedRate: 88.39 },
      { crewQuantity: 1, hoursPerUnit: 0.0001, fullLoadedRate: 88.39 },
    ]);
    expect(result.calculatedUnitRate).toBe(0.0176);
  });
});

describe('R1 material pricing', () => {
  /**
   * R1-CABLE-SUPPLY-01 — the three stored BOM lines:
   *   185.00 x 100 = 18 500.0000
   *   142.00 x  12 =  1 704.0000
   *    29.50 x  48 =  1 416.0000
   *   subtotal     = 21 620.0000, x 1.10 = 23 782.0000
   */
  const R1_BOM = [
    { unitCost: 185, quantity: 100 },
    { unitCost: 142, quantity: 12 },
    { unitCost: 29.5, quantity: 48 },
  ];

  it('applies the 10% R1 markup to the procurement subtotal', () => {
    const result = computeMaterialRate(R1_BOM, 0.1);
    expect(result.subtotalCost).toBe(21620);
    expect(result.markupAmount).toBe(2162);
    expect(result.calculatedUnitRate).toBe(23782);
  });

  it('produces the stored line subtotals', () => {
    expect(computeMaterialRate(R1_BOM, 0.1).lines.map((l) => l.subtotalCost)).toEqual([
      18500, 1704, 1416,
    ]);
  });

  it('is case-insensitive on the category it dispatches', () => {
    const result = computeServiceCodeRate('R1 Material', {
      materialLines: R1_BOM,
      materialMarkupPct: 0.1,
    });
    expect(result.calculatedUnitRate).toBe(23782);
  });

  it('defaults the markup to zero when unspecified', () => {
    expect(computeMaterialRate(R1_BOM, 0).calculatedUnitRate).toBe(21620);
    expect(computeMaterialRate(R1_BOM, 0).markupAmount).toBe(0);
  });

  it('handles an empty BOM', () => {
    const result = computeMaterialRate([], 0.15);
    expect(result.calculatedUnitRate).toBe(0);
    expect(Number.isNaN(result.calculatedUnitRate)).toBe(false);
  });
});

describe('category dispatch', () => {
  it('routes Activity to the labour engine', () => {
    const result = computeServiceCodeRate('Activity', { labourLines: S00247970_RECIPE });
    expect(result.category).toBe('Activity');
    expect(result.calculatedUnitRate).toBe(17.5226);
  });

  it('treats a missing line collection as an empty recipe', () => {
    expect(computeServiceCodeRate('Activity', {}).calculatedUnitRate).toBe(0);
    expect(computeServiceCodeRate('R1 Material', {}).calculatedUnitRate).toBe(0);
  });
});
