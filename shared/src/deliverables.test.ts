import { describe, expect, it } from 'vitest';
import { aggregateTotals, computeDeliverableTotals } from './deliverables';

describe('deliverable subtotals', () => {
  it('computes planned and actual subtotals from the same snapshot rate', () => {
    // Job 1 / S00247970: 20 m at the 17.5226 ZAR/m snapshot.
    const totals = computeDeliverableTotals({
      plannedQuantity: 10,
      actualQuantity: 20,
      appliedRate: 17.5226,
    });

    expect(totals.plannedSubtotal).toBe(175.23);
    expect(totals.actualSubtotal).toBe(350.45);
  });

  it('reports quantity and value variance', () => {
    const totals = computeDeliverableTotals({
      plannedQuantity: 10,
      actualQuantity: 20,
      appliedRate: 17.5226,
    });

    expect(totals.quantityVariance).toBe(10);
    expect(totals.valueVariance).toBe(175.22); // 350.45 - 175.23
  });

  it('reports an underrun as a negative value variance', () => {
    const totals = computeDeliverableTotals({
      plannedQuantity: 100,
      actualQuantity: 95,
      appliedRate: 27.9158,
    });

    expect(totals.plannedSubtotal).toBe(2791.58);
    expect(totals.actualSubtotal).toBe(2652);
    expect(totals.quantityVariance).toBe(-5);
    expect(totals.valueVariance).toBe(-139.58);
  });

  it('handles a deliverable with no actuals recorded yet', () => {
    const totals = computeDeliverableTotals({
      plannedQuantity: 100,
      actualQuantity: 0,
      appliedRate: 17.5226,
    });

    expect(totals.actualSubtotal).toBe(0);
    expect(totals.quantityVariance).toBe(-100);
    expect(totals.valueVariance).toBe(-1752.26);
  });

  it('accepts Decimal strings', () => {
    const totals = computeDeliverableTotals({
      plannedQuantity: '10.00',
      actualQuantity: '20.00',
      appliedRate: '17.5226',
    });
    expect(totals.actualSubtotal).toBe(350.45);
  });
});

describe('Phase 3 acceptance: the applied_rate snapshot never moves', () => {
  it('keeps the snapshot authoritative when the service code rate drifts', () => {
    // Job scoped at 17.5226; the service code is later re-priced to 20.0000.
    const totals = computeDeliverableTotals({
      plannedQuantity: 10,
      actualQuantity: 20,
      appliedRate: 17.5226,
      currentServiceCodeRate: 20,
    });

    // Subtotals still use the snapshot...
    expect(totals.plannedSubtotal).toBe(175.23);
    expect(totals.actualSubtotal).toBe(350.45);

    // ...but the drift is reported for a QS to notice.
    expect(totals.rateHasDrifted).toBe(true);
    expect(totals.currentRate).toBe(20);
  });

  it('reports no drift when the rate is unchanged', () => {
    const totals = computeDeliverableTotals({
      plannedQuantity: 10,
      actualQuantity: 10,
      appliedRate: 17.5226,
      currentServiceCodeRate: 17.5226,
    });
    expect(totals.rateHasDrifted).toBe(false);
  });

  it('tolerates a missing current rate', () => {
    for (const current of [null, undefined]) {
      const totals = computeDeliverableTotals({
        plannedQuantity: 10,
        actualQuantity: 10,
        appliedRate: 17.5226,
        currentServiceCodeRate: current,
      });
      expect(totals.rateHasDrifted).toBe(false);
      expect(totals.currentRate).toBeNull();
    }
  });

  it('does not mistake a 4dp difference for drift', () => {
    const totals = computeDeliverableTotals({
      plannedQuantity: 1,
      actualQuantity: 1,
      appliedRate: 17.5226,
      currentServiceCodeRate: 17.5227,
    });
    expect(totals.rateHasDrifted).toBe(true); // 0.0001 ZAR is a real difference
  });

  it('is stable across repeated evaluation', () => {
    const line = {
      plannedQuantity: 33,
      actualQuantity: 47,
      appliedRate: 3.3333,
      currentServiceCodeRate: 3.3333,
    };
    expect(computeDeliverableTotals(line)).toEqual(computeDeliverableTotals(line));
  });
});

describe('job aggregation', () => {
  it('matches the real job 1 deliverable set', () => {
    // The three seeded job_service_code rows for job 1.
    const lines = [
      computeDeliverableTotals({
        plannedQuantity: 10,
        actualQuantity: 20,
        appliedRate: 17.5226,
      }),
      computeDeliverableTotals({
        plannedQuantity: 100,
        actualQuantity: 95,
        appliedRate: 27.9158,
      }),
      computeDeliverableTotals({
        plannedQuantity: 1,
        actualQuantity: 1,
        appliedRate: 23782,
      }),
    ];

    const totals = aggregateTotals(lines);

    expect(totals.plannedSubtotal).toBe(26748.81); // 175.23 + 2791.58 + 23782.00
    expect(totals.actualSubtotal).toBe(26784.45); // 350.45 + 2652.00 + 23782.00
    expect(totals.valueVariance).toBe(35.64);
    expect(totals.lineCount).toBe(3);
    expect(totals.linesWithActuals).toBe(3);
    expect(totals.linesOverrun).toBe(1); // only S00247970 (20 vs 10)

    // The seeded invoice total equals the ACTUAL subtotal, which is correct:
    // invoices bill measured actuals, not plan.
    expect(totals.actualSubtotal).toBe(26784.45);
  });

  it('handles a job with no deliverables', () => {
    expect(aggregateTotals([])).toEqual({
      plannedSubtotal: 0,
      actualSubtotal: 0,
      valueVariance: 0,
      lineCount: 0,
      linesWithActuals: 0,
      linesOverrun: 0,
    });
  });

  it('counts only deliverables that actually exceed plan as overruns', () => {
    const lines = [
      computeDeliverableTotals({ plannedQuantity: 10, actualQuantity: 20, appliedRate: 1 }),
      computeDeliverableTotals({ plannedQuantity: 10, actualQuantity: 10, appliedRate: 1 }),
      computeDeliverableTotals({ plannedQuantity: 10, actualQuantity: 5, appliedRate: 1 }),
      computeDeliverableTotals({ plannedQuantity: 10, actualQuantity: 0, appliedRate: 1 }),
    ];
    const totals = aggregateTotals(lines);
    expect(totals.linesOverrun).toBe(1);
    expect(totals.linesWithActuals).toBe(3);
  });
});
