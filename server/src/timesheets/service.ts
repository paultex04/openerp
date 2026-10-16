/**
 * Timesheet service: the week lifecycle and the line maths.
 *
 * ## The shape of a week
 *
 * `timesheet` is one row per (employee, Monday). It is the unit of approval: a
 * line is never approved on its own, because approving hours is a statement
 * about a person's week, not about one job's afternoon. Approving the header
 * freezes every line's cost in one pass (see {@link approve}).
 *
 * ## What this module owns
 *
 *  - **Week arithmetic.** `period_end` is always Monday + 6, computed here, so a
 *    client cannot open a header whose bounds contradict its own start.
 *  - **Editability.** DRAFT and REJECTED lines are the author's to write;
 *    SUBMITTED is frozen pending a decision. APPROVED is amendable **in place by
 *    an approver** (the line is re-frozen as it is corrected), or can be sent
 *    back to draft with {@link reopen}. Both paths are audited.
 *  - **Cost freezing.** A line's cost is the employee's own hourly rate (or a
 *    typed override), and the resolved rate is written with the cost amount, so a
 *    margin reported today is reproducible in a year. See ADR-012.
 *  - **Who may do what.** Capability (`timesheet.write*`, `.approve`,
 *    `.override`) is checked here rather than only in the route, because the
 *    rules depend on the row being edited, not just the endpoint.
 */
import {
  entryCost,
  shiftTypeFromKey,
  shiftTypeToKey,
  timesheetStatusFromKey,
  type CostRateSource,
  type ShiftType,
  type TimesheetStatus,
} from '@openerp/shared';
import { prisma } from '../db/client.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Principal } from '../auth/principal.js';
import { TimesheetError } from './errors.js';
import { loadEmployeeRate, resolveLineRate } from './rates.js';

// ---------------------------------------------------------------------------
// Week arithmetic
// ---------------------------------------------------------------------------

function parseIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function toIso(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** The Monday of the week containing `value`. */
export function mondayOf(value: string): Date {
  const date = parseIsoDate(value);
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - sinceMonday);
  return date;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

/** Monday of the week it currently is, in UTC. */
export function currentWeekStart(): Date {
  return mondayOf(toIso(new Date()));
}

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

function can(principal: Principal, permission: string): boolean {
  return principal.permissions.has(permission);
}

function assertRead(employeeId: number, principal: Principal): void {
  if (can(principal, 'timesheet.read')) return;
  if (can(principal, 'timesheet.read.own') && employeeId === principal.employeeId) return;
  throw new TimesheetError(403, 'TIMESHEET_FORBIDDEN', 'You may not view this timesheet.');
}

function assertWrite(employeeId: number, principal: Principal): void {
  if (can(principal, 'timesheet.write')) return;
  if (can(principal, 'timesheet.write.own') && employeeId === principal.employeeId) return;
  throw new TimesheetError(403, 'TIMESHEET_FORBIDDEN', 'You may not edit this timesheet.');
}

/**
 * Whether `principal` may decide a week.
 *
 * Approval is **capability-based only**: any holder of `timesheet.approve` — the
 * project managers, the commercial desk and administrators — may approve or
 * reject *any* week, whoever submitted it, including their own. The employee's
 * `manager` no longer gates it, and there is no self-approval exclusion. The
 * route demands the permission as well; this is the in-service re-check, which
 * also guards the amend-in-place path (an approved week is writable only by an
 * approver).
 */
function assertCanApprove(principal: Principal): void {
  if (can(principal, 'timesheet.approve')) return;
  throw new TimesheetError(403, 'FORBIDDEN', 'You may not approve timesheets.');
}

function canApprove(principal: Principal): boolean {
  return can(principal, 'timesheet.approve');
}

/**
 * A supervisor may log time only to jobs they are on. Holding `job.read` (a PM,
 * an administrator) lifts the restriction entirely.
 */
async function assertCanLogToJob(jobId: number, principal: Principal): Promise<void> {
  if (can(principal, 'job.read')) return;
  const [assigned, supervised] = await Promise.all([
    prisma.jobAssignment.findFirst({ where: { jobId, employeeId: principal.employeeId } }),
    prisma.job.findFirst({ where: { id: jobId, supervisorId: principal.employeeId } }),
  ]);
  if (!assigned && !supervised) {
    throw new TimesheetError(
      403,
      'JOB_NOT_ASSIGNED',
      'You may only log time to jobs you are assigned to or supervise.',
    );
  }
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export type PreviewSource = CostRateSource | 'unpriced';

export interface TimesheetEntryView {
  id: number;
  jobId: number;
  job: {
    id: number;
    workOrder: string | null;
    area: string | null;
    description: string | null;
  } | null;
  jobServiceCodeId: number | null;
  workDate: string;
  labourType: string;
  shiftType: ShiftType;
  hours: number;
  isBillable: boolean;
  notes: string | null;
  costRateOverride: number | null;
  overrideReason: string | null;
  /** Frozen at approval; null while editable. */
  costRate: number | null;
  costAmount: number | null;
  /** What approval would freeze right now — shown live in the grid. */
  preview: { costRate: number; costAmount: number; source: PreviewSource; priced: boolean };
}

export interface TimesheetView {
  id: number;
  employeeId: number;
  employee: { id: number; name: string; surname: string };
  periodStart: string;
  periodEnd: string;
  status: TimesheetStatus;
  notes: string | null;
  submittedAt: string | null;
  submittedBy: { id: number; email: string } | null;
  decidedAt: string | null;
  decidedBy: { id: number; email: string } | null;
  decisionNote: string | null;
  canEdit: boolean;
  /** An approved week that this approver may correct in place. */
  canAmend: boolean;
  canApprove: boolean;
  totals: { hours: number; cost: number; unpricedLines: number };
  entries: TimesheetEntryView[];
}

const ENTRY_SELECT = {
  id: true,
  jobId: true,
  jobServiceCodeId: true,
  workDate: true,
  labourType: true,
  shiftType: true,
  hours: true,
  isBillable: true,
  notes: true,
  costRateOverride: true,
  overrideReason: true,
  costRate: true,
  costAmount: true,
  job: { select: { id: true, workOrder: true, area: true, description: true } },
} satisfies Prisma.TimesheetEntrySelect;

const TIMESHEET_SELECT = {
  id: true,
  employeeId: true,
  periodStart: true,
  periodEnd: true,
  status: true,
  notes: true,
  submittedAt: true,
  decidedAt: true,
  decisionNote: true,
  employee: { select: { id: true, name: true, surname: true, managerId: true } },
  submittedBy: { select: { id: true, email: true } },
  decidedBy: { select: { id: true, email: true } },
  entries: { select: ENTRY_SELECT, orderBy: [{ workDate: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.TimesheetSelect;

type TimesheetRow = Prisma.TimesheetGetPayload<{ select: typeof TIMESHEET_SELECT }>;
type EntryRow = TimesheetRow['entries'][number];

/**
 * An entry, its employee and its week, flattened for the job's Timesheets tab.
 *
 * The select carries `timesheet` because a line on a job must say *whose* week it
 * belongs to and whether that week was approved — the fields the cost column
 * depends on: an approved line's cost is frozen, a draft's is the live preview.
 */
const JOB_ENTRY_SELECT = {
  id: true,
  workDate: true,
  labourType: true,
  shiftType: true,
  hours: true,
  isBillable: true,
  notes: true,
  costRateOverride: true,
  costRate: true,
  costAmount: true,
  timesheet: {
    select: {
      id: true,
      status: true,
      periodStart: true,
      periodEnd: true,
      employeeId: true,
      employee: { select: { id: true, name: true, surname: true, rate: true } },
    },
  },
} satisfies Prisma.TimesheetEntrySelect;

/**
 * Prices every line of a week, tolerating an unresolvable rate.
 *
 * The only way a line is unpriced is an employee with no `rate` and no override —
 * a state the employee form now prevents, but which legacy rows can still hold.
 * It must not turn the whole week into a 500: the grid shows the line as
 * "unpriced" and approval refuses it. Anything other than that known case is a
 * genuine fault and is re-thrown.
 */
async function previewFor(
  entries: EntryRow[],
  employeeId: number,
): Promise<Map<number, TimesheetEntryView['preview']>> {
  const result = new Map<number, TimesheetEntryView['preview']>();
  if (entries.length === 0) return result;

  const employeeRate = await loadEmployeeRate(employeeId);

  for (const entry of entries) {
    try {
      const resolved = resolveLineRate({
        employeeId,
        employeeRate,
        overrideRate: entry.costRateOverride ? entry.costRateOverride.toNumber() : null,
      });
      result.set(entry.id, {
        costRate: resolved.costRate,
        costAmount: entryCost(entry.hours.toString(), resolved.costRate),
        source: resolved.source,
        priced: true,
      });
    } catch (error) {
      if (error instanceof TimesheetError && error.code === 'EMPLOYEE_RATE_REQUIRED') {
        result.set(entry.id, { costRate: 0, costAmount: 0, source: 'unpriced', priced: false });
        continue;
      }
      throw error;
    }
  }
  return result;
}

function serialiseEntry(
  entry: EntryRow,
  preview: TimesheetEntryView['preview'],
): TimesheetEntryView {
  return {
    id: entry.id,
    jobId: entry.jobId,
    job: entry.job
      ? {
          id: entry.job.id,
          workOrder: entry.job.workOrder,
          area: entry.job.area,
          description: entry.job.description,
        }
      : null,
    jobServiceCodeId: entry.jobServiceCodeId,
    workDate: toIso(entry.workDate),
    labourType: entry.labourType,
    shiftType: shiftTypeFromKey(entry.shiftType),
    hours: entry.hours.toNumber(),
    isBillable: entry.isBillable,
    notes: entry.notes,
    costRateOverride: entry.costRateOverride ? entry.costRateOverride.toNumber() : null,
    overrideReason: entry.overrideReason,
    costRate: entry.costRate ? entry.costRate.toNumber() : null,
    costAmount: entry.costAmount ? entry.costAmount.toNumber() : null,
    preview,
  };
}

async function serialise(row: TimesheetRow, principal: Principal): Promise<TimesheetView> {
  const draft = row.status === 'DRAFT' || row.status === 'REJECTED';
  const approved = row.status === 'APPROVED';
  const writer = can(principal, 'timesheet.write') || principal.employeeId === row.employeeId;
  const approver = canApprove(principal);
  // A draft is its author's to write; an approved week is amendable in place by
  // an approver, which is the correction path the business asked for. A submitted
  // week is frozen pending a decision.
  const canEdit = draft ? writer : approved ? approver : false;
  const previews = await previewFor(row.entries, row.employeeId);

  const entries = row.entries.map((entry) =>
    serialiseEntry(
      entry,
      previews.get(entry.id) ?? { costRate: 0, costAmount: 0, source: 'unpriced', priced: false },
    ),
  );

  const hours = entries.reduce((sum, entry) => sum + entry.hours, 0);
  const cost = entries.reduce(
    (sum, entry) => sum + (entry.costAmount ?? entry.preview.costAmount),
    0,
  );
  const unpricedLines = entries.filter((entry) => !entry.preview.priced).length;

  return {
    id: row.id,
    employeeId: row.employeeId,
    employee: { id: row.employee.id, name: row.employee.name, surname: row.employee.surname },
    periodStart: toIso(row.periodStart),
    periodEnd: toIso(row.periodEnd),
    status: timesheetStatusFromKey(row.status),
    notes: row.notes,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    submittedBy: row.submittedBy,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedBy: row.decidedBy,
    decisionNote: row.decisionNote,
    canEdit,
    canAmend: approved && approver,
    canApprove: row.status === 'SUBMITTED' && approver,
    totals: {
      hours: Math.round(hours * 100) / 100,
      cost: Math.round(cost * 100) / 100,
      unpricedLines,
    },
    entries,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function loadRow(id: number): Promise<TimesheetRow> {
  const row = await prisma.timesheet.findUnique({ where: { id }, select: TIMESHEET_SELECT });
  if (!row) throw new TimesheetError(404, 'TIMESHEET_NOT_FOUND', `Timesheet ${id} does not exist.`);
  return row;
}

export async function getTimesheet(id: number, principal: Principal): Promise<TimesheetView> {
  const row = await loadRow(id);
  assertRead(row.employeeId, principal);
  return serialise(row, principal);
}

export interface ListFilters {
  employeeId?: number;
  status?: TimesheetStatus;
  from?: string;
  to?: string;
  jobId?: number;
  limit?: number;
}

export interface TimesheetSummaryView {
  id: number;
  employeeId: number;
  employee: { id: number; name: string; surname: string };
  periodStart: string;
  periodEnd: string;
  status: TimesheetStatus;
  totalHours: number;
  approvedCost: number;
  entryCount: number;
  canApprove: boolean;
}

export async function listTimesheets(
  principal: Principal,
  filters: ListFilters = {},
): Promise<TimesheetSummaryView[]> {
  const where: Prisma.TimesheetWhereInput = {};
  const canSeeAll = can(principal, 'timesheet.read');

  if (filters.employeeId !== undefined) {
    if (!canSeeAll && filters.employeeId !== principal.employeeId) {
      throw new TimesheetError(
        403,
        'TIMESHEET_FORBIDDEN',
        'You may only view your own timesheets.',
      );
    }
    where.employeeId = filters.employeeId;
  } else if (!canSeeAll) {
    where.employeeId = principal.employeeId;
  }

  if (filters.status) where.status = shiftStatusKey(filters.status);
  if (filters.jobId !== undefined) where.entries = { some: { jobId: filters.jobId } };
  if (filters.from || filters.to) {
    where.periodStart = {};
    if (filters.from) where.periodStart.gte = mondayOf(filters.from);
    if (filters.to) where.periodStart.lte = mondayOf(filters.to);
  }

  const rows = await prisma.timesheet.findMany({
    where,
    orderBy: [{ periodStart: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(filters.limit ?? 26, 1), 200),
    select: {
      id: true,
      employeeId: true,
      periodStart: true,
      periodEnd: true,
      status: true,
      employee: { select: { id: true, name: true, surname: true, managerId: true } },
      entries: { select: { hours: true, costAmount: true } },
    },
  });

  return rows.map((row) => {
    const hours = row.entries.reduce((sum, entry) => sum + entry.hours.toNumber(), 0);
    const cost = row.entries.reduce(
      (sum, entry) => sum + (entry.costAmount ? entry.costAmount.toNumber() : 0),
      0,
    );
    return {
      id: row.id,
      employeeId: row.employeeId,
      employee: { id: row.employee.id, name: row.employee.name, surname: row.employee.surname },
      periodStart: toIso(row.periodStart),
      periodEnd: toIso(row.periodEnd),
      status: timesheetStatusFromKey(row.status),
      totalHours: Math.round(hours * 100) / 100,
      approvedCost: Math.round(cost * 100) / 100,
      entryCount: row.entries.length,
      canApprove: row.status === 'SUBMITTED' && canApprove(principal),
    };
  });
}

/** The weeks awaiting a decision. Any approver sees every submitted week. */
export async function listApprovals(principal: Principal): Promise<TimesheetSummaryView[]> {
  assertCanApprove(principal);

  const rows = await prisma.timesheet.findMany({
    where: { status: 'SUBMITTED' },
    orderBy: [{ periodStart: 'asc' }, { id: 'asc' }],
    take: 200,
    select: {
      id: true,
      employeeId: true,
      periodStart: true,
      periodEnd: true,
      status: true,
      employee: { select: { id: true, name: true, surname: true, managerId: true } },
      entries: { select: { hours: true, costAmount: true } },
    },
  });

  return rows.map((row) => {
    const hours = row.entries.reduce((sum, entry) => sum + entry.hours.toNumber(), 0);
    const cost = row.entries.reduce(
      (sum, entry) => sum + (entry.costAmount ? entry.costAmount.toNumber() : 0),
      0,
    );
    return {
      id: row.id,
      employeeId: row.employeeId,
      employee: { id: row.employee.id, name: row.employee.name, surname: row.employee.surname },
      periodStart: toIso(row.periodStart),
      periodEnd: toIso(row.periodEnd),
      status: timesheetStatusFromKey(row.status),
      totalHours: Math.round(hours * 100) / 100,
      approvedCost: Math.round(cost * 100) / 100,
      entryCount: row.entries.length,
      canApprove: true,
    };
  });
}

export interface LoggableJob {
  id: number;
  workOrder: string | null;
  area: string | null;
  description: string | null;
  status: string;
  projectCode: string;
  clientName: string;
}

/** Jobs the principal may log hours to, for the grid's job picker. */
export async function listLoggableJobs(
  principal: Principal,
  search?: string,
  limit = 50,
): Promise<LoggableJob[]> {
  const where: Prisma.JobWhereInput = {};
  if (!can(principal, 'job.read')) {
    where.OR = [
      { assignments: { some: { employeeId: principal.employeeId } } },
      { supervisorId: principal.employeeId },
    ];
  }
  const term = search?.trim();
  if (term) {
    const match: Prisma.JobWhereInput = {
      OR: [
        { workOrder: { contains: term, mode: 'insensitive' } },
        { area: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        { project: { code: { contains: term, mode: 'insensitive' } } },
      ],
    };
    where.AND = [match];
  }

  const jobs = await prisma.job.findMany({
    where,
    orderBy: { id: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
    select: {
      id: true,
      workOrder: true,
      area: true,
      description: true,
      status: true,
      project: {
        select: { code: true, contract: { select: { client: { select: { name: true } } } } },
      },
    },
  });

  return jobs.map((job) => ({
    id: job.id,
    workOrder: job.workOrder,
    area: job.area,
    description: job.description,
    status: job.status,
    projectCode: job.project.code,
    clientName: job.project.contract.client.name,
  }));
}

export interface JobTimeEntryView {
  id: number;
  workDate: string;
  labourType: string;
  shiftType: ShiftType;
  hours: number;
  isBillable: boolean;
  notes: string | null;
  employee: { id: number; name: string; surname: string };
  timesheetId: number;
  timesheetStatus: TimesheetStatus;
  periodStart: string;
  periodEnd: string;
  /** Frozen at approval, else the live preview; null when nothing can price it. */
  costRate: number | null;
  costAmount: number | null;
  priced: boolean;
}

export interface JobTimeEntriesView {
  entries: JobTimeEntryView[];
  totals: { hours: number; billableHours: number; cost: number; unpricedLines: number };
}

/**
 * Every line of time booked to one job, for the job screen's Timesheets tab.
 *
 * This is the granular counterpart to the costing read-model: costing aggregates a
 * job's hours by labour type, this lists the lines themselves — who, which day,
 * how long — so a PM can see the detail behind the totals without leaving the job.
 *
 * An approved line reports its frozen cost; an unsent or pending one reports the
 * live preview, flagged `priced: false` when the employee has no rate to price it
 * at (the same tolerance {@link previewFor} applies, so one rate-less line never
 * blanks the whole tab). Gated on `timesheet.read`, because every column is cost.
 */
export async function listJobTimeEntries(
  jobId: number,
  principal: Principal,
): Promise<JobTimeEntriesView> {
  if (!can(principal, 'timesheet.read')) {
    throw new TimesheetError(403, 'FORBIDDEN', 'You may not view a job’s labour.');
  }

  const rows = await prisma.timesheetEntry.findMany({
    where: { jobId },
    orderBy: [{ workDate: 'desc' }, { id: 'desc' }],
    take: 500,
    select: JOB_ENTRY_SELECT,
  });

  const entries: JobTimeEntryView[] = rows.map((row) => {
    const employeeRate = row.timesheet.employee.rate
      ? row.timesheet.employee.rate.toNumber()
      : null;

    // A frozen line keeps the rate it was approved at; everything else previews at
    // today's employee rate, so the number here matches what approval would write.
    let costRate = row.costRate ? row.costRate.toNumber() : null;
    let costAmount = row.costAmount ? row.costAmount.toNumber() : null;
    let priced = costAmount !== null;

    if (!priced) {
      try {
        const resolved = resolveLineRate({
          employeeId: row.timesheet.employeeId,
          employeeRate,
          overrideRate: row.costRateOverride ? row.costRateOverride.toNumber() : null,
        });
        costRate = resolved.costRate;
        costAmount = entryCost(row.hours.toString(), resolved.costRate);
        priced = true;
      } catch (error) {
        if (!(error instanceof TimesheetError && error.code === 'EMPLOYEE_RATE_REQUIRED')) {
          throw error;
        }
      }
    }

    return {
      id: row.id,
      workDate: toIso(row.workDate),
      labourType: row.labourType,
      shiftType: shiftTypeFromKey(row.shiftType),
      hours: row.hours.toNumber(),
      isBillable: row.isBillable,
      notes: row.notes,
      employee: {
        id: row.timesheet.employee.id,
        name: row.timesheet.employee.name,
        surname: row.timesheet.employee.surname,
      },
      timesheetId: row.timesheet.id,
      timesheetStatus: timesheetStatusFromKey(row.timesheet.status),
      periodStart: toIso(row.timesheet.periodStart),
      periodEnd: toIso(row.timesheet.periodEnd),
      costRate,
      costAmount,
      priced,
    };
  });

  const totals = entries.reduce(
    (acc, entry) => {
      acc.hours += entry.hours;
      if (entry.isBillable) acc.billableHours += entry.hours;
      if (entry.priced && entry.costAmount !== null) acc.cost += entry.costAmount;
      if (!entry.priced) acc.unpricedLines += 1;
      return acc;
    },
    { hours: 0, billableHours: 0, cost: 0, unpricedLines: 0 },
  );

  return {
    entries,
    totals: {
      hours: Math.round(totals.hours * 100) / 100,
      billableHours: Math.round(totals.billableHours * 100) / 100,
      cost: Math.round(totals.cost * 100) / 100,
      unpricedLines: totals.unpricedLines,
    },
  };
}

export interface TimesheetEmployee {
  id: number;
  name: string;
  surname: string;
  /** ZAR per hour; null when unset (a legacy row the employee form now prevents). */
  rate: number | null;
  hasRate: boolean;
  isSelf: boolean;
}

/**
 * Employees whose time the principal may record.
 *
 * Kept inside the timesheet module rather than reusing `GET /api/employees`: a
 * site supervisor may log time without holding `employee.read`, and nobody needs
 * the full employee record to fill a grid — just a name and the rate the hours
 * will cost at.
 */
export async function listTimesheetEmployees(
  principal: Principal,
  search?: string,
  limit = 100,
): Promise<TimesheetEmployee[]> {
  const where: Prisma.EmployeeWhereInput = { endDate: null };
  if (!can(principal, 'timesheet.write')) {
    // A `timesheet.write.own` holder may only ever pick themselves.
    where.id = principal.employeeId;
  }
  const term = search?.trim();
  if (term) {
    where.OR = [
      { name: { contains: term, mode: 'insensitive' } },
      { surname: { contains: term, mode: 'insensitive' } },
    ];
  }

  const employees = await prisma.employee.findMany({
    where,
    orderBy: [{ surname: 'asc' }, { name: 'asc' }],
    take: Math.min(Math.max(limit, 1), 200),
    select: { id: true, name: true, surname: true, rate: true },
  });

  return employees.map((employee) => ({
    id: employee.id,
    name: employee.name,
    surname: employee.surname,
    rate: employee.rate ? employee.rate.toNumber() : null,
    hasRate: employee.rate !== null && employee.rate.toNumber() > 0,
    isSelf: employee.id === principal.employeeId,
  }));
}

// ---------------------------------------------------------------------------
// Week lifecycle
// ---------------------------------------------------------------------------

/**
 * Returns the week's header, creating it if the caller may write it.
 *
 * Deliberately not a GET: opening a week you have not started yet should hand
 * you an empty grid to type into, and the alternative — the client inventing an
 * id — is worse.
 */
export async function openWeek(
  employeeId: number,
  periodStart: string,
  principal: Principal,
): Promise<TimesheetView> {
  assertWrite(employeeId, principal);
  const monday = mondayOf(periodStart);

  const existing = await prisma.timesheet.findUnique({
    where: { employeeId_periodStart: { employeeId, periodStart: monday } },
    select: { id: true },
  });

  if (!existing) {
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, rate: true },
    });
    if (!employee) {
      throw new TimesheetError(404, 'EMPLOYEE_NOT_FOUND', `Employee ${employeeId} does not exist.`);
    }
    if (employee.rate === null || employee.rate.toNumber() <= 0) {
      throw new TimesheetError(
        422,
        'EMPLOYEE_RATE_REQUIRED',
        'This employee has no hourly cost rate. Set one on the employee record before recording time.',
      );
    }
    await prisma.timesheet.create({
      data: { employeeId, periodStart: monday, periodEnd: addDays(monday, 6), status: 'DRAFT' },
    });
  }

  const row = await prisma.timesheet.findUniqueOrThrow({
    where: { employeeId_periodStart: { employeeId, periodStart: monday } },
    select: TIMESHEET_SELECT,
  });
  return serialise(row, principal);
}

/**
 * Loads a row the caller intends to change, and decides they may.
 *
 * A draft or rejected week is the author's (or a `timesheet.write` holder's) to
 * edit. An **approved** week is writable only by an approver: that is the
 * amend-in-place path, and it is deliberately not the same permission as writing
 * your own hours.
 */
async function loadForWrite(id: number, principal: Principal): Promise<TimesheetRow> {
  const row = await loadRow(id);
  if (row.status === 'APPROVED') {
    if (canApprove(principal)) return row;
    throw new TimesheetError(
      403,
      'TIMESHEET_FORBIDDEN',
      'Only an approver may amend an approved timesheet.',
    );
  }
  assertWrite(row.employeeId, principal);
  return row;
}

/**
 * Whether the row is currently writable.
 *
 * A submitted week is frozen pending a decision; a draft is open; an approved
 * week is open to an approver amending it.
 */
function assertEditable(row: TimesheetRow, principal: Principal): void {
  if (row.status === 'DRAFT' || row.status === 'REJECTED') return;
  if (row.status === 'APPROVED' && canApprove(principal)) return;
  throw new TimesheetError(
    409,
    'TIMESHEET_LOCKED',
    `This timesheet is ${timesheetStatusFromKey(row.status).toLowerCase()} and cannot be edited. Reopen it first.`,
  );
}

/**
 * Prices one line at the employee's rate and writes the frozen columns.
 *
 * Used only when a week is already approved and an approver is amending it in
 * place: the corrected line is re-frozen immediately so the costing it feeds
 * stays consistent. A draft line is left unfrozen until approval.
 */
async function freezeLine(entryId: number, employeeId: number): Promise<void> {
  const entry = await prisma.timesheetEntry.findUniqueOrThrow({
    where: { id: entryId },
    select: { hours: true, costRateOverride: true },
  });
  const employeeRate = await loadEmployeeRate(employeeId);
  const resolved = resolveLineRate({
    employeeId,
    employeeRate,
    overrideRate: entry.costRateOverride ? entry.costRateOverride.toNumber() : null,
  });
  await prisma.timesheetEntry.update({
    where: { id: entryId },
    data: {
      costRate: resolved.costRate,
      costAmount: entryCost(entry.hours.toString(), resolved.costRate),
      rateSnapshot: resolved.snapshot as never,
    },
  });
}

function shiftStatusKey(status: TimesheetStatus) {
  // Local, exhaustive map: the wire speaks labels, Prisma speaks keys.
  switch (status) {
    case 'Draft':
      return 'DRAFT' as const;
    case 'Submitted':
      return 'SUBMITTED' as const;
    case 'Approved':
      return 'APPROVED' as const;
    case 'Rejected':
      return 'REJECTED' as const;
  }
}

export async function updateNotes(
  id: number,
  notes: string | null,
  principal: Principal,
): Promise<TimesheetView> {
  const row = await loadForWrite(id, principal);
  assertEditable(row, principal);
  await prisma.timesheet.update({ where: { id }, data: { notes } });
  return getTimesheet(id, principal);
}

// ---------------------------------------------------------------------------
// Entry lifecycle
// ---------------------------------------------------------------------------

export interface EntryInput {
  jobId: number;
  jobServiceCodeId?: number | null;
  workDate: string;
  labourType: string;
  shiftType: ShiftType;
  hours: number;
  isBillable?: boolean;
  notes?: string | null;
  costRateOverride?: number | null;
  overrideReason?: string | null;
}

async function assertDeliverableBelongsToJob(
  jobServiceCodeId: number | null | undefined,
  jobId: number,
): Promise<void> {
  if (jobServiceCodeId === null || jobServiceCodeId === undefined) return;
  const scope = await prisma.jobServiceCode.findUnique({
    where: { id: jobServiceCodeId },
    select: { jobId: true },
  });
  if (!scope || scope.jobId !== jobId) {
    throw new TimesheetError(
      422,
      'DELIVERABLE_NOT_ON_JOB',
      'That deliverable does not belong to the selected job.',
    );
  }
}

function assertWithinWeek(row: TimesheetRow, workDate: string): void {
  const date = parseIsoDate(workDate);
  if (date < row.periodStart || date > row.periodEnd) {
    throw new TimesheetError(
      422,
      'DATE_OUTSIDE_WEEK',
      `Hours must fall within ${toIso(row.periodStart)} to ${toIso(row.periodEnd)}.`,
    );
  }
}

function assertOverrideAllowed(input: EntryInput, principal: Principal): void {
  if (input.costRateOverride === null || input.costRateOverride === undefined) return;
  if (!can(principal, 'timesheet.override')) {
    throw new TimesheetError(
      403,
      'OVERRIDE_FORBIDDEN',
      'Overriding a cost rate requires the timesheet.override permission.',
    );
  }
  if (!input.overrideReason || input.overrideReason.trim().length === 0) {
    throw new TimesheetError(422, 'OVERRIDE_REASON_REQUIRED', 'An override needs a reason.');
  }
}

export async function addEntry(
  timesheetId: number,
  input: EntryInput,
  principal: Principal,
): Promise<TimesheetView> {
  const row = await loadForWrite(timesheetId, principal);
  assertEditable(row, principal);
  assertWithinWeek(row, input.workDate);
  await assertCanLogToJob(input.jobId, principal);
  await assertDeliverableBelongsToJob(input.jobServiceCodeId, input.jobId);
  assertOverrideAllowed(input, principal);

  const created = await prisma.timesheetEntry.create({
    data: {
      timesheetId,
      jobId: input.jobId,
      jobServiceCodeId: input.jobServiceCodeId ?? null,
      workDate: parseIsoDate(input.workDate),
      labourType: input.labourType,
      shiftType: shiftTypeToKey(input.shiftType),
      hours: input.hours,
      isBillable: input.isBillable ?? true,
      notes: input.notes ?? null,
      costRateOverride: input.costRateOverride ?? null,
      overrideReason: input.overrideReason ?? null,
    },
    select: { id: true },
  });

  // A line added to an already-approved week is part of an amendment, so it is
  // priced and frozen straight away rather than waiting for a re-approval.
  if (row.status === 'APPROVED') await freezeLine(created.id, row.employeeId);

  return getTimesheet(timesheetId, principal);
}

export async function updateEntry(
  entryId: number,
  input: Partial<EntryInput>,
  principal: Principal,
): Promise<TimesheetView> {
  const entry = await prisma.timesheetEntry.findUnique({
    where: { id: entryId },
    select: { id: true, timesheetId: true, jobId: true },
  });
  if (!entry) throw new TimesheetError(404, 'ENTRY_NOT_FOUND', `Entry ${entryId} does not exist.`);

  const row = await loadForWrite(entry.timesheetId, principal);
  assertEditable(row, principal);

  // The job a line points at may be changing; authorise and validate against
  // whichever job it will end up on.
  const effectiveJobId = input.jobId ?? entry.jobId;
  if (input.jobId !== undefined) await assertCanLogToJob(effectiveJobId, principal);
  if (input.jobServiceCodeId !== undefined || input.jobId !== undefined) {
    await assertDeliverableBelongsToJob(input.jobServiceCodeId, effectiveJobId);
  }
  if (input.workDate) assertWithinWeek(row, input.workDate);
  assertOverrideAllowed(input as EntryInput, principal);

  await prisma.timesheetEntry.update({
    where: { id: entryId },
    data: {
      ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
      ...(input.jobServiceCodeId !== undefined ? { jobServiceCodeId: input.jobServiceCodeId } : {}),
      ...(input.workDate !== undefined ? { workDate: parseIsoDate(input.workDate) } : {}),
      ...(input.labourType !== undefined ? { labourType: input.labourType } : {}),
      ...(input.shiftType !== undefined ? { shiftType: shiftTypeToKey(input.shiftType) } : {}),
      ...(input.hours !== undefined ? { hours: input.hours } : {}),
      ...(input.isBillable !== undefined ? { isBillable: input.isBillable } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.costRateOverride !== undefined ? { costRateOverride: input.costRateOverride } : {}),
      ...(input.overrideReason !== undefined ? { overrideReason: input.overrideReason } : {}),
    },
  });

  // An amendment to an approved week re-freezes the corrected line in place.
  if (row.status === 'APPROVED') await freezeLine(entryId, row.employeeId);

  return getTimesheet(entry.timesheetId, principal);
}

export async function deleteEntry(entryId: number, principal: Principal): Promise<TimesheetView> {
  const entry = await prisma.timesheetEntry.findUnique({
    where: { id: entryId },
    select: { id: true, timesheetId: true },
  });
  if (!entry) throw new TimesheetError(404, 'ENTRY_NOT_FOUND', `Entry ${entryId} does not exist.`);

  const row = await loadForWrite(entry.timesheetId, principal);
  assertEditable(row, principal);

  await prisma.timesheetEntry.delete({ where: { id: entryId } });
  return getTimesheet(entry.timesheetId, principal);
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export async function submit(
  id: number,
  note: string | undefined,
  principal: Principal,
): Promise<TimesheetView> {
  const row = await loadForWrite(id, principal);
  if (row.status !== 'DRAFT' && row.status !== 'REJECTED') {
    throw new TimesheetError(
      409,
      'TIMESHEET_LOCKED',
      'Only a draft or rejected week can be submitted.',
    );
  }
  if (row.entries.length === 0) {
    throw new TimesheetError(422, 'EMPTY_TIMESHEET', 'Add at least one line before submitting.');
  }

  await prisma.timesheet.update({
    where: { id },
    data: {
      status: 'SUBMITTED',
      submittedAt: new Date(),
      submittedById: principal.userId,
      decidedAt: null,
      decidedById: null,
      decisionNote: note ?? null,
    },
  });

  return getTimesheet(id, principal);
}

export async function approve(
  id: number,
  note: string | undefined,
  principal: Principal,
): Promise<TimesheetView> {
  const row = await loadRow(id);
  if (row.status !== 'SUBMITTED') {
    throw new TimesheetError(
      409,
      'TIMESHEET_NOT_SUBMITTED',
      'Only a submitted week can be approved.',
    );
  }
  assertCanApprove(principal);

  const employeeRate = await loadEmployeeRate(row.employeeId);

  // Resolve every line first. If any line has no rate the approval aborts before
  // a single write, so a week is never half-priced — and pricing nothing also
  // means the status does not change.
  const priced = row.entries.map((entry) => ({
    entry,
    resolved: resolveLineRate({
      employeeId: row.employeeId,
      employeeRate,
      overrideRate: entry.costRateOverride ? entry.costRateOverride.toNumber() : null,
    }),
  }));

  for (const { entry, resolved } of priced) {
    await prisma.timesheetEntry.update({
      where: { id: entry.id },
      data: {
        costRate: resolved.costRate,
        costAmount: entryCost(entry.hours.toString(), resolved.costRate),
        rateSnapshot: resolved.snapshot as never,
      },
    });
  }

  await prisma.timesheet.update({
    where: { id },
    data: {
      status: 'APPROVED',
      decidedAt: new Date(),
      decidedById: principal.userId,
      decisionNote: note ?? null,
    },
  });

  return getTimesheet(id, principal);
}

export async function reject(
  id: number,
  note: string,
  principal: Principal,
): Promise<TimesheetView> {
  const row = await loadRow(id);
  if (row.status !== 'SUBMITTED') {
    throw new TimesheetError(
      409,
      'TIMESHEET_NOT_SUBMITTED',
      'Only a submitted week can be rejected.',
    );
  }
  assertCanApprove(principal);

  await prisma.timesheet.update({
    where: { id },
    data: {
      status: 'REJECTED',
      decidedAt: new Date(),
      decidedById: principal.userId,
      decisionNote: note,
    },
  });

  return getTimesheet(id, principal);
}

/**
 * Sends an approved week back to draft.
 *
 * One of two correction paths. Reopening lifts the freeze (the cost columns are
 * cleared) and the week must be re-submitted and re-approved, so the same person
 * cannot quietly change what a decision rested on. The alternative — an approver
 * amending an approved week in place — keeps the approved status and goes through
 * {@link freezeLine}; the audit log records the before/after either way.
 */
export async function reopen(
  id: number,
  note: string,
  principal: Principal,
): Promise<TimesheetView> {
  const row = await loadRow(id);
  if (row.status !== 'APPROVED') {
    throw new TimesheetError(
      409,
      'TIMESHEET_NOT_APPROVED',
      'Only an approved week can be reopened.',
    );
  }
  assertCanApprove(principal);

  await prisma.$transaction([
    prisma.timesheetEntry.updateMany({
      where: { timesheetId: id },
      data: { costRate: null, costAmount: null, rateSnapshot: Prisma.DbNull },
    }),
    prisma.timesheet.update({
      where: { id },
      data: {
        status: 'DRAFT',
        decidedAt: new Date(),
        decidedById: principal.userId,
        decisionNote: note,
      },
    }),
  ]);

  return getTimesheet(id, principal);
}

// Re-exported for the rates endpoint so it can share the key encoding.
export { rateKey } from './rates.js';
