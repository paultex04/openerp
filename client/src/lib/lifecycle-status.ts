/**
 * Lifecycle colour coding for job and invoice statuses.
 *
 * This module is the *only* place that decides what a lifecycle stage looks
 * like. It previously did not exist: `statusVariant` (in `status-badge.tsx`) and
 * `invoiceVariant` (in `InvoicePanel.tsx`) were near-copies that had already
 * drifted, so a job and an invoice in the same visual state could be rendered
 * different colours.
 *
 * Colours are declared as badge *variants* in `ui/badge.tsx`, never as raw
 * Tailwind classes at call sites, so the design system stays in charge of the
 * palette and dark mode is handled in one place.
 *
 * The mapping follows the stage a record sits in:
 *   - amber  -> commercial/pre-execution (scoping, awaiting PO, submitted)
 *   - blue   -> work in progress (WNYS, WIP, work complete)
 *   - violet -> actuals and pack readiness, i.e. value being proven
 *   - green  -> invoiced / money settled
 *   - red    -> cancelled or disputed
 * Terminal and at-risk states are deliberately the loudest colours, because in
 * a dense register the states that need attention must win a glance.
 */
import type { JobStatus } from '@openerp/shared';

export type LifecycleVariant =
  'default' | 'secondary' | 'outline' | 'destructive' | 'success' | 'warning' | 'info';

const JOB_VARIANTS: Readonly<Record<JobStatus, LifecycleVariant>> = {
  '00. Cancelled': 'destructive',
  '01. Scoping': 'warning',
  '01A. Scoped': 'warning',
  '02. Awaiting PO': 'warning',
  '03. WNYS': 'info',
  '04. WIP': 'info',
  '05. Work Complete': 'info',
  '06. Actuals in Progress': 'secondary',
  '07. Pack Ready': 'secondary',
  '08. Out for signature': 'secondary',
  '09. Awaiting change order': 'warning',
  '10. Invoiced': 'success',
  '11. Partially Invoiced': 'success',
};

const INVOICE_VARIANTS: Readonly<Record<string, LifecycleVariant>> = {
  Draft: 'secondary',
  Submitted: 'warning',
  Approved: 'success',
  'Partially Paid': 'success',
  Paid: 'success',
  Disputed: 'destructive',
  Cancelled: 'destructive',
};

/**
 * Badge variant for a job status. Falls back to `outline` so an unrecognised
 * label looks visibly unknown rather than silently healthy.
 */
export function statusVariant(status: string): LifecycleVariant {
  return JOB_VARIANTS[status as JobStatus] ?? 'outline';
}

/** Badge variant for an invoice status. Same `outline` fallback rationale. */
export function invoiceVariant(status: string): LifecycleVariant {
  return INVOICE_VARIANTS[status] ?? 'outline';
}
