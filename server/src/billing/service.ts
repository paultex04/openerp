/**
 * Billing service: invoice generation, lifecycle transitions and totals.
 *
 * Responsibilities that must not be duplicated in route handlers:
 *
 *  - **Derived figures.** Quantities come from measured actuals, prices from the
 *    `applied_rate` snapshot, VAT from the amendment, totals from the shared
 *    `computeVat`. The caller supplies at most a line subset, a due date and a
 *    note — never money. A total the client supplies is a total the client can
 *    forge.
 *  - **One open invoice per job.** Generation is refused while a Draft,
 *    Submitted, Approved or Disputed invoice exists for the job. Two concurrent
 *    documents billing the same actuals would double-bill.
 *  - **Generation-stage gating.** Invoices may only be raised once the job
 *    reaches billing ownership (`07. Pack Ready` onward). Earlier stages belong
 *    to planning and execution; letting billing book revenue against unscored
 *    work would recognise income before the scope is even committed.
 *  - **Approval moves the job.** Approving computes recognised billed totals
 *    against the job's actual total and marks the job `10. Invoiced` or
 *    `11. Partially Invoiced` via `markJobInvoiced`.
 */
import type { InvoiceStatus } from '@openerp/shared';
import {
  authoriseInvoiceTransition,
  canDeleteInvoice,
  canEditInvoice,
  checkInvoiceCompliance,
  computeVat,
  invoiceStatusFromKey,
  invoiceStatusToKey,
  jobStatusFromKey,
  nextInvoiceStatuses,
  OPEN_INVOICE_STATUSES,
  RECOGNISED_INVOICE_STATUSES,
  roundMoney,
} from '@openerp/shared';
import { prisma } from '../db/client.js';
import type { Principal as ServerPrincipal } from '../auth/principal.js';
import { HttpError } from '../auth/plugin.js';
import { markJobInvoiced, resolveJobAmendmentId } from '../operations/service.js';

export class BillingError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BillingError';
  }
}

/**
 * Job stages from which an invoice may be raised.
 *
 * Billing owns the job from pack preparation onward. Notably `09. Awaiting
 * change order` is included: a change order does not suspend billing on work
 * already documented, and the changed scope bills through its own job loop.
 */
const BILLABLE_STATUSES: ReadonlySet<string> = new Set([
  '07. Pack Ready',
  '08. Out for signature',
  '09. Awaiting change order',
  '10. Invoiced',
  '11. Partially Invoiced',
]);

/**
 * Prisma keys for the shared open/recognised sets.
 *
 * Derived from `OPEN_INVOICE_STATUSES` / `RECOGNISED_INVOICE_STATUSES` rather
 * than re-listed, so editing the lifecycle in shared cannot silently leave the
 * double-billing guard or the job-position math behind.
 */
const OPEN_KEYS = [...OPEN_INVOICE_STATUSES].map((s) => invoiceStatusToKey(s));
const RECOGNISED_KEYS = [...RECOGNISED_INVOICE_STATUSES].map((s) => invoiceStatusToKey(s));

function serialise<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      out[key] = value.toISOString().slice(0, 10);
    } else if (value !== null && typeof value === 'object' && 'toNumber' in value) {
      out[key] = (value as { toNumber(): number }).toNumber();
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Next invoice number in `INV-YYYY-MM-NNNN`, scoped to the issue month. */
async function nextInvoiceNumber(issueDate: Date): Promise<string> {
  const prefix = `INV-${issueDate.getFullYear()}-${String(issueDate.getMonth() + 1).padStart(2, '0')}-`;

  const latest = await prisma.invoice.findFirst({
    where: { invoiceNumber: { startsWith: prefix } },
    orderBy: { invoiceNumber: 'desc' },
    select: { invoiceNumber: true },
  });

  // Suffixes are zero-padded to a fixed width, so lexicographic order matches
  // numeric order and the maximum is simply the last row.
  const next = latest ? Number.parseInt(latest.invoiceNumber.slice(prefix.length), 10) + 1 : 1;

  if (!Number.isSafeInteger(next) || next < 1) {
    throw new BillingError(
      500,
      'NUMBERING_FAILED',
      `Could not derive the next invoice number after "${latest?.invoiceNumber}".`,
    );
  }

  return `${prefix}${String(next).padStart(4, '0')}`;
}

interface BillableLine {
  deliverableId: number;
  serviceCodeId: number;
  code: string;
  description: string;
  uom: string;
  billedQuantity: number;
  unitPrice: number;
  subtotal: number;
}

async function loadBillableLines(
  jobId: number,
  deliverableIds?: number[],
): Promise<{ lines: BillableLine[]; skippedZeroActual: number[] }> {
  const rows = await prisma.jobServiceCode.findMany({
    where: {
      jobId,
      ...(deliverableIds !== undefined && deliverableIds.length > 0
        ? { id: { in: deliverableIds } }
        : {}),
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      plannedQuantity: true,
      actualQuantity: true,
      appliedRate: true,
      serviceCode: { select: { id: true, code: true, description: true, uom: true } },
    },
  });

  if (deliverableIds !== undefined && deliverableIds.length > 0) {
    const found = new Set(rows.map((r) => r.id));
    const foreign = deliverableIds.filter((id) => !found.has(id));
    if (foreign.length > 0) {
      throw new BillingError(
        422,
        'LINE_NOT_ON_JOB',
        `Deliverable(s) ${foreign.join(', ')} do not belong to job ${jobId}. ` +
          'An invoice may only bill this job\u2019s own measured lines.',
      );
    }
  }

  const lines: BillableLine[] = [];
  const skippedZeroActual: number[] = [];

  for (const row of rows) {
    const actual = row.actualQuantity.toNumber();
    // Zero-actual lines are skipped, never billed as zero lines: an invoice
    // bills measured work, and a R 0.00 line is a placeholder, not a charge.
    if (actual <= 0) {
      skippedZeroActual.push(row.id);
      continue;
    }

    const unitPrice = row.appliedRate.toNumber();
    lines.push({
      deliverableId: row.id,
      serviceCodeId: row.serviceCode.id,
      code: row.serviceCode.code,
      description: row.serviceCode.description,
      uom: row.serviceCode.uom,
      billedQuantity: actual,
      unitPrice,
      subtotal: roundMoney(actual * unitPrice),
    });
  }

  return { lines, skippedZeroActual };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GenerateOutcome {
  invoice: Record<string, unknown>;
  lines: Record<string, unknown>[];
  skippedZeroActual: number[];
  compliance: { ok: boolean; warnings: string[] };
}

/**
 * Raises a draft invoice from a job's measured actuals.
 *
 * Every figure is derived. The single caller-supplied freedoms are which lines
 * to include (partial invoicing), when payment is due, and a note.
 */
export async function generateDraft(
  jobId: number,
  input: { deliverableIds?: number[]; dueDate?: string; notes?: string | null },
): Promise<GenerateOutcome> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      status: true,
      projectId: true,
      amendmentId: true,
      project: {
        select: {
          contract: {
            select: {
              client: {
                select: { id: true, name: true, vatNumber: true, isVatRegistered: true },
              },
            },
          },
        },
      },
    },
  });
  if (!job) throw new BillingError(404, 'JOB_NOT_FOUND', `Job ${jobId} does not exist.`);

  const jobStatus = jobStatusFromKey(job.status);

  if (!BILLABLE_STATUSES.has(jobStatus)) {
    throw new BillingError(
      409,
      'JOB_NOT_BILLABLE',
      `Job ${jobId} is at "${jobStatus}", which billing does not own yet. ` +
        'Invoices may be raised once the job reaches 07. Pack Ready: revenue cannot be ' +
        'recognised against work whose scope is still being planned or executed.',
    );
  }

  const open = await prisma.invoice.findFirst({
    where: {
      jobId,
      status: { in: OPEN_KEYS as never },
    },
    select: { id: true, invoiceNumber: true, status: true },
  });
  if (open) {
    throw new BillingError(
      409,
      'OPEN_INVOICE_EXISTS',
      `Job ${jobId} already has open invoice ${open.invoiceNumber} (${invoiceStatusFromKey(open.status)}). ` +
        'Submit, cancel or void it before raising another: two concurrent documents ' +
        'billing the same actuals would double-bill.',
    );
  }

  const { lines, skippedZeroActual } = await loadBillableLines(jobId, input.deliverableIds);

  if (lines.length === 0) {
    throw new BillingError(
      422,
      'NOTHING_BILLABLE',
      `Job ${jobId} has no measured actuals to bill. ` +
        'Actuals are recorded in the field view during 04. WIP to 06. Actuals in Progress; ' +
        'an invoice with no lines would be a document billing nothing.',
    );
  }

  // VAT basis: the amendment's rate, snapshot now; the client's registration
  // decides whether it applies. A non-registered client is not charged VAT —
  // the invoice is still valid, it simply carries no tax.
  const amendmentId = await resolveJobAmendmentId({
    amendmentId: job.amendmentId,
    projectId: job.projectId,
  });
  const amendment = await prisma.contractAmendment.findUniqueOrThrow({
    where: { id: amendmentId },
    select: { vatRate: true, amendmentNumber: true },
  });

  const client = job.project.contract.client;
  const computation = computeVat({
    lines: lines.map((l) => ({ quantity: l.billedQuantity, unitPrice: l.unitPrice })),
    taxRate: amendment.vatRate.toNumber(),
    isVatRegistered: client.isVatRegistered,
  });

  // Line subtotals from computeVat must equal the ones derived above: both round
  // quantity x price per line, so assert rather than trust.
  computation.lines.forEach((computed, i) => {
    if (Math.abs(computed.lineSubtotal - lines[i]!.subtotal) > 0.005) {
      throw new BillingError(
        500,
        'TOTALS_DIVERGED',
        `Line ${lines[i]!.code}: local subtotal ${lines[i]!.subtotal} disagrees with ` +
          `the VAT engine's ${computed.lineSubtotal}. Refusing to persist inconsistent figures.`,
      );
    }
  });

  const compliance = checkInvoiceCompliance({
    isVatRegistered: client.isVatRegistered,
    clientVatNumber: client.vatNumber,
    isVatCharged: computation.effectiveTaxRate > 0,
  });

  const issueDate = new Date();
  issueDate.setHours(0, 0, 0, 0);
  const dueDate = input.dueDate
    ? new Date(input.dueDate)
    : new Date(issueDate.getTime() + 30 * 86_400_000);

  // The number is unique per month; a concurrent generation could collide, so a
  // unique-violation retries once with a fresh maximum rather than failing.
  let invoiceNumber = await nextInvoiceNumber(issueDate);
  let created: { id: number };
  try {
    created = await prisma.invoice.create({
      data: {
        jobId,
        invoiceNumber,
        issueDate,
        dueDate,
        status: 'DRAFT' as never,
        totalAmount: computation.totalWithTax,
        subtotalAmount: computation.subtotalAmount,
        taxRate: computation.taxRate,
        taxAmount: computation.taxAmount,
        totalWithTax: computation.totalWithTax,
        notes: input.notes ?? null,
      },
      select: { id: true },
    });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: string }).code === 'P2002'
    ) {
      invoiceNumber = await nextInvoiceNumber(issueDate);
      created = await prisma.invoice.create({
        data: {
          jobId,
          invoiceNumber,
          issueDate,
          dueDate,
          status: 'DRAFT' as never,
          totalAmount: computation.totalWithTax,
          subtotalAmount: computation.subtotalAmount,
          taxRate: computation.taxRate,
          taxAmount: computation.taxAmount,
          totalWithTax: computation.totalWithTax,
          notes: input.notes ?? null,
        },
        select: { id: true },
      });
    } else {
      throw error;
    }
  }

  await prisma.invoiceItem.createMany({
    data: lines.map((l) => ({
      invoiceId: created.id,
      serviceCodeId: l.serviceCodeId,
      description: l.description,
      billedQuantity: l.billedQuantity,
      unitPrice: l.unitPrice,
      subtotal: l.subtotal,
    })),
  });

  const detail = await getInvoiceDetail(created.id);
  return {
    invoice: detail.invoice,
    lines: detail.lines,
    skippedZeroActual,
    compliance,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface InvoiceDetail {
  invoice: Record<string, unknown>;
  lines: Record<string, unknown>[];
  client: Record<string, unknown>;
  job: Record<string, unknown>;
  vat: {
    subtotalAmount: number;
    taxRate: number;
    effectiveTaxRate: number;
    taxAmount: number;
    totalWithTax: number;
  };
  compliance: { ok: boolean; warnings: string[] };
  permissions: {
    canEdit: boolean;
    canDelete: boolean;
    availableTransitions: string[];
  };
  jobPosition: {
    jobActualTotal: number;
    recognisedBilledTotal: number;
    remainingUnbilled: number;
  };
}

async function jobPosition(jobId: number): Promise<InvoiceDetail['jobPosition']> {
  const deliverables = await prisma.jobServiceCode.findMany({
    where: { jobId },
    select: { actualSubtotal: true },
  });
  const jobActualTotal = roundMoney(
    deliverables.reduce((sum, d) => sum + d.actualSubtotal.toNumber(), 0),
  );

  const recognised = await prisma.invoice.findMany({
    where: {
      jobId,
      status: { in: RECOGNISED_KEYS as never },
    },
    select: { totalWithTax: true },
  });
  const recognisedBilledTotal = roundMoney(
    recognised.reduce((sum, i) => sum + i.totalWithTax.toNumber(), 0),
  );

  return {
    jobActualTotal,
    recognisedBilledTotal,
    remainingUnbilled: roundMoney(jobActualTotal - recognisedBilledTotal),
  };
}

export async function getInvoiceDetail(
  invoiceId: number,
  permissions?: ReadonlySet<string>,
): Promise<InvoiceDetail> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      items: {
        orderBy: { id: 'asc' },
        include: { serviceCode: { select: { code: true, uom: true } } },
      },
      job: {
        select: {
          id: true,
          status: true,
          description: true,
          workOrder: true,
          purchaseOrder: true,
          project: {
            select: {
              id: true,
              code: true,
              contract: {
                select: {
                  id: true,
                  number: true,
                  client: {
                    select: {
                      id: true,
                      name: true,
                      vatNumber: true,
                      isVatRegistered: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!invoice)
    throw new BillingError(404, 'INVOICE_NOT_FOUND', `Invoice ${invoiceId} does not exist.`);

  const statusLabel = invoiceStatusFromKey(invoice.status);
  const taxRate = invoice.taxRate.toNumber();
  const subtotalAmount = invoice.subtotalAmount.toNumber();
  const taxAmount = invoice.taxAmount.toNumber();
  const totalWithTax = invoice.totalWithTax.toNumber();

  // The effective rate is re-derived, not trusted from storage: a non-registered
  // client must show 0 even if the stored rate says otherwise.
  const isVatRegistered = invoice.job.project.contract.client.isVatRegistered;
  const effectiveTaxRate = isVatRegistered ? taxRate : 0;

  const compliance = checkInvoiceCompliance({
    isVatRegistered,
    clientVatNumber: invoice.job.project.contract.client.vatNumber,
    isVatCharged: effectiveTaxRate > 0 && taxAmount > 0,
  });

  const position = await jobPosition(invoice.jobId);

  // Which transitions this caller could actually make right now. Without
  // permissions (internal callers) every legal target is listed.
  const availableTransitions = nextInvoiceStatuses(statusLabel).filter(
    (to) => !permissions || authoriseInvoiceTransition(statusLabel, to, permissions).allowed,
  );

  return {
    invoice: {
      ...serialise(invoice),
      status: statusLabel,
      items: undefined,
      job: undefined,
    },
    lines: invoice.items.map((item) =>
      serialise({
        ...item,
        code: item.serviceCode.code,
        uom: item.serviceCode.uom,
        serviceCode: undefined,
      }),
    ),
    client: serialise(invoice.job.project.contract.client),
    job: {
      ...serialise(invoice.job),
      status: jobStatusFromKey(invoice.job.status),
      project: serialise(invoice.job.project),
    },
    vat: { subtotalAmount, taxRate, effectiveTaxRate, taxAmount, totalWithTax },
    compliance,
    permissions: {
      canEdit: canEditInvoice(statusLabel) && (!permissions || permissions.has('invoice.write')),
      canDelete:
        (statusLabel === 'Draft' && (!permissions || permissions.has('invoice.write'))) ||
        (statusLabel === 'Cancelled' && (!permissions || permissions.has('invoice.status'))),
      availableTransitions,
    },
    jobPosition: position,
  };
}

/**
 * Lists invoices for the register, newest first.
 *
 * Client name search is included because the register is looked up by "who owes
 * us", not by document number, in practice.
 */
export async function listInvoices(filters: {
  status?: string;
  jobId?: number;
  search?: string;
}): Promise<Record<string, unknown>[]> {
  const invoices = await prisma.invoice.findMany({
    where: {
      ...(filters.status !== undefined && { status: invoiceStatusToKey(filters.status) as never }),
      ...(filters.jobId !== undefined && { jobId: filters.jobId }),
      ...(filters.search
        ? {
            OR: [
              { invoiceNumber: { contains: filters.search, mode: 'insensitive' as const } },
              {
                job: {
                  project: {
                    contract: {
                      client: { name: { contains: filters.search, mode: 'insensitive' as const } },
                    },
                  },
                },
              },
            ],
          }
        : {}),
    },
    orderBy: [{ issueDate: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      invoiceNumber: true,
      issueDate: true,
      dueDate: true,
      status: true,
      subtotalAmount: true,
      taxRate: true,
      taxAmount: true,
      totalWithTax: true,
      job: {
        select: {
          id: true,
          description: true,
          project: {
            select: {
              code: true,
              contract: { select: { number: true, client: { select: { name: true } } } },
            },
          },
        },
      },
      _count: { select: { items: true } },
    },
  });

  return invoices.map((inv) => ({
    ...serialise(inv),
    status: invoiceStatusFromKey(inv.status),
    lineCount: inv._count.items,
    _count: undefined,
  }));
}

// ---------------------------------------------------------------------------
// Draft edits and deletion
// ---------------------------------------------------------------------------

export async function updateDraft(
  invoiceId: number,
  input: { dueDate?: string; notes?: string | null },
): Promise<InvoiceDetail> {
  const existing = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, status: true },
  });
  if (!existing) {
    throw new BillingError(404, 'INVOICE_NOT_FOUND', `Invoice ${invoiceId} does not exist.`);
  }

  const label = invoiceStatusFromKey(existing.status);
  if (!canEditInvoice(label)) {
    throw new BillingError(
      409,
      'INVOICE_LOCKED',
      `Invoice ${invoiceId} is "${label}" and can no longer be edited. ` +
        'Only drafts may be edited; correcting an issued invoice needs a credit note ' +
        'or cancellation, not an in-place edit.',
    );
  }

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      ...(input.dueDate !== undefined && { dueDate: new Date(input.dueDate) }),
      ...(input.notes !== undefined && { notes: input.notes }),
    },
  });

  return getInvoiceDetail(invoiceId);
}

export async function deleteInvoice(invoiceId: number): Promise<void> {
  const existing = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, invoiceNumber: true, status: true },
  });
  if (!existing) {
    throw new BillingError(404, 'INVOICE_NOT_FOUND', `Invoice ${invoiceId} does not exist.`);
  }

  const label = invoiceStatusFromKey(existing.status);
  if (!canDeleteInvoice(label)) {
    throw new BillingError(
      409,
      'INVOICE_LOCKED',
      `Invoice ${existing.invoiceNumber} is "${label}" and cannot be deleted. ` +
        'Submitted and approved documents are financial history; cancel them instead.',
    );
  }

  await prisma.invoiceItem.deleteMany({ where: { invoiceId } });
  await prisma.invoice.delete({ where: { id: invoiceId } });
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export interface InvoiceTransitionOutcome {
  invoiceId: number;
  invoiceNumber: string;
  from: InvoiceStatus;
  to: InvoiceStatus;
  permission: string;
  reason: string;
  /** Present when approval moved the job; the new job status label. */
  jobStatus?: string;
}

/**
 * Applies an invoice status change after validating legality and capability.
 *
 * Approval additionally settles the job's billing position: recognised billed
 * totals at or above the job's actual total mark it `10. Invoiced`, anything
 * less marks it `11. Partially Invoiced`. A partial invoice therefore arises
 * naturally from billing a subset of lines — no separate flag is needed, and no
 * flag can disagree with the money.
 */
export async function transitionInvoice(
  invoiceId: number,
  to: InvoiceStatus,
  principal: ServerPrincipal,
): Promise<InvoiceTransitionOutcome> {
  const existing = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, invoiceNumber: true, status: true, jobId: true, totalWithTax: true },
  });
  if (!existing) {
    throw new BillingError(404, 'INVOICE_NOT_FOUND', `Invoice ${invoiceId} does not exist.`);
  }

  const from = invoiceStatusFromKey(existing.status);
  const check = authoriseInvoiceTransition(from, to, principal.permissions);

  if (!check.allowed) {
    if (check.rejection === 'MISSING_PERMISSION') {
      throw new BillingError(403, 'TRANSITION_FORBIDDEN', check.reason);
    }
    if (check.rejection === 'ILLEGAL') {
      throw new BillingError(422, 'ILLEGAL_TRANSITION', check.reason);
    }
    if (check.rejection === 'TERMINAL' || check.rejection === 'NO_CHANGE') {
      throw new BillingError(409, 'INVALID_TRANSITION', check.reason);
    }
    throw new BillingError(400, 'INVALID_TRANSITION', check.reason);
  }

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: invoiceStatusToKey(to) as never },
  });

  let jobStatus: string | undefined;
  if (to === 'Approved') {
    // Recognised totals now include this invoice. Compare against the job's
    // actual total with a cent of tolerance for rounding dust.
    const position = await jobPosition(existing.jobId);
    const fullyBilled =
      position.recognisedBilledTotal + existing.totalWithTax.toNumber() >=
      position.jobActualTotal - 0.005;
    await markJobInvoiced(existing.jobId, !fullyBilled);
    jobStatus = fullyBilled ? '10. Invoiced' : '11. Partially Invoiced';
  }

  return {
    invoiceId,
    invoiceNumber: existing.invoiceNumber,
    from,
    to,
    permission: check.transition!.permission,
    reason: check.transition!.reason,
    jobStatus,
  };
}

export function toHttpError(error: unknown): never {
  if (error instanceof BillingError) {
    throw new HttpError(error.statusCode, error.code, error.message);
  }
  throw error;
}
