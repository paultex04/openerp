import { describe, expect, it } from 'vitest';
import {
  costRateForBasis,
  isStepHours,
  materialCost,
  MissingCostRateError,
  plannedLabour,
  resolveCostRate,
  summariseJobCosting,
  sumHours,
  type LabourRateComponents,
} from './costing';

/** A rate card that adds up: components sum to `fullLoadedRate` (85). */
const components: LabourRateComponents = {
  manInPocket: 50,
  leavePay: 5,
  totalStatutoryCost: 8,
  ppeCost: 2,
  transportCost: 3,
  equipmentCost: 2,
  overheadCost: 5,
  sgaCost: 4,
  profitCost: 6,
  fullLoadedRate: 85,
};

describe('costRateForBasis', () => {
  it('excludes profit by default (the headline cost rate)', () => {
    expect(costRateForBasis(components)).toBe(79);
    expect(costRateForBasis(components, 'fully_loaded_ex_profit')).toBe(79);
  });

  it('returns the direct employment cost for the gross-margin basis', () => {
    expect(costRateForBasis(components, 'direct')).toBe(63);
  });

  it('returns the published rate for the fully loaded basis', () => {
    expect(costRateForBasis(components, 'fully_loaded')).toBe(85);
  });
});

describe('resolveCostRate precedence', () => {
  const candidate = { labourType: 'Fitter', shiftType: 'NT', components };

  it('prefers an explicit override over everything', () => {
    const resolved = resolveCostRate({
      overrideRate: 100,
      candidate,
      employeeRate: 70,
    });
    expect(resolved.source).toBe('override');
    expect(resolved.costRate).toBe(100);
    expect(resolved.components).toBeNull();
  });

  it('uses the rate-card row when there is no override', () => {
    const resolved = resolveCostRate({ candidate, employeeRate: 70 });
    expect(resolved.source).toBe('service_master_rate');
    expect(resolved.costRate).toBe(79);
    expect(resolved.components).toBe(components);
  });

  it('falls back to the employee rate only when no rate-card row exists', () => {
    const resolved = resolveCostRate({ employeeRate: 70 });
    expect(resolved.source).toBe('employee_rate');
    expect(resolved.costRate).toBe(70);
  });

  it('throws rather than costing an hour at zero', () => {
    expect(() => resolveCostRate({ candidate: null, employeeRate: null })).toThrow(
      MissingCostRateError,
    );
  });
});

describe('hours helpers', () => {
  it('accepts quarter-hour steps and rejects the rest', () => {
    expect(isStepHours(0.25)).toBe(true);
    expect(isStepHours(7.5)).toBe(true);
    expect(isStepHours(8)).toBe(true);
    expect(isStepHours(0.3)).toBe(false);
  });

  it('sums hours, rounding once', () => {
    expect(sumHours([0.25, 0.25, 0.25])).toBe(0.75);
  });
});

describe('plannedLabour', () => {
  it('derives hours from the recipe and costs them at the line rate', () => {
    const plan = plannedLabour([
      {
        plannedQuantity: 10,
        crewQuantity: 2,
        hoursPerUnit: 1.5,
        labourType: 'Fitter',
        shiftType: 'NT',
        costRate: 79,
      },
      {
        plannedQuantity: 4,
        crewQuantity: 1,
        hoursPerUnit: 2,
        labourType: 'Rigger',
        shiftType: 'OT1.5',
        costRate: 63,
      },
    ]);

    expect(plan.hours).toBe(38); // 30 + 8
    expect(plan.cost).toBe(2874); // 30×79 + 8×63
    expect(plan.byLabourType).toHaveLength(2);
    expect(plan.byLabourType[0]).toMatchObject({
      labourType: 'Fitter',
      hoursPlanned: 30,
      costPlanned: 2370,
      hoursActual: 0,
    });
  });
});

describe('materialCost', () => {
  it('costs actual quantities and rounds once', () => {
    expect(materialCost([{ quantity: 3, unitCost: 120.5 }])).toBe(361.5);
  });
});

describe('summariseJobCosting', () => {
  const summary = summariseJobCosting({
    plans: [
      {
        plannedQuantity: 10,
        crewQuantity: 2,
        hoursPerUnit: 1.5,
        labourType: 'Fitter',
        shiftType: 'NT',
        costRate: 79,
      },
      {
        plannedQuantity: 4,
        crewQuantity: 1,
        hoursPerUnit: 2,
        labourType: 'Rigger',
        shiftType: 'OT1.5',
        costRate: 63,
      },
    ],
    entries: [
      { hours: 25, labourType: 'Fitter', shiftType: 'NT', costAmount: 1975, isBillable: true },
    ],
    materials: [{ quantity: 3, unitCost: 120.5 }],
    revenueActual: 5000,
    revenueInvoiced: 2500,
  });

  it('adds labour and material into one cost figure', () => {
    expect(summary.labourCostActual).toBe(1975);
    expect(summary.materialCostActual).toBe(361.5);
    expect(summary.costActual).toBe(2336.5);
  });

  it('measures margin against work-done revenue', () => {
    expect(summary.revenueActual).toBe(5000);
    expect(summary.grossMargin).toBe(2663.5);
    expect(summary.grossMarginPct).toBe(0.5327);
  });

  it('reports variance against the plan', () => {
    expect(summary.hoursPlanned).toBe(38);
    expect(summary.hoursActual).toBe(25);
    expect(summary.hoursVariance).toBe(-13);
    expect(summary.costVariance).toBe(-537.5);
  });

  it('groups planned and actual hours by labour type', () => {
    const fitter = summary.byLabourType.find((g) => g.labourType === 'Fitter');
    const rigger = summary.byLabourType.find((g) => g.labourType === 'Rigger');
    expect(fitter).toMatchObject({ hoursPlanned: 30, hoursActual: 25, costActual: 1975 });
    expect(rigger).toMatchObject({ hoursPlanned: 8, hoursActual: 0 });
  });

  it('treats an empty job as zero, not NaN', () => {
    const empty = summariseJobCosting({});
    expect(empty.grossMargin).toBe(0);
    expect(empty.grossMarginPct).toBe(0);
    expect(empty.costActual).toBe(0);
  });
});
