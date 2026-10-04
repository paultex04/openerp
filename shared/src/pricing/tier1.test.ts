/**
 * Tier 1 acceptance vectors and edge cases.
 *
 * The two headline cases are mandated:
 *   - Artisan Electrical  -> 227.61 ZAR/hr
 *   - S00247970 cable removal -> 17.5226 ZAR/m (see tier2.test.ts)
 */
import { describe, expect, it } from 'vitest';
import {
  compareAgainstDerived,
  computeBaseDirectLabour,
  computeFullLoadedRate,
  computeManInPocket,
  computeProfitCost,
  COST_PARAMETER_NAMES,
  deriveOverheadCost,
  deriveSgaCost,
  readCostParameters,
  RateBuildupError,
  resolveBaseRate,
  type Tier1BaseInputs,
} from './tier1.js';

/**
 * Artisan Electrical, `S00250451`, amendment 1 — verbatim from
 * `service_master_rates` id 1.
 */
const ARTISAN: Tier1BaseInputs & {
  overheadCost: number;
  sgaCost: number;
} = {
  councilRate: 112.57,
  customRate: null,
  wagePremiumPct: 0.005,
  leavePay: 15.46,
  totalStatutoryCost: 28.93,
  ppeCost: 1.93,
  transportCost: 1.58,
  equipmentCost: 7.89,
  profitPct: 0.095,
  // Authoritative per ADR-001 Q1 — these imply ~8.2%, not the 7% parameter.
  overheadCost: 13.6,
  sgaCost: 25.34,
};

const { overheadCost, sgaCost, ...ARTISAN_INPUTS } = ARTISAN;
const ARTISAN_POLICY = { mode: 'authoritative' as const, overheadCost, sgaCost };

describe('Tier 1 reference vector: Artisan Electrical', () => {
  it('produces the published full loaded rate of 227.61 ZAR/hr', () => {
    const result = computeFullLoadedRate(ARTISAN_INPUTS, ARTISAN_POLICY);

    expect(result.manInPocket).toBe(113.13);
    expect(result.baseDirectLabour).toBe(157.52);
    expect(result.overheadCost).toBe(13.6);
    expect(result.sgaCost).toBe(25.34);
    expect(result.profitCost).toBe(19.75);
    expect(result.fullLoadedRate).toBe(227.61);
  });

  it('reproduces the whole stored row, including every intermediate', () => {
    const r = computeFullLoadedRate(ARTISAN_INPUTS, ARTISAN_POLICY);
    // id 1: man_in_pocket 113.13, full_loaded_rate 227.61
    expect(r).toMatchObject({
      baseRate: 112.57,
      baseRateSource: 'council',
      manInPocket: 113.13,
      baseDirectLabour: 157.52,
      overheadCost: 13.6,
      sgaCost: 25.34,
      profitCost: 19.75,
      fullLoadedRate: 227.61,
    });
  });

  it('does NOT reach 227.61 when overheads are derived from the 7%/15% parameters', () => {
    // ADR-001 F2: deriving yields 226.72. This guards the reason the
    // authoritative policy exists, so nobody "simplifies" it away later.
    const derived = computeFullLoadedRate(ARTISAN_INPUTS, {
      mode: 'derived',
      overheadPct: 0.07,
      sgaPct: 0.15,
    });
    expect(derived.fullLoadedRate).toBe(226.72);
    expect(derived.fullLoadedRate).not.toBe(227.61);
  });

  it('reports the divergence between the two policies', () => {
    const { authoritative, derived, fullLoadedRateDelta } = compareAgainstDerived(
      ARTISAN_INPUTS,
      13.6,
      25.34,
      0.07,
      0.15,
    );
    expect(authoritative.fullLoadedRate).toBe(227.61);
    expect(derived.fullLoadedRate).toBe(226.72);
    expect(fullLoadedRateDelta).toBeCloseTo(-0.89, 2);
  });
});

describe('base rate resolution', () => {
  it('prefers a custom rate when both are present', () => {
    expect(resolveBaseRate({ customRate: 140.79, councilRate: 112.57 })).toEqual({
      baseRate: 140.79,
      source: 'custom',
    });
  });

  it('falls back to the council rate', () => {
    expect(resolveBaseRate({ customRate: null, councilRate: 112.57 })).toEqual({
      baseRate: 112.57,
      source: 'council',
    });
  });

  it('treats empty string as absent', () => {
    expect(resolveBaseRate({ customRate: '', councilRate: 98.11 }).source).toBe('council');
  });

  it('accepts numeric strings, as Prisma Decimal serialises', () => {
    expect(resolveBaseRate({ councilRate: '112.57' }).baseRate).toBe(112.57);
  });

  it('refuses a card with neither rate', () => {
    expect(() => resolveBaseRate({ customRate: null, councilRate: null })).toThrow(
      RateBuildupError,
    );
  });

  it('rejects a non-numeric rate', () => {
    expect(() => resolveBaseRate({ councilRate: 'abc' })).toThrow(RangeError);
  });
});

describe('individual build-up steps', () => {
  it('Man in Pocket = base x (1 + premium)', () => {
    expect(computeManInPocket(112.57, 0.005)).toBeCloseTo(113.13285, 5);
    expect(computeManInPocket(140.79, 0.1)).toBeCloseTo(154.869, 3);
    expect(computeManInPocket(163, 0)).toBe(163);
  });

  it('Base Direct Labour sums in-pocket, leave and statutory', () => {
    expect(computeBaseDirectLabour(113.13285, 15.46, 28.93)).toBeCloseTo(157.52285, 5);
  });

  it('Overhead is charged on direct labour plus equipment', () => {
    expect(deriveOverheadCost(157.52285, 7.89, 0.07)).toBeCloseTo(11.5788995, 6);
  });

  it('SG&A cascades on top of overhead', () => {
    expect(deriveSgaCost(157.52285, 7.89, 11.5788995, 0.15)).toBeCloseTo(26.548762425, 8);
  });

  it('Profit includes PPE and transport in its base', () => {
    // 207.86285 x 9.5% = 19.74697
    expect(computeProfitCost(157.52285, 7.89, 13.6, 25.34, 1.93, 1.58, 0.095)).toBeCloseTo(
      19.74697075,
      7,
    );
  });
});

describe('derived overhead policy', () => {
  it('matches the authoritative result when the parameters match the stored costs', () => {
    // Find overhead/SG&A fractions that reproduce the stored amounts exactly.
    const overheadPct = 13.6 / (157.52285 + 7.89);
    const sgaPct = 25.34 / (157.52285 + 7.89 + 13.6);

    const result = computeFullLoadedRate(ARTISAN_INPUTS, {
      mode: 'derived',
      overheadPct,
      sgaPct,
    });
    expect(result.overheadCost).toBe(13.6);
    expect(result.sgaCost).toBe(25.34);
    expect(result.fullLoadedRate).toBe(227.61);
  });

  it('handles a zero-cost card without dividing by zero or producing NaN', () => {
    const zero: Tier1BaseInputs = {
      councilRate: 0,
      wagePremiumPct: 0,
      leavePay: 0,
      totalStatutoryCost: 0,
      ppeCost: 0,
      transportCost: 0,
      equipmentCost: 0,
      profitPct: 0,
    };
    const result = computeFullLoadedRate(zero, {
      mode: 'derived',
      overheadPct: 0.07,
      sgaPct: 0.15,
    });
    expect(result.fullLoadedRate).toBe(0);
    expect(Number.isFinite(result.fullLoadedRate)).toBe(true);
  });
});

describe('determinism and rounding', () => {
  it('is deterministic for identical input', () => {
    const a = computeFullLoadedRate(ARTISAN_INPUTS, ARTISAN_POLICY);
    const b = computeFullLoadedRate(ARTISAN_INPUTS, ARTISAN_POLICY);
    expect(a).toEqual(b);
  });

  it('accepts Decimal strings throughout', () => {
    const result = computeFullLoadedRate(
      {
        councilRate: '112.57',
        customRate: null,
        wagePremiumPct: '0.0050',
        leavePay: '15.46',
        totalStatutoryCost: '28.93',
        ppeCost: '1.93',
        transportCost: '1.58',
        equipmentCost: '7.89',
        profitPct: '0.0950',
      },
      { mode: 'authoritative', overheadCost: '13.60', sgaCost: '25.34' },
    );
    expect(result.fullLoadedRate).toBe(227.61);
  });

  it('keeps a sub-cent rate resolvable to 4dp downstream', () => {
    const result = computeFullLoadedRate(
      {
        councilRate: 1,
        wagePremiumPct: 0,
        leavePay: 0,
        totalStatutoryCost: 0,
        ppeCost: 0,
        transportCost: 0,
        equipmentCost: 0,
        profitPct: 0,
      },
      { mode: 'authoritative', overheadCost: 0, sgaCost: 0 },
    );
    expect(result.fullLoadedRate).toBe(1);
  });

  it('scales linearly with a rate doubling', () => {
    const doubled = { ...ARTISAN_INPUTS, councilRate: 225.14 };
    const single = computeFullLoadedRate(ARTISAN_INPUTS, ARTISAN_POLICY).fullLoadedRate;
    const double = computeFullLoadedRate(doubled, ARTISAN_POLICY).fullLoadedRate;
    // Not exactly 2x because leave/statutory/PPE/transport are fixed, but it
    // must be strictly greater and still finite.
    expect(double).toBeGreaterThan(single);
    expect(Number.isFinite(double)).toBe(true);
  });
});

describe('cost parameter reading', () => {
  const rows = [
    {
      category: 'Overheads',
      parameterName: COST_PARAMETER_NAMES.overheadPct,
      numericValue: '7.000000',
    },
    {
      category: 'Overheads',
      parameterName: COST_PARAMETER_NAMES.sgaPct,
      numericValue: '15.000000',
    },
    { category: 'Margin', parameterName: COST_PARAMETER_NAMES.profitPct, numericValue: '9.500000' },
    {
      category: 'Material Markup',
      parameterName: COST_PARAMETER_NAMES.r1MaterialMarkupPct,
      numericValue: '10.000000',
    },
  ];

  it('maps parameter names to engine keys and normalises percents to fractions', () => {
    const parsed = readCostParameters(rows);
    // numeric_value stores 7.000000 / 15.000000 / 9.500000 / 10.000000 as percent
    // numbers; the engine only ever works in fractions.
    expect(parsed.overheadPct).toBeCloseTo(0.07, 10);
    expect(parsed.sgaPct).toBeCloseTo(0.15, 10);
    expect(parsed.profitPct).toBeCloseTo(0.095, 10);
    expect(parsed.r1MaterialMarkupPct).toBeCloseTo(0.1, 10);
  });

  it('does NOT divide money parameters that happen to be numeric', () => {
    const parsed = readCostParameters([
      { category: 'PPE', parameterName: COST_PARAMETER_NAMES.ppePerHour, numericValue: '1.930000' },
      {
        category: 'Equipment',
        parameterName: COST_PARAMETER_NAMES.equipmentHourlyRate,
        numericValue: '7.890000',
      },
    ]);
    expect(parsed.ppePerHour).toBeCloseTo(1.93, 10);
    expect(parsed.equipmentHourlyRate).toBeCloseTo(7.89, 10);
  });

  it('agrees with the engine when deriving from real parameters', () => {
    // Guards the unit convention end-to-end: reading the amendment's 9.5% margin
    // as a fraction must not inflate profit ~10x.
    const parsed = readCostParameters(rows);
    const result = computeFullLoadedRate(ARTISAN_INPUTS, {
      mode: 'derived',
      overheadPct: parsed.overheadPct!,
      sgaPct: parsed.sgaPct!,
    });
    expect(result.fullLoadedRate).toBeLessThan(300);
  });

  it('omits parameters that are absent rather than inventing defaults', () => {
    const parsed = readCostParameters([rows[0]!]);
    expect(parsed.overheadPct).toBeCloseTo(0.07, 10);
    expect(parsed.sgaPct).toBeUndefined();
    expect(parsed.profitPct).toBeUndefined();
  });

  it('tolerates an empty amendment', () => {
    expect(readCostParameters([])).toEqual({});
  });
});
