/**
 * Timesheet + costing API (Phase 16).
 *
 * RBAC map:
 *   timesheet.write.own / .read.own   a supervisor's own hours
 *   timesheet.write / .read           a PM on behalf of the crew, and the costing views
 *   timesheet.approve                 the approval queue and decisions
 *   timesheet.override                a manual cost rate on a line
 *
 * A few endpoints accept more than one permission (a read is fine for either
 * `read.own` or `read`), and `requirePermission` demands *all* of its arguments,
 * so those check in the handler instead. Everything the handler would check
 * anyway — who may approve this particular week, who may edit this row — lives
 * in the service, because it depends on the row rather than the endpoint.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  costRateForBasis,
  timesheetApproveSchema,
  timesheetCreateSchema,
  timesheetEntryCreateSchema,
  timesheetEntryUpdateSchema,
  timesheetReopenSchema,
  timesheetRejectSchema,
  timesheetSubmitSchema,
  timesheetUpdateSchema,
  shiftTypeFromKey,
  type ShiftType,
} from '@openerp/shared';
import { z } from 'zod';
import type { Principal } from '../auth/principal.js';
import { TimesheetError } from '../timesheets/errors.js';
import { jobCosting, listJobCosting } from '../timesheets/costing.js';
import { loadJobRateCard } from '../timesheets/rates.js';
import {
  addEntry,
  approve,
  currentWeekStart,
  deleteEntry,
  getTimesheet,
  listApprovals,
  listLoggableJobs,
  listTimesheetEmployees,
  listTimesheets,
  openWeek,
  reject,
  reopen,
  submit,
  updateEntry,
  updateNotes,
} from '../timesheets/service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const jobIdParam = z.object({ jobId: z.coerce.number().int().positive() });

const listQuery = z.object({
  employeeId: z.coerce.number().int().positive().optional(),
  status: z.enum(['Draft', 'Submitted', 'Approved', 'Rejected']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  jobId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const costingQuery = z.object({
  search: z.string().trim().max(200).optional(),
  withHoursOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const jobsQuery = z.object({
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const ratesQuery = z.object({ jobId: z.coerce.number().int().positive() });

function principalOf(request: FastifyRequest): Principal {
  if (!request.principal) throw new TimesheetError(401, 'UNAUTHORIZED', 'Authentication required.');
  return request.principal;
}

/** `requirePermission` needs all permissions; this needs any one of them. */
function assertAny(principal: Principal, keys: readonly string[]): void {
  if (keys.some((key) => principal.permissions.has(key))) return;
  throw new TimesheetError(403, 'FORBIDDEN', 'Insufficient permissions.');
}

const WRITE_ANY_OR_OWN: readonly string[] = ['timesheet.write', 'timesheet.write.own'];
const READ_ANY_OR_OWN: readonly string[] = ['timesheet.read', 'timesheet.read.own'];
/**
 * Who may touch a *line*. An approver is included so an approved week can be
 * amended in place; the service then separately decides whether *this* row is
 * one they may write.
 */
const ENTRY_WRITE: readonly string[] = [
  'timesheet.write',
  'timesheet.write.own',
  'timesheet.approve',
];

export async function registerTimesheetRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Timesheets
  // -------------------------------------------------------------------------

  app.get('/api/timesheets', { preHandler: [app.authenticate] }, async (request) => {
    const principal = principalOf(request);
    assertAny(principal, READ_ANY_OR_OWN);
    const query = listQuery.parse(request.query);
    return { timesheets: await listTimesheets(principal, query) };
  });

  /** The caller's own recent weeks, plus the Monday of the current one. */
  app.get('/api/timesheets/me', { preHandler: [app.authenticate] }, async (request) => {
    const principal = principalOf(request);
    assertAny(principal, [...READ_ANY_OR_OWN, ...WRITE_ANY_OR_OWN]);
    return {
      employeeId: principal.employeeId,
      currentWeekStart: currentWeekStart().toISOString().slice(0, 10),
      weeks: await listTimesheets(principal, { employeeId: principal.employeeId, limit: 12 }),
    };
  });

  /** Weeks awaiting the caller's decision. */
  app.get(
    '/api/timesheets/approvals',
    { preHandler: [app.authenticate, app.requirePermission('timesheet.approve')] },
    async (request) => {
      const principal = principalOf(request);
      return { timesheets: await listApprovals(principal) };
    },
  );

  /** Employees whose time the caller may record. */
  app.get('/api/timesheets/employees', { preHandler: [app.authenticate] }, async (request) => {
    const principal = principalOf(request);
    assertAny(principal, WRITE_ANY_OR_OWN);
    const query = jobsQuery.parse(request.query);
    return { employees: await listTimesheetEmployees(principal, query.search, query.limit) };
  });

  /** Jobs the caller may log hours to. */
  app.get('/api/timesheets/jobs', { preHandler: [app.authenticate] }, async (request) => {
    const principal = principalOf(request);
    assertAny(principal, WRITE_ANY_OR_OWN);
    const query = jobsQuery.parse(request.query);
    return { jobs: await listLoggableJobs(principal, query.search, query.limit) };
  });

  /** Opens (or returns) a week, so the grid has something to write into. */
  app.post('/api/timesheets', { preHandler: [app.authenticate] }, async (request, reply) => {
    const principal = principalOf(request);
    assertAny(principal, WRITE_ANY_OR_OWN);
    const body = timesheetCreateSchema.parse(request.body);
    const employeeId = body.employeeId ?? principal.employeeId;
    const timesheet = await openWeek(employeeId, body.periodStart, principal);
    return reply.code(201).send({ timesheet });
  });

  app.get('/api/timesheets/:id', { preHandler: [app.authenticate] }, async (request) => {
    const principal = principalOf(request);
    const { id } = idParam.parse(request.params);
    return { timesheet: await getTimesheet(id, principal) };
  });

  app.patch('/api/timesheets/:id', { preHandler: [app.authenticate] }, async (request) => {
    const principal = principalOf(request);
    assertAny(principal, ENTRY_WRITE);
    const { id } = idParam.parse(request.params);
    const body = timesheetUpdateSchema.parse(request.body);
    return { timesheet: await updateNotes(id, body.notes ?? null, principal) };
  });

  // -------------------------------------------------------------------------
  // Entries
  // -------------------------------------------------------------------------

  app.post(
    '/api/timesheets/:id/entries',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const principal = principalOf(request);
      assertAny(principal, ENTRY_WRITE);
      const { id } = idParam.parse(request.params);
      const body = timesheetEntryCreateSchema.parse(request.body);
      const timesheet = await addEntry(
        id,
        { ...body, shiftType: body.shiftType as ShiftType },
        principal,
      );
      return reply.code(201).send({ timesheet });
    },
  );

  app.patch('/api/timesheet-entries/:id', { preHandler: [app.authenticate] }, async (request) => {
    const principal = principalOf(request);
    assertAny(principal, ENTRY_WRITE);
    const { id } = idParam.parse(request.params);
    const body = timesheetEntryUpdateSchema.parse(request.body);
    return { timesheet: await updateEntry(id, body, principal) };
  });

  app.delete('/api/timesheet-entries/:id', { preHandler: [app.authenticate] }, async (request) => {
    const principal = principalOf(request);
    assertAny(principal, ENTRY_WRITE);
    const { id } = idParam.parse(request.params);
    return { timesheet: await deleteEntry(id, principal) };
  });

  // -------------------------------------------------------------------------
  // Workflow
  // -------------------------------------------------------------------------

  app.post('/api/timesheets/:id/submit', { preHandler: [app.authenticate] }, async (request) => {
    const principal = principalOf(request);
    assertAny(principal, WRITE_ANY_OR_OWN);
    const { id } = idParam.parse(request.params);
    const body = timesheetSubmitSchema.parse(request.body ?? {});
    return { timesheet: await submit(id, body.note, principal) };
  });

  app.post(
    '/api/timesheets/:id/approve',
    { preHandler: [app.authenticate, app.requirePermission('timesheet.approve')] },
    async (request) => {
      const principal = principalOf(request);
      const { id } = idParam.parse(request.params);
      const body = timesheetApproveSchema.parse(request.body ?? {});
      return { timesheet: await approve(id, body.note, principal) };
    },
  );

  app.post(
    '/api/timesheets/:id/reject',
    { preHandler: [app.authenticate, app.requirePermission('timesheet.approve')] },
    async (request) => {
      const principal = principalOf(request);
      const { id } = idParam.parse(request.params);
      const body = timesheetRejectSchema.parse(request.body ?? {});
      return { timesheet: await reject(id, body.note, principal) };
    },
  );

  app.post(
    '/api/timesheets/:id/reopen',
    { preHandler: [app.authenticate, app.requirePermission('timesheet.approve')] },
    async (request) => {
      const principal = principalOf(request);
      const { id } = idParam.parse(request.params);
      const body = timesheetReopenSchema.parse(request.body ?? {});
      return { timesheet: await reopen(id, body.note, principal) };
    },
  );

  // -------------------------------------------------------------------------
  // Costing
  // -------------------------------------------------------------------------

  /**
   * The rate card a job prices against, for the line editor's labour-type and
   * shift pickers. Returned as labels, like every other enum the API speaks.
   */
  app.get('/api/costing/rates', { preHandler: [app.authenticate] }, async (request) => {
    const principal = principalOf(request);
    assertAny(principal, WRITE_ANY_OR_OWN);
    const { jobId } = ratesQuery.parse(request.query);
    const card = await loadJobRateCard(jobId);
    return {
      jobId: card.jobId,
      amendmentId: card.amendmentId,
      rates: card.rates.map((rate) => ({
        labourType: rate.labourType,
        shiftType: shiftTypeFromKey(rate.shiftType),
        costRate: costRateForBasis(rate.components),
      })),
    };
  });

  /** The profitability register. */
  app.get(
    '/api/costing/jobs',
    { preHandler: [app.authenticate, app.requirePermission('timesheet.read')] },
    async (request) => {
      const query = costingQuery.parse(request.query);
      return { jobs: await listJobCosting(query) };
    },
  );

  app.get(
    '/api/costing/jobs/:jobId',
    { preHandler: [app.authenticate, app.requirePermission('timesheet.read')] },
    async (request) => {
      const { jobId } = jobIdParam.parse(request.params);
      return { job: await jobCosting(jobId) };
    },
  );
}
