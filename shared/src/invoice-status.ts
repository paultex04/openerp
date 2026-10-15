/**
 * Invoice lifecycle state machine.
 *
 * An invoice moves through financial control, not site progress, so this machine
 * is deliberately separate from the job lifecycle even though approving an
 * invoice drives the job to `10. Invoiced` / `11. Partially Invoiced` (via
 * `markJobInvoiced`, which is the invoice lifecycle's authority — not a second
 * permission check on top of `invoice.approve`).
 *
 * ## The pipeline
 *
 * ```
 *   Draft
 *     -> Submitted            (invoice.submit)    billing or QS hands over
 *     -> Cancelled            (invoice.status)    withdrawn before issue
 *   Submitted
 *     -> Approved             (invoice.approve)   moves the job to 10/11
 *     -> Disputed             (invoice.status)    client queries it
 *     -> Cancelled            (invoice.status)    withdrawn after issue
 *   Approved
 *     -> Paid                 (invoice.status)    settled in full
 *     -> Partially Paid       (invoice.status)    part-settled
 *     -> Disputed             (invoice.status)    queried after approval
 *     -> Cancelled            (invoice.status)    voided before any payment
 *   Partially Paid
 *     -> Paid                 (invoice.status)    balance settled
 *     -> Cancelled            (invoice.status)    written off after part payment
 *   Disputed
 *     -> Submitted            (invoice.status)    re-issued after resolution
 *     -> Draft                (invoice.write)     sent back for correction
 *     -> Cancelled            (invoice.status)    written off
 * ```
 *
 * `Paid` and `Cancelled` are terminal: money has moved, or the document is dead.
 *
 * ## Why cancelling needs `invoice.status`, even for a draft
 *
 * A draft can still be edited or deleted by its author (`invoice.write`), but
 * cancellation is a status event with downstream meaning (it releases the
 * "one open invoice per job" guard). Keeping every cancellation behind
 * `invoice.status` means a QS can draft and submit but can never cancel —
 * withdrawal is always a billing decision. That separation is the point.
 *
 * ## Why approval can void but payment cannot be unpicked
 *
 * `Approved -> Cancelled` exists so a wrongly approved invoice can be voided
 * before money moves — and so test and smoke fixtures can clean up after
 * exercising approval. Once any payment is recorded (`Partially Paid`, `Paid`)
 * the document is financial history and can no longer be cancelled; correcting
 * it needs a credit note, which is outside Phase 4.
 */
import { invoiceStatusValues, type InvoiceStatus } from './schemas/enums';

export const INVOICE_STATUSES = invoiceStatusValues;

export interface InvoiceTransition {
  from: InvoiceStatus;
  to: InvoiceStatus;
  /** RBAC capability required to perform it. */
  permission: string;
  /** Human-readable justification, surfaced in the UI and in 403 responses. */
  reason: string;
}

const write = 'invoice.write';
const submit = 'invoice.submit';
const approve = 'invoice.approve';
const status = 'invoice.status';

export const INVOICE_TRANSITIONS: readonly InvoiceTransition[] = [
  // --- Drafting (billing clerk, QS) ---
  {
    from: 'Draft',
    to: 'Submitted',
    permission: submit,
    reason: 'Submitted for approval.',
  },

  // --- Approval ---
  {
    from: 'Submitted',
    to: 'Approved',
    permission: approve,
    reason: 'Approved. The job is marked invoiced.',
  },

  // --- Payment ---
  {
    from: 'Approved',
    to: 'Paid',
    permission: status,
    reason: 'Settled in full.',
  },
  {
    from: 'Approved',
    to: 'Partially Paid',
    permission: status,
    reason: 'Part-settled; a balance remains.',
  },
  {
    from: 'Partially Paid',
    to: 'Paid',
    permission: status,
    reason: 'Balance settled.',
  },

  // --- Disputes ---
  {
    from: 'Submitted',
    to: 'Disputed',
    permission: status,
    reason: 'Queried before approval.',
  },
  {
    from: 'Approved',
    to: 'Disputed',
    permission: status,
    reason: 'Queried after approval.',
  },
  {
    from: 'Disputed',
    to: 'Submitted',
    permission: status,
    reason: 'Re-issued after the dispute was resolved.',
  },
  {
    from: 'Disputed',
    to: 'Draft',
    permission: write,
    reason: 'Sent back for correction.',
  },

  // --- Withdrawal (always a billing decision, never a draft edit) ---
  {
    from: 'Draft',
    to: 'Cancelled',
    permission: status,
    reason: 'Withdrawn before issue.',
  },
  {
    from: 'Submitted',
    to: 'Cancelled',
    permission: status,
    reason: 'Withdrawn after issue.',
  },
  {
    from: 'Approved',
    to: 'Cancelled',
    permission: status,
    reason: 'Voided before any payment was recorded.',
  },
  {
    from: 'Partially Paid',
    to: 'Cancelled',
    permission: status,
    reason:
      'Written off after part payment. The received amount stands and the balance ' +
      'is pursued separately, so this is a credit decision rather than a clean void.',
  },
  {
    from: 'Disputed',
    to: 'Cancelled',
    permission: status,
    reason: 'Written off.',
  },
];

/** Statuses from which no further transition is possible. */
export const TERMINAL_INVOICE_STATUSES: ReadonlySet<InvoiceStatus> = new Set<InvoiceStatus>([
  'Paid',
  'Cancelled',
]);

export function isTerminalInvoiceStatus(invoiceStatus: InvoiceStatus): boolean {
  return TERMINAL_INVOICE_STATUSES.has(invoiceStatus);
}

/** Legal targets from `from`. Cancellation is an explicit edge, not a wildcard. */
export function nextInvoiceStatuses(from: InvoiceStatus): InvoiceStatus[] {
  return INVOICE_TRANSITIONS.filter((t) => t.from === from).map((t) => t.to);
}

/**
 * Invoice states that still count as "open" against a job.
 *
 * While one of these exists the job cannot have another invoice generated:
 * two concurrent documents billing the same actuals would double-bill.
 *
 * `Partially Paid` is included deliberately. Money has been received against it,
 * but the balance is outstanding, so the document still represents an unpaid
 * claim on the same actuals. Excluding it — which an earlier draft of this module
 * did — let a progress invoice be issued on top of a part-settled one and bill
 * the same lines twice.
 *
 * Only `Paid` and `Cancelled` are closed. `Disputed` blocks because the dispute
 * may resolve back into a payable invoice.
 */
export const OPEN_INVOICE_STATUSES: ReadonlySet<InvoiceStatus> = new Set<InvoiceStatus>([
  'Draft',
  'Submitted',
  'Approved',
  'Partially Paid',
  'Disputed',
]);

export function isOpenInvoiceStatus(invoiceStatus: InvoiceStatus): boolean {
  return OPEN_INVOICE_STATUSES.has(invoiceStatus);
}

/**
 * Invoice states that count toward what a job has billed.
 *
 * Drafts and disputes bill nothing yet; cancellations bill nothing ever. Only
 * an approved-or-later document moves the job toward `10. Invoiced`.
 */
export const RECOGNISED_INVOICE_STATUSES: ReadonlySet<InvoiceStatus> = new Set<InvoiceStatus>([
  'Approved',
  'Partially Paid',
  'Paid',
]);

export function isRecognisedInvoiceStatus(invoiceStatus: InvoiceStatus): boolean {
  return RECOGNISED_INVOICE_STATUSES.has(invoiceStatus);
}

/** Whether the financial figures may still be edited (notes and due date only). */
export function canEditInvoice(invoiceStatus: InvoiceStatus): boolean {
  return invoiceStatus === 'Draft';
}

/** Whether the document may still be deleted outright. */
export function canDeleteInvoice(invoiceStatus: InvoiceStatus): boolean {
  return invoiceStatus === 'Draft' || invoiceStatus === 'Cancelled';
}

export type InvoiceTransitionRejection =
  'UNKNOWN_STATUS' | 'NO_CHANGE' | 'TERMINAL' | 'ILLEGAL' | 'MISSING_PERMISSION';

export interface InvoiceTransitionCheck {
  allowed: boolean;
  /** Present when `allowed` is true. */
  transition?: InvoiceTransition;
  /** Present when `allowed` is false. */
  rejection?: InvoiceTransitionRejection;
  /** Human-readable explanation, always populated. */
  reason: string;
  requiredPermission?: string;
}

const TRANSITIONS_BY_PAIR = new Map<string, InvoiceTransition>(
  INVOICE_TRANSITIONS.map((t) => [`${t.from} ${t.to}`, t]),
);

function findTransition(from: InvoiceStatus, to: InvoiceStatus): InvoiceTransition | undefined {
  return TRANSITIONS_BY_PAIR.get(`${from} ${to}`);
}

/**
 * Validates a proposed invoice status change.
 *
 * Separates *legality* from *authorisation*, mirroring `checkTransition` for
 * jobs: legality first, so an impossible move is reported as impossible rather
 * than as a permissions problem.
 */
export function checkInvoiceTransition(
  from: InvoiceStatus,
  to: InvoiceStatus,
): InvoiceTransitionCheck {
  if (!invoiceStatusValues.includes(from) || !invoiceStatusValues.includes(to)) {
    return { allowed: false, rejection: 'UNKNOWN_STATUS', reason: 'Unrecognised invoice status.' };
  }

  if (from === to) {
    return {
      allowed: false,
      rejection: 'NO_CHANGE',
      reason: `The invoice is already "${from}".`,
    };
  }

  if (isTerminalInvoiceStatus(from)) {
    return {
      allowed: false,
      rejection: 'TERMINAL',
      reason: `"${from}" is a terminal status and cannot change.`,
    };
  }

  const transition = findTransition(from, to);

  if (transition) {
    return { allowed: true, transition, reason: transition.reason };
  }

  return {
    allowed: false,
    rejection: 'ILLEGAL',
    reason: `"${from}" cannot move directly to "${to}".`,
  };
}

/**
 * Full check: legality plus capability.
 *
 * `MISSING_PERMISSION` means the move is legal for the business but this user
 * may not perform it — e.g. a QS submitting is fine, but approving is not.
 */
export function authoriseInvoiceTransition(
  from: InvoiceStatus,
  to: InvoiceStatus,
  permissions: ReadonlySet<string>,
): InvoiceTransitionCheck {
  const check = checkInvoiceTransition(from, to);

  if (!check.allowed || !check.transition) return check;

  if (!permissions.has(check.transition.permission)) {
    return {
      allowed: false,
      rejection: 'MISSING_PERMISSION',
      reason: `Moving from "${from}" to "${to}" requires "${check.transition.permission}".`,
      requiredPermission: check.transition.permission,
    };
  }

  return check;
}

export type { InvoiceStatus };
