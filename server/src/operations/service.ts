/**
 * Operations service: projects, jobs, job status transitions, deliverables and
 * assignments.
 *
 * Responsibilities that must not be duplicated in route handlers:
 *
 *  - **Amendment resolution.** A job with a null `amendment_id` inherits its
 *    project's. Resolved centrally so every read path agrees.
 *  - **Transition authorisation.** Legality comes from the shared state machine;
 *    capability comes from the principal. Both are checked here.
 *  - **Scope locking.** Planned quantities freeze once a job is released for
 *    procurement; actuals are only recordable during execution.
 *  - **Price snapshots.** `applied_rate` is written once and never recomputed.
 */
import type { JobStatus } from '@openerp/shared';
import {
  actualsLockReason,
  aggregateTotals,
  authoriseTransition,
  canEditActuals,
  canEditPlanned,
  computeDeliverableTotals,
  jobStatusFromKey,
  jobStatusToKey,
  plannedLockReason,
  roundMoney,
  roundRate,
  type DeliverableTotals,
} from '@openerp/shared';
import { prisma } from '../db/client.js';
import type { Principal } from '../auth/principal.js';

export class OperationsError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OperationsError';
  }
}

/**
 * Resolves which amendment a job prices against.
 *
 * The rule from the specification: a null `job.amendment_id` inherits
 * `project.amendment_id`. This is what lets a job be raised against a project
 * without repeating commercial detail, while still allowing one job to opt into
 * a different amendment when a change order lands.
 */
export async function resolveJobAmendmentId(job: {
  amendmentId: number | null;
  projectId: number;
}): Promise<number> {
  if (job.amendmentId !== null) return job.amendmentId;

  const project = await prisma.project.findUnique({
    where: { id: job.projectId },
    select: { amendmentId: true },
  });

  if (!project) {
    throw new OperationsError(404, 'PROJECT_NOT_FOUND', `Project ${job.projectId} does not exist.`);
  }

  return project.amendmentId;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export interface TransitionOutcome {
  jobId: number;
  from: JobStatus;
  to: JobStatus;
  fromKey: string;
  toKey: string;
  permission: string;
  reason: string;
}

/**
 * Applies a job status change after validating legality and capability.
 *
 * Ordering matters: the state machine is consulted first so an illegal jump is
 * reported as illegal even for a user who would not have been allowed to make it
 * anyway. That keeps the error message honest rather than masking a bug in the
 * requested transition behind a permissions error.
 */
export async function transitionJob(
  jobId: number,
  to: JobStatus,
  principal: Principal,
): Promise<TransitionOutcome> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, status: true, projectId: true, amendmentId: true },
  });

  if (!job) throw new OperationsError(404, 'JOB_NOT_FOUND', `Job ${jobId} does not exist.`);

  const from = jobStatusFromKey(job.status);

  const check = authoriseTransition(from, to, principal.permissions);

  if (!check.allowed) {
    // Distinguish "you may not" from "that is not a thing", because the two need
    // very different fixes from the user.
    if (check.rejection === 'MISSING_PERMISSION') {
      throw new OperationsError(403, 'TRANSITION_FORBIDDEN', check.reason);
    }
    if (check.rejection === 'ILLEGAL') {
      throw new OperationsError(422, 'ILLEGAL_TRANSITION', check.reason);
    }
    if (check.rejection === 'TERMINAL' || check.rejection === 'NO_CHANGE') {
      throw new OperationsError(409, 'INVALID_TRANSITION', check.reason);
    }
    throw new OperationsError(400, 'INVALID_TRANSITION', check.reason);
  }

  const updated = await prisma.job.update({
    where: { id: jobId },
    data: { status: jobStatusToKey(to) as never },
    select: { status: true },
  });

  return {
    jobId,
    from,
    to,
    fromKey: job.status,
    toKey: updated.status,
    permission: check.transition!.permission,
    reason: check.transition!.reason,
  };
}

/**
 * Transitions a job to `10. Invoiced` or `11. Partially Invoiced` when an
 * invoice is submitted or approved (Phase 4 hook).
 *
 * Kept separate from the HTTP route because it is driven by the invoice
 * lifecycle rather than by a user clicking a button, and it must bypass the
 * interactive capability check — the billing clerk's invoice action is the
 * authority, not a separate job transition.
 */
export async function markJobInvoiced(jobId: number, partially: boolean): Promise<void> {
  const target: JobStatus = partially ? '11. Partially Invoiced' : '10. Invoiced';

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { status: true },
  });
  if (!job) throw new OperationsError(404, 'JOB_NOT_FOUND', `Job ${jobId} does not exist.`);

  const from = jobStatusFromKey(job.status);
  if (from === target) return; // already in the desired state

  // Billing must own invoicing, but an administrator may also drive this.
  await prisma.job.update({
    where: { id: jobId },
    data: { status: jobStatusToKey(target) as never },
  });
}

// ---------------------------------------------------------------------------
// Deliverables
// ---------------------------------------------------------------------------

export interface DeliverableView extends DeliverableTotals {
  id: number;
  jobId: number;
  serviceCodeId: number;
  code: string;
  description: string;
  category: string;
  uom: string;
  /**
   * The immutable price snapshot, in ZAR per unit.
   *
   * Exposed explicitly because the deliverable grid must show it, and because
   * seeing the frozen figure beside the current service code rate is how a QS
   * notices drift. It is never recomputed.
   */
  appliedRate: number;
  plannedLocked: boolean;
  plannedLockReason: string | null;
  actualsLocked: boolean;
  actualsLockReason: string | null;
}

/**
 * Loads a job's deliverables with computed variance.
 *
 * `currentServiceCodeRate` is fetched purely so the UI can flag that a rate card
 * moved after scoping. It never participates in a subtotal.
 */
export async function listDeliverables(jobId: number): Promise<DeliverableView[]> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { status: true },
  });
  if (!job) throw new OperationsError(404, 'JOB_NOT_FOUND', `Job ${jobId} does not exist.`);

  const status = jobStatusFromKey(job.status);
  const plannedLocked = !canEditPlanned(status);
  const actualsLocked = !canEditActuals(status);
  const plannedReason = plannedLockReason(status);
  const actualsReason = actualsLockReason(status);

  const rows = await prisma.jobServiceCode.findMany({
    where: { jobId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      jobId: true,
      serviceCodeId: true,
      plannedQuantity: true,
      actualQuantity: true,
      appliedRate: true,
      serviceCode: {
        select: {
          code: true,
          description: true,
          category: true,
          uom: true,
          calculatedUnitRate: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    jobId: row.jobId,
    serviceCodeId: row.serviceCodeId,
    code: row.serviceCode.code,
    description: row.serviceCode.description,
    category: row.serviceCode.category,
    uom: row.serviceCode.uom,
    appliedRate: row.appliedRate.toNumber(),
    ...computeDeliverableTotals({
      plannedQuantity: row.plannedQuantity.toString(),
      actualQuantity: row.actualQuantity.toString(),
      appliedRate: row.appliedRate.toString(),
      currentServiceCodeRate: row.serviceCode.calculatedUnitRate.toString(),
    }),
    plannedLocked,
    plannedLockReason: plannedReason,
    actualsLocked,
    actualsLockReason: actualsReason,
  }));
}

/** Aggregate planned vs actual position for a job. */
export async function jobVarianceSummary(jobId: number) {
  const deliverables = await listDeliverables(jobId);
  return aggregateTotals(deliverables);
}

async function loadJobStatus(jobId: number): Promise<JobStatus> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { status: true },
  });
  if (!job) throw new OperationsError(404, 'JOB_NOT_FOUND', `Job ${jobId} does not exist.`);
  return jobStatusFromKey(job.status);
}

/**
 * Attaches a service code to a job and snapshots its current unit rate.
 *
 * The snapshot is the whole point: `applied_rate` is written once here and never
 * recomputed, so re-pricing the service code later cannot retroactively change
 * this job's commercial position.
 */
export async function addDeliverable(
  jobId: number,
  serviceCodeId: number,
  plannedQuantity: number,
  appliedRateOverride?: number,
): Promise<DeliverableView[]> {
  const status = await loadJobStatus(jobId);

  if (!canEditPlanned(status)) {
    throw new OperationsError(
      409,
      'SCOPE_FROZEN',
      plannedLockReason(status) ?? 'Planned quantities are frozen for this job.',
    );
  }

  const serviceCode = await prisma.serviceCode.findUnique({
    where: { id: serviceCodeId },
    select: { id: true, amendmentId: true, calculatedUnitRate: true },
  });
  if (!serviceCode) {
    throw new OperationsError(
      400,
      'INVALID_REFERENCE',
      `Service code ${serviceCodeId} does not exist.`,
    );
  }

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { projectId: true, amendmentId: true },
  });
  if (!job) throw new OperationsError(404, 'JOB_NOT_FOUND', `Job ${jobId} does not exist.`);

  const jobAmendmentId = await resolveJobAmendmentId({
    amendmentId: job.amendmentId,
    projectId: job.projectId,
  });

  // Rates and service codes are amendment-scoped, so mixing them would price a
  // job against a contract it is not covered by.
  if (serviceCode.amendmentId !== jobAmendmentId) {
    throw new OperationsError(
      422,
      'AMENDMENT_MISMATCH',
      `Service code ${serviceCodeId} belongs to amendment ${serviceCode.amendmentId}, but this ` +
        `job prices against amendment ${jobAmendmentId}.`,
    );
  }

  const appliedRate =
    appliedRateOverride !== undefined
      ? appliedRateOverride
      : serviceCode.calculatedUnitRate.toNumber();

  const plannedSubtotal = roundMoney(plannedQuantity * appliedRate);

  await prisma.jobServiceCode.create({
    data: {
      jobId,
      serviceCodeId,
      plannedQuantity,
      actualQuantity: 0,
      appliedRate,
      plannedSubtotal,
      actualSubtotal: 0,
    },
  });

  return listDeliverables(jobId);
}

/** Updates a planned quantity. Refused once the scope is committed. */
export async function updatePlannedQuantity(
  deliverableId: number,
  plannedQuantity: number,
): Promise<DeliverableView[]> {
  const existing = await prisma.jobServiceCode.findUnique({
    where: { id: deliverableId },
    select: { id: true, jobId: true, appliedRate: true },
  });
  if (!existing) {
    throw new OperationsError(
      404,
      'DELIVERABLE_NOT_FOUND',
      `Deliverable ${deliverableId} does not exist.`,
    );
  }

  const status = await loadJobStatus(existing.jobId);

  if (!canEditPlanned(status)) {
    throw new OperationsError(
      409,
      'SCOPE_FROZEN',
      plannedLockReason(status) ?? 'Planned quantities are frozen for this job.',
    );
  }

  // Recomputed from the stored snapshot rate, never from the service code.
  await prisma.jobServiceCode.update({
    where: { id: deliverableId },
    data: {
      plannedQuantity,
      plannedSubtotal: roundMoney(plannedQuantity * existing.appliedRate.toNumber()),
    },
  });

  return listDeliverables(existing.jobId);
}

/**
 * Records an actual quantity measured in the field.
 *
 * Only the actual subtotal is recomputed; the planned figure and the price
 * snapshot are untouched, so variance is a derived fact rather than an edit.
 */
export async function updateActualQuantity(
  deliverableId: number,
  actualQuantity: number,
): Promise<DeliverableView[]> {
  const existing = await prisma.jobServiceCode.findUnique({
    where: { id: deliverableId },
    select: { id: true, jobId: true, appliedRate: true },
  });
  if (!existing) {
    throw new OperationsError(
      404,
      'DELIVERABLE_NOT_FOUND',
      `Deliverable ${deliverableId} does not exist.`,
    );
  }

  const status = await loadJobStatus(existing.jobId);

  if (!canEditActuals(status)) {
    throw new OperationsError(
      409,
      'ACTUALS_LOCKED',
      actualsLockReason(status) ?? 'Actuals cannot be recorded at this stage.',
    );
  }

  await prisma.jobServiceCode.update({
    where: { id: deliverableId },
    data: {
      actualQuantity,
      actualSubtotal: roundMoney(actualQuantity * existing.appliedRate.toNumber()),
    },
  });

  return listDeliverables(existing.jobId);
}

/** Removes a deliverable. Only while the scope is still editable. */
export async function removeDeliverable(deliverableId: number): Promise<void> {
  const existing = await prisma.jobServiceCode.findUnique({
    where: { id: deliverableId },
    select: { id: true, jobId: true },
  });
  if (!existing) {
    throw new OperationsError(
      404,
      'DELIVERABLE_NOT_FOUND',
      `Deliverable ${deliverableId} does not exist.`,
    );
  }

  const status = await loadJobStatus(existing.jobId);
  if (!canEditPlanned(status)) {
    throw new OperationsError(
      409,
      'SCOPE_FROZEN',
      plannedLockReason(status) ?? 'The scope of this job is frozen.',
    );
  }

  await prisma.jobServiceCode.delete({ where: { id: deliverableId } });
}

export { roundRate };
