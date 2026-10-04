/**
 * VAT computation for South African invoicing.
 *
 * SARS VAT is 15% as at the time of writing. Two cases exist in practice and
 * they are NOT the same number:
 *
 *  - A VAT-registered client: the invoice charges VAT on top, so
 *      taxAmount    = subtotal x rate
 *      totalWithTax = subtotal + taxAmount
 *  - A client that is not VAT registered: the business must not charge VAT, so
 *      taxAmount    = 0
 *      totalWithTax = subtotal
 *
 * Getting this wrong in either direction is a compliance problem, so the
 * registration flag is a required input rather than something inferred from a
 * zero rate.
 *
 * Rounding: each line and each aggregate is rounded to cents exactly once, and
 * `taxAmount` is computed from the already-rounded subtotal. This is the method
 * that makes invoice totals reconcile to the cent against the sum of their
 * lines, which is a Phase 4 acceptance gate.
 */
import { roundMoney, sumExact } from '../money.js';

/** Current SARS standard rate. Overridable per invoice via the amendment. */
export const DEFAULT_VAT_RATE = 0.15;

export interface VatLineInput {
  quantity: number | string;
  /** Unit price snapshot. */
  unitPrice: number | string;
  /** Optional explicit line description amount override. */
  lineSubtotal?: number | string;
}

export interface ComputedVatLine extends VatLineInput {
  /** quantity x unitPrice, rounded to cents. */
  lineSubtotal: number;
}

export interface VatComputationInput {
  lines: readonly VatLineInput[];
  /** VAT rate as a fraction: 0.15 = 15%. */
  taxRate: number | string;
  /** Whether the client is registered for VAT. */
  isVatRegistered: boolean;
}

export interface VatComputation {
  lines: ComputedVatLine[];
  /** Sum of rounded line subtotals. */
  subtotalAmount: number;
  taxRate: number;
  /** Fraction actually applied — 0 for a non-registered client. */
  effectiveTaxRate: number;
  taxAmount: number;
  totalWithTax: number;
}

export function computeVat(input: VatComputationInput): VatComputation {
  const lines: ComputedVatLine[] = input.lines.map((line) => ({
    ...line,
    lineSubtotal: roundMoney(
      line.lineSubtotal !== undefined
        ? line.lineSubtotal
        : Number(line.quantity) * Number(line.unitPrice),
      'lineSubtotal',
    ),
  }));

  const subtotalAmount = roundMoney(
    sumExact(
      lines.map((l) => l.lineSubtotal),
      'subtotalAmount',
    ),
    'subtotalAmount',
  );

  const requestedRate = Number(input.taxRate);
  const effectiveTaxRate = input.isVatRegistered ? requestedRate : 0;

  const taxAmount = roundMoney(subtotalAmount * effectiveTaxRate, 'taxAmount');
  const totalWithTax = roundMoney(subtotalAmount + taxAmount, 'totalWithTax');

  return {
    lines,
    subtotalAmount,
    taxRate: requestedRate,
    effectiveTaxRate,
    taxAmount,
    totalWithTax,
  };
}

/**
 * SARS invoice layout requirements.
 *
 * Kept next to the computation so the printable view and the API agree on what
 * a compliant invoice must display, and so a missing tax number is surfaced as
 * a warning rather than a blank field on a tax invoice.
 */
export interface InvoiceComplianceInput {
  isVatRegistered: boolean;
  clientVatNumber: string | null | undefined;
  isVatCharged: boolean;
}

export interface ComplianceCheck {
  ok: boolean;
  warnings: string[];
}

/** South African VAT numbers are 10 digits, usually prefixed `4`. */
const VAT_NUMBER_PATTERN = /^\d{10}$/;

export function checkInvoiceCompliance(input: InvoiceComplianceInput): ComplianceCheck {
  const warnings: string[] = [];

  if (input.isVatCharged && !input.isVatRegistered) {
    warnings.push(
      'VAT is being charged to a client that is not VAT registered. This is a compliance risk.',
    );
  }

  if (input.isVatRegistered) {
    const number = input.clientVatNumber?.replace(/\s/g, '') ?? '';
    if (!number) {
      warnings.push('Client is VAT registered but no VAT number is on file.');
    } else if (!VAT_NUMBER_PATTERN.test(number)) {
      warnings.push(
        `Client VAT number "${input.clientVatNumber}" is not 10 digits; SARS requires 10 digits.`,
      );
    }
  }

  return { ok: warnings.length === 0, warnings };
}
