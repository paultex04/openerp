/**
 * Cost-rate resolution for timesheet lines.
 *
 * A line's cost is `hours × costRate`, and the rate is the **employee's own
 * `employee.rate`**, or a manual override typed on the line. The job amendment's
 * rate card is deliberately *not* consulted: a person costs their rate per hour
 * whatever trade code the line carries. See ADR-012.
 *
 * `loadJobRateCard` remains because the costing engine still prices *planned*
 * hours from the amendment's Tier-1 card, and the line editor offers the card's
 * labour types as suggestions — but neither decides what an hour cost.
 */
import {
  MissingCostRateError,
  resolveCostRate,
  type CostRateSource,
  type LabourRateComponents,
} from '@openerp/shared';
import { prisma } from '../db/client.js';
import { resolveJobAmendmentId } from '../operations/service.js';
import { TimesheetError } from './errors.js';

/** The component columns of `service_master_rates` shared can cost from. */
export const RATE_COMPONENT_SELECT = {
  manInPocket: true,
  leavePay: true,
  totalStatutoryCost: true,
  ppeCost: true,
  transportCost: true,
  equipmentCost: true,
  overheadCost: true,
  sgaCost: true,
  profitCost: true,
  fullLoadedRate: true,
} as const;

type ComponentSource = Record<keyof typeof RATE_COMPONENT_SELECT, { toString(): string }>;

export function componentsOf(row: ComponentSource): LabourRateComponents {
  return {
    manInPocket: row.manInPocket.toString(),
    leavePay: row.leavePay.toString(),
    totalStatutoryCost: row.totalStatutoryCost.toString(),
    ppeCost: row.ppeCost.toString(),
    transportCost: row.transportCost.toString(),
    equipmentCost: row.equipmentCost.toString(),
    overheadCost: row.overheadCost.toString(),
    sgaCost: row.sgaCost.toString(),
    profitCost: row.profitCost.toString(),
    fullLoadedRate: row.fullLoadedRate.toString(),
  };
}

export interface RateRow {
  id: number;
  labourType: string;
  /** Prisma enum key ('NT' | 'OT' | …). */
  shiftType: string;
  components: LabourRateComponents;
}

export interface JobRateCard {
  jobId: number;
  amendmentId: number;
  rates: RateRow[];
  /** `labourType\u0000shiftKey` -> row. */
  index: Map<string, RateRow>;
}

export function rateKey(labourType: string, shiftKey: string): string {
  return `${labourType}\u0000${shiftKey}`;
}

/** The Tier-1 rate card for the amendment a job prices against. */
export async function loadJobRateCard(jobId: number): Promise<JobRateCard> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, amendmentId: true, projectId: true },
  });
  if (!job) throw new TimesheetError(404, 'JOB_NOT_FOUND', `Job ${jobId} does not exist.`);

  const amendmentId = await resolveJobAmendmentId(job);

  const rows = await prisma.serviceMasterRate.findMany({
    where: { amendmentId },
    orderBy: [{ labourType: 'asc' }, { shiftType: 'asc' }],
    select: { id: true, labourType: true, shiftType: true, ...RATE_COMPONENT_SELECT },
  });

  const rates: RateRow[] = rows.map((row) => ({
    id: row.id,
    labourType: row.labourType,
    shiftType: row.shiftType,
    components: componentsOf(row),
  }));

  return {
    jobId,
    amendmentId,
    rates,
    index: new Map(rates.map((rate) => [rateKey(rate.labourType, rate.shiftType), rate])),
  };
}

export async function loadEmployeeRate(employeeId: number): Promise<number | null> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { rate: true },
  });
  if (!employee) {
    throw new TimesheetError(404, 'EMPLOYEE_NOT_FOUND', `Employee ${employeeId} does not exist.`);
  }
  return employee.rate ? employee.rate.toNumber() : null;
}

export interface ResolvedLineRate {
  costRate: number;
  source: CostRateSource;
  /** What approval freezes into `rate_snapshot`. */
  snapshot: Record<string, unknown>;
}

/**
 * Resolves a line's cost rate: an override, else the employee's rate.
 *
 * `employeeId` is carried only into the error message and the snapshot, so a
 * frozen line records whose rate it was priced at.
 */
export function resolveLineRate(params: {
  employeeId: number;
  employeeRate?: number | null;
  overrideRate?: number | null;
}): ResolvedLineRate {
  try {
    const resolved = resolveCostRate({
      overrideRate: params.overrideRate ?? null,
      // The rate card is not a cost source for hours any more.
      candidate: null,
      employeeRate: params.employeeRate ?? null,
    });

    return {
      costRate: resolved.costRate,
      source: resolved.source,
      snapshot: {
        capturedAt: new Date().toISOString(),
        source: resolved.source,
        costRate: resolved.costRate,
        employeeId: params.employeeId,
      },
    };
  } catch (error) {
    if (error instanceof MissingCostRateError) {
      throw new TimesheetError(
        422,
        'EMPLOYEE_RATE_REQUIRED',
        'This employee has no hourly cost rate, so their hours cannot be priced. ' +
          'Set a rate on the employee record, or an override on the line.',
      );
    }
    throw error;
  }
}
