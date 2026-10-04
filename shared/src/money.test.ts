import { describe, expect, it } from 'vitest';
import { round, roundMoney, roundPct, roundRate, sumExact, toNumber, applyFraction } from './money';
import { checkInvoiceCompliance, computeVat, DEFAULT_VAT_RATE } from './pricing/vat';

describe('rounding', () => {
  it('rounds half away from zero', () => {
    expect(round(0.005, 2)).toBe(0.01);
    expect(round(2.675, 2)).toBe(2.68); // the classic float failure
    expect(round(1.005, 2)).toBe(1.01);
  });

  it('rounds negatives symmetrically, unlike Math.round', () => {
    // Math.round(-0.5) is -0, which would silently lose a credit.
    expect(round(-0.005, 2)).toBe(-0.01);
    expect(round(-2.675, 2)).toBe(-2.68);
  });

  it('rounds money to 2dp and rates to 4dp', () => {
    expect(roundMoney(17.52261)).toBe(17.52);
    expect(roundRate(17.52261)).toBe(17.5226);
    expect(roundPct(0.075)).toBe(0.075);
  });

  it('leaves exact values alone', () => {
    expect(roundMoney(227.61)).toBe(227.61);
    expect(roundRate(17.5226)).toBe(17.5226);
  });

  it('rejects non-finite input rather than propagating NaN', () => {
    expect(() => toNumber('abc')).toThrow(RangeError);
    expect(() => toNumber(Number.NaN)).toThrow(RangeError);
    expect(() => toNumber(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('parses Decimal strings', () => {
    expect(toNumber('112.57')).toBe(112.57);
    expect(toNumber('-4.20')).toBe(-4.2);
  });

  it('sums exactly, rounding only at the end', () => {
    expect(sumExact([0.1, 0.2])).toBeCloseTo(0.3, 12);
    expect(roundMoney(sumExact([0.1, 0.2]))).toBe(0.3);
  });

  it('applies fractions, not percentages', () => {
    expect(applyFraction(100, 0.07)).toBeCloseTo(7, 10);
    expect(applyFraction(157.52285, 0.07)).toBeCloseTo(11.0265995, 6);
  });
});

describe('VAT computation', () => {
  const lines = [
    { quantity: 20, unitPrice: 17.5226 }, // -> 350.45
    { quantity: 95, unitPrice: 27.9158 }, // -> 2652.00
    { quantity: 1, unitPrice: 23782 }, // -> 23782.00
  ];

  it('computes 15% VAT for a registered client', () => {
    const result = computeVat({
      lines,
      taxRate: DEFAULT_VAT_RATE,
      isVatRegistered: true,
    });
    expect(result.subtotalAmount).toBe(26784.45);
    expect(result.taxAmount).toBe(4017.67);
    expect(result.totalWithTax).toBe(30802.12);
  });

  it('reconciles to the cent: total = subtotal + tax exactly', () => {
    const result = computeVat({ lines, taxRate: 0.15, isVatRegistered: true });
    // This is the Phase 4 acceptance gate, asserted early so the arithmetic
    // cannot regress before invoicing is built on it.
    expect(result.totalWithTax).toBe(
      Math.round((result.subtotalAmount + result.taxAmount) * 100) / 100,
    );
  });

  it('reconciles against the sum of the rounded line subtotals', () => {
    const result = computeVat({ lines, taxRate: 0.15, isVatRegistered: true });
    const lineSum = result.lines.reduce((acc, l) => acc + l.lineSubtotal, 0);
    expect(result.subtotalAmount).toBe(Math.round(lineSum * 100) / 100);
    expect(result.lines.map((l) => l.lineSubtotal)).toEqual([350.45, 2652, 23782]);
  });

  it('charges no VAT to a client that is not registered', () => {
    const result = computeVat({ lines, taxRate: 0.15, isVatRegistered: false });
    expect(result.effectiveTaxRate).toBe(0);
    expect(result.taxAmount).toBe(0);
    expect(result.totalWithTax).toBe(26784.45);
  });

  it('honours a non-standard rate', () => {
    const result = computeVat({
      lines: [{ quantity: 1, unitPrice: 1000 }],
      taxRate: 0.05,
      isVatRegistered: true,
    });
    expect(result.taxAmount).toBe(50);
    expect(result.totalWithTax).toBe(1050);
  });

  it('handles a zero-value invoice', () => {
    const result = computeVat({ lines: [], taxRate: 0.15, isVatRegistered: true });
    expect(result.subtotalAmount).toBe(0);
    expect(result.taxAmount).toBe(0);
    expect(result.totalWithTax).toBe(0);
  });

  it('rounds each line to cents so no sub-cent drift accumulates', () => {
    const result = computeVat({
      lines: [{ quantity: 3, unitPrice: 0.335 }],
      taxRate: 0.15,
      isVatRegistered: true,
    });
    expect(result.lines[0]!.lineSubtotal).toBe(1.01); // 1.005 -> 1.01
  });

  it('accepts an explicit line subtotal override', () => {
    const result = computeVat({
      lines: [{ quantity: 99, unitPrice: 100, lineSubtotal: 500 }],
      taxRate: 0.15,
      isVatRegistered: true,
    });
    expect(result.subtotalAmount).toBe(500);
  });
});

describe('invoice compliance checks', () => {
  it('passes a fully compliant registered client', () => {
    const result = checkInvoiceCompliance({
      isVatRegistered: true,
      clientVatNumber: '4123456789',
      isVatCharged: true,
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('warns when charging VAT to an unregistered client', () => {
    const result = checkInvoiceCompliance({
      isVatRegistered: false,
      clientVatNumber: null,
      isVatCharged: true,
    });
    expect(result.ok).toBe(false);
    expect(result.warnings[0]).toMatch(/not VAT registered/i);
  });

  it('warns when a registered client has no VAT number', () => {
    const result = checkInvoiceCompliance({
      isVatRegistered: true,
      clientVatNumber: null,
      isVatCharged: true,
    });
    expect(result.ok).toBe(false);
    expect(result.warnings[0]).toMatch(/no VAT number/i);
  });

  it('warns about a malformed VAT number', () => {
    const result = checkInvoiceCompliance({
      isVatRegistered: true,
      clientVatNumber: '12345',
      isVatCharged: true,
    });
    expect(result.ok).toBe(false);
    expect(result.warnings[0]).toMatch(/10 digits/i);
  });

  it('tolerates spacing in the VAT number', () => {
    expect(
      checkInvoiceCompliance({
        isVatRegistered: true,
        clientVatNumber: '4123 456 789',
        isVatCharged: true,
      }).ok,
    ).toBe(true);
  });

  it('passes an unregistered client with no VAT charged', () => {
    const result = checkInvoiceCompliance({
      isVatRegistered: false,
      clientVatNumber: null,
      isVatCharged: false,
    });
    expect(result.ok).toBe(true);
  });
});
