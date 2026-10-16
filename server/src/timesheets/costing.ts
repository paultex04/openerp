/**
 * Per-job costing: assembling the inputs the shared engine needs.
 *
 * `@openerp/shared/costing` owns the arithmetic — this module only gathers the
 * four things it asks for:
 *
 *   plans     the recipe's planned hours (crew × hours/unit × planned qty),
 *             costed at the amendment's rate card, all derived from
 *             `service_code_labour_item` and needing no new data,
 *   entries   approved timesheet lines, read at their frozen `cost_amount`,
 *   materials material cost from each deliverable's snapshotted BOM × actual qty,
 *   revenue   `job_service_code.actual_subtotal` (work done) and non-cancelled
 *             invoice subtotals (billed).
 *
 * ## Why it is computed on read
 *
 * There is no cache. A job's revenue moves whenever someone records an actual,
 * its planned hours whenever someone scopes a deliverable, its cost whenever a
 * week is approved — three modules writing to three different tables. A cache
 * would have to be invalidated from all of them, and the one place an
 * invalidation was forgotten is exactly the place a margin would be wrong.
 * Recomputing from base rows is a handful of indexed queries and cannot be
 * stale. See ADR-012.
 */
import {
  costRateForBasis,
  summariseJobCosting,
  type ActualLabourLine,
  type JobCostingSummary,
  type MaterialCostLine,
  type PlannedLabourLine,
} from '@openerp/shared';
import { prisma } from '../db/client.js';
import type { Prisma } from '../generated/prisma/client.js';
import { TimesheetError } from './errors.js';
import { RATE_COMPONENT_SELECT, componentsOf } from './rates.js';

/** Material lines snapshotted on a deliverable (Phase 8's provenance blob). */
interface SnapshotMaterial {
  unitCost: string;
  quantity: string;
}

function snapshotMaterials(snapshot: unknown): SnapshotMaterial[] | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const material = (snapshot as { material?: unknown }).material;
  if (!Array.isArray(material)) return null;
  const parsed: SnapshotMaterial[] = [];
  for (const line of material) {
    if (!line || typeof line !== 'object') return null;
    const { unitCost, quantity } = line as { unitCost?: unknown; quantity?: unknown };
    if (unitCost === undefined || quantity === undefined) return null;
    parsed.push({ unitCost: String(unitCost), quantity: String(quantity) });
  }
  return parsed;
}

/**
 * Everything needed to cost one job, or a page of them. Pulled in a single
 * `findMany` so the profitability register does not fire N queries per job.
 */
const JOB_COSTING_SELECT = {
  id: true,
  workOrder: true,
  area: true,
  description: true,
  status: true,
  project: {
    select: {
      code: true,
      contract: { select: { number: true, client: { select: { name: true } } } },
    },
  },
  serviceCodes: {
    select: {
      plannedQuantity: true,
      actualQuantity: true,
      actualSubtotal: true,
      snapshotSource: true,
      serviceCode: {
        select: {
          labourItems: {
            select: {
              crewQuantity: true,
              hoursPerUnit: true,
              serviceMasterRate: {
                select: { labourType: true, shiftType: true, ...RATE_COMPONENT_SELECT },
              },
            },
          },
          materialItems: { select: { unitCost: true, quantity: true } },
        },
      },
    },
  },
  invoices: { select: { status: true, subtotalAmount: true } },
} satisfies Prisma.JobSelect;

type JobCostingRow = Prisma.JobGetPayload<{ select: typeof JOB_COSTING_SELECT }>;

export interface JobCostingView extends JobCostingSummary {
  jobId: number;
  job: {
    id: number;
    workOrder: string | null;
    area: string | null;
    description: string | null;
    status: string;
    projectCode: string;
    contractNumber: string;
    clientName: string;
  };
}

function assemble(job: JobCostingRow, entries: ActualLabourLine[]): JobCostingView {
  const plans: PlannedLabourLine[] = [];
  const materials: MaterialCostLine[] = [];
  let revenueActual = 0;

  for (const scope of job.serviceCodes) {
    revenueActual += scope.actualSubtotal.toNumber();

    // Planned labour: derived entirely from the recipe, no stored hours needed.
    for (const labour of scope.serviceCode.labourItems) {
      plans.push({
        plannedQuantity: scope.plannedQuantity.toString(),
        crewQuantity: labour.crewQuantity.toString(),
        hoursPerUnit: labour.hoursPerUnit.toString(),
        labourType: labour.serviceMasterRate.labourType,
        shiftType: labour.serviceMasterRate.shiftType,
        costRate: costRateForBasis(componentsOf(labour.serviceMasterRate)),
      });
    }

    // Material cost at the quantity actually delivered. Prefer the deliverable's
    // snapshotted BOM so a later master-data edit cannot rewrite history; fall
    // back to the live recipe for rows backfilled before snapshots existed.
    const actualQuantity = scope.actualQuantity.toNumber();
    const snapshot = snapshotMaterials(scope.snapshotSource);
    const materialLines =
      snapshot ??
      scope.serviceCode.materialItems.map((line) => ({
        unitCost: line.unitCost.toString(),
        quantity: line.quantity.toString(),
      }));

    for (const line of materialLines) {
      materials.push({
        quantity: Number(line.quantity) * actualQuantity,
        unitCost: line.unitCost,
      });
    }
  }

  const revenueInvoiced = job.invoices
    .filter((invoice) => invoice.status !== 'CANCELLED')
    .reduce((sum, invoice) => sum + invoice.subtotalAmount.toNumber(), 0);

  return {
    jobId: job.id,
    job: {
      id: job.id,
      workOrder: job.workOrder,
      area: job.area,
      description: job.description,
      status: job.status,
      projectCode: job.project.code,
      contractNumber: job.project.contract.number,
      clientName: job.project.contract.client.name,
    },
    ...summariseJobCosting({ plans, materials, entries, revenueActual, revenueInvoiced }),
  };
}

/** Approved timesheet lines for a set of jobs, grouped by job. */
async function approvedLabour(jobIds: number[]): Promise<Map<number, ActualLabourLine[]>> {
  const grouped = new Map<number, ActualLabourLine[]>();
  if (jobIds.length === 0) return grouped;

  const entries = await prisma.timesheetEntry.findMany({
    where: { jobId: { in: jobIds }, timesheet: { status: 'APPROVED' } },
    select: {
      jobId: true,
      hours: true,
      labourType: true,
      shiftType: true,
      costAmount: true,
      isBillable: true,
    },
  });

  for (const entry of entries) {
    const list = grouped.get(entry.jobId) ?? [];
    list.push({
      hours: entry.hours.toString(),
      labourType: entry.labourType,
      shiftType: entry.shiftType,
      // Frozen at approval; a null here would mean an approved line that was
      // never priced, which approval does not permit.
      costAmount: (entry.costAmount ?? 0).toString(),
      isBillable: entry.isBillable,
    });
    grouped.set(entry.jobId, list);
  }

  return grouped;
}

/** Costing for one job. */
export async function jobCosting(jobId: number): Promise<JobCostingView> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: JOB_COSTING_SELECT });
  if (!job) throw new TimesheetError(404, 'JOB_NOT_FOUND', `Job ${jobId} does not exist.`);

  const labour = await approvedLabour([jobId]);
  return assemble(job, labour.get(jobId) ?? []);
}

export interface JobCostingFilters {
  /** Free text over work order, area, description and project code. */
  search?: string;
  /** Only jobs that have approved hours (default) or every job with a scope. */
  withHoursOnly?: boolean;
  limit?: number;
}

/** The profitability register: many jobs, costed in two queries. */
export async function listJobCosting(filters: JobCostingFilters = {}): Promise<JobCostingView[]> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const search = filters.search?.trim();

  const jobs = await prisma.job.findMany({
    where: {
      ...(filters.withHoursOnly
        ? { timesheetEntries: { some: { timesheet: { status: 'APPROVED' } } } }
        : {}),
      ...(search
        ? {
            OR: [
              { workOrder: { contains: search, mode: 'insensitive' } },
              { area: { contains: search, mode: 'insensitive' } },
              { description: { contains: search, mode: 'insensitive' } },
              { project: { code: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    orderBy: { id: 'desc' },
    take: limit,
    select: JOB_COSTING_SELECT,
  });

  const labour = await approvedLabour(jobs.map((job) => job.id));
  return jobs.map((job) => assemble(job, labour.get(job.id) ?? []));
}
