/**
 * Background workers registration (Phase 5).
 *
 * Implements pg-boss background workers for asynchronous tasks:
 *  - `export:invoice-pdf`: Asynchronously renders Tax Invoice PDFs and caches them in Garage S3.
 */
import { registerWorker } from './index.js';
import { getInvoiceDetail } from '../billing/service.js';
import { generateTaxInvoicePdf } from '../billing/pdf.js';
import { uploadBlob, isS3Active } from '../storage/index.js';

export async function initBackgroundWorkers(): Promise<void> {
  await registerWorker<{ invoiceId: number }>('export:invoice-pdf', async (job) => {
    const { invoiceId } = job.data;
    if (!invoiceId) return;

    try {
      const detail = await getInvoiceDetail(invoiceId);
      const pdfBuffer = await generateTaxInvoicePdf(detail);
      if (isS3Active()) {
        await uploadBlob(`invoices/tax-inv-${invoiceId}.pdf`, pdfBuffer, 'application/pdf');
      }
    } catch {
      // Swallowed in worker so unhandled rejections don't crash the queue runner
    }
  });
}
