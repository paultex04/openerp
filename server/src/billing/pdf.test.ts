import { describe, expect, it } from 'vitest';
import { generateTaxInvoicePdf } from './pdf.js';
import type { InvoiceDetail } from './service.js';

describe('generateTaxInvoicePdf', () => {
  const sampleDetail: InvoiceDetail = {
    invoice: {
      id: 42,
      invoiceNumber: 'INV-2026-0042',
      issueDate: '2026-10-15',
      dueDate: '2026-11-14',
      status: 'Approved',
      notes: 'Payment strictly within 30 days of invoice date.',
    },
    lines: [
      {
        id: 1,
        code: 'EC-CBL-01',
        description: 'Install 16mm 4-core armoured cable',
        billedQuantity: 120,
        uom: 'M',
        unitPrice: 250,
        subtotal: 30000,
      },
      {
        id: 2,
        code: 'EC-TRM-02',
        description: 'Terminate 16mm cable ends at MCC',
        billedQuantity: 4,
        uom: 'EA',
        unitPrice: 1500,
        subtotal: 6000,
      },
    ],
    client: {
      id: 5,
      name: 'Eskom Rotek Industries',
      vatNumber: '4190123847',
      isVatRegistered: true,
      address: 'Heritage Office Park, Germiston, Gauteng',
    },
    job: {
      id: 10,
      contractNumber: 'CTR-2026-002',
      projectCode: 'PRJ-ESK-01',
      workOrder: 'WO-88210',
      purchaseOrder: 'PO-4500918',
    },
    vat: {
      subtotalAmount: 36000,
      taxRate: 0.15,
      effectiveTaxRate: 0.15,
      taxAmount: 5400,
      totalWithTax: 41400,
    },
    jobPosition: {
      jobActualTotal: 36000,
      recognisedBilledTotal: 0,
      remainingUnbilled: 36000,
    },
    permissions: { canEdit: false, canDelete: false, availableTransitions: [] },
    compliance: { ok: true, warnings: [] },
  };

  it('renders a valid PDF buffer starting with standard PDF magic bytes', async () => {
    const buffer = await generateTaxInvoicePdf(sampleDetail);

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(1000);

    // Standard PDF file signature: %PDF-
    const header = buffer.subarray(0, 5).toString('ascii');
    expect(header).toBe('%PDF-');
  });

  it('handles non-VAT registered client with 0% tax gracefully', async () => {
    const nonVatDetail: InvoiceDetail = {
      ...sampleDetail,
      client: {
        id: 6,
        name: 'Small Subcontractor CC',
        vatNumber: null,
        isVatRegistered: false,
        address: null,
      },
      vat: {
        subtotalAmount: 10000,
        taxRate: 0,
        effectiveTaxRate: 0,
        taxAmount: 0,
        totalWithTax: 10000,
      },
    };

    const buffer = await generateTaxInvoicePdf(nonVatDetail);
    expect(buffer.length).toBeGreaterThan(1000);
    const header = buffer.subarray(0, 5).toString('ascii');
    expect(header).toBe('%PDF-');
  });
});
