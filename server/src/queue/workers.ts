/**
 * Background workers registration (Phase 5).
 *
 * Implements pg-boss background workers for asynchronous tasks:
 *  - `export/invoice-pdf`: Asynchronously renders Tax Invoice PDFs and caches them in Garage S3.
 *  - `system/backup-database`: Runs scheduled database dumps and uploads them to Garage S3 / local disk.
 */
import { registerWorker, scheduleRecurringJob } from './index.js';
import { getInvoiceDetail } from '../billing/service.js';
import { generateTaxInvoicePdf } from '../billing/pdf.js';
import { uploadBlob, isS3Active } from '../storage/index.js';
import { createDatabaseBackup } from '../backup/service.js';

export async function initBackgroundWorkers(): Promise<void> {
  await registerWorker<{ invoiceId: number }>('export/invoice-pdf', async (job) => {
    const { invoiceId } = job.data;
    if (!invoiceId) return;

    try {
      const detail = await getInvoiceDetail(invoiceId);
      const pdfBuffer = await generateTaxInvoicePdf(detail);
      if (isS3Active()) {
        await uploadBlob(`invoices/tax-inv-${invoiceId}.pdf`, pdfBuffer, 'application/pdf');
      }
    } catch (err: unknown) {
      console.error(
        `[worker:export/invoice-pdf] Failed to render or upload PDF for invoice ${invoiceId}:`,
        err,
      );
      throw err;
    }
  });

  // Automated database backup worker
  await registerWorker('system/backup-database', async (job) => {
    console.log(`[worker:system/backup-database] Starting database backup (job ${job.id})...`);
    try {
      const backup = await createDatabaseBackup();
      console.log(
        `[worker:system/backup-database] Backup completed: ${backup.filename} (${backup.sizeBytes} bytes, storage: ${backup.storage}, method: ${backup.method})`,
      );
    } catch (err: unknown) {
      console.error('[worker:system/backup-database] Database backup failed:', err);
      throw err;
    }
  });

  // Nightly schedule at 02:00
  try {
    await scheduleRecurringJob('system/backup-database', '0 2 * * *');
  } catch (err: unknown) {
    console.warn('[worker:system/backup-database] Failed to register cron schedule:', err);
  }
}
