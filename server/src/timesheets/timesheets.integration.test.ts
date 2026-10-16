/**
 * Phase 16 acceptance gates, exercised against the live database.
 *
 *   1. A week is one row per (employee, Monday), whatever day you name.
 *   2. Hours attach to jobs, and a supervisor may only log to jobs they are on.
 *   3. A line costs the employee's own hourly rate (or a typed override), and
 *      never silently costs an hour at zero.
 *   4. Approval freezes the whole week's cost; a submitted week cannot be edited.
 *   5. Any holder of `timesheet.approve` may approve any week, including their
 *      own; nobody else may.
 *   6. Reopening unfreezes and re-approving re-freezes; an approver may also
 *      amend an approved week in place, re-freezing the corrected line.
 *   7. The costing register reports labour cost against job revenue.
 *
 * Fixtures are created and torn down within the suite; baseline commercial data
 * is read but never modified.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { prisma } from '../db/client.js';
import {
  TEST_PASSWORD,
  createTestUser,
  destroyTestUser,
  login,
  seededContractWithAmendment,
} from '../test/fixtures.js';

let app: FastifyInstance;

interface TestUser {
  id: number;
  employeeId: number;
  email: string;
  password: string;
}

const createdUsers: TestUser[] = [];
const sessions = new Map<string, { user: TestUser; cookie: string }>();

const fixtureProjects: string[] = [];
const fixtureAmendments: number[] = [];
const fixtureRateCards: number[] = [];
const fixtureJobs: number[] = [];
const fixtureAssignments: number[] = [];

beforeAll(async () => {
  app = await buildApp({ config: loadConfig(), logger: false });
  await app.ready();
});

afterAll(async () => {
  // Timesheets first: `timesheet.employee_id` restricts employee deletion and
  // `timesheet_entry.job_id` restricts job deletion, so they have to go before
  // either. Entries cascade with their header.
  const employeeIds = createdUsers.map((user) => user.employeeId);
  if (employeeIds.length) {
    await prisma.timesheet
      .deleteMany({ where: { employeeId: { in: employeeIds } } })
      .catch(() => undefined);
  }
  for (const id of fixtureAssignments) {
    await prisma.jobAssignment.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const id of fixtureJobs) {
    await prisma.job.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const code of fixtureProjects) {
    await prisma.project.deleteMany({ where: { code } }).catch(() => undefined);
  }
  if (fixtureRateCards.length) {
    await prisma.serviceMasterRate
      .deleteMany({ where: { id: { in: fixtureRateCards } } })
      .catch(() => undefined);
  }
  for (const id of fixtureAmendments) {
    await prisma.contractAmendment.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const user of createdUsers) {
    await destroyTestUser(user).catch(() => undefined);
  }
  await app.close();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One logged-in throwaway user per label, reused across the file. */
async function session(label: string, role: string) {
  const cached = sessions.get(label);
  if (cached) return cached;

  const user = await createTestUser([role]);
  createdUsers.push(user);
  const cookie = await login(app, user.email, TEST_PASSWORD);
  const entry = { user, cookie };
  sessions.set(label, entry);
  return entry;
}

/** A project whose amendment is private to this suite, so rate rows never clash. */
async function makeProjectWithAmendment(): Promise<{ projectId: number; amendmentId: number }> {
  const { contractId } = await seededContractWithAmendment();
  const amendment = await prisma.contractAmendment.create({
    data: {
      contractId,
      amendmentNumber: `TEST-TS-${randomUUID().slice(0, 8)}`,
      effectiveDate: new Date('2027-01-01'),
      vatRate: 0.15,
    },
    select: { id: true },
  });
  fixtureAmendments.push(amendment.id);

  const code = `TEST-TS-PRJ-${randomUUID().slice(0, 8)}`;
  const project = await prisma.project.create({
    data: {
      contractId,
      amendmentId: amendment.id,
      code,
      year: 2026,
      description: 'Phase 16 test fixture project',
    },
    select: { id: true },
  });
  fixtureProjects.push(code);
  return { projectId: project.id, amendmentId: amendment.id };
}

async function makeJob(projectId: number): Promise<number> {
  const job = await prisma.job.create({
    data: { projectId, amendmentId: null, description: 'Phase 16 test fixture job' },
    select: { id: true },
  });
  fixtureJobs.push(job.id);
  return job.id;
}

async function assign(employeeId: number, jobId: number): Promise<void> {
  const assignment = await prisma.jobAssignment.create({
    data: { jobId, employeeId },
    select: { id: true },
  });
  fixtureAssignments.push(assignment.id);
}

/**
 * A rate card row whose components sum to the published rate.
 *
 * `fullLoadedRate 85 − profitCost 6 = 79`, the default cost basis, so an hour of
 * this labour type costs R79.
 */
async function makeRateCard(
  amendmentId: number,
  labourType = 'Fitter',
  shiftType: 'NT' | 'OT' = 'NT',
): Promise<number> {
  const rate = await prisma.serviceMasterRate.create({
    data: {
      amendmentId,
      serviceMasterCode: `TS${randomUUID().slice(0, 6)}`,
      labourType,
      shiftType,
      manInPocket: 50,
      leavePay: 5,
      totalStatutoryCost: 8,
      ppeCost: 2,
      transportCost: 3,
      equipmentCost: 2,
      overheadCost: 5,
      sgaCost: 4,
      profitCost: 6,
      fullLoadedRate: 85,
    },
    select: { id: true },
  });
  fixtureRateCards.push(rate.id);
  return rate.id;
}

/** Opens a week and returns its id. */
async function openWeek(cookie: string, periodStart: string): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/timesheets',
    headers: { cookie },
    payload: { periodStart },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().timesheet.id;
}

async function addEntry(cookie: string, timesheetId: number, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/timesheets/${timesheetId}/entries`,
    headers: { cookie },
    payload,
  });
}

// ===========================================================================

describe('weeks', () => {
  it('normalises any day to its Monday, and is idempotent', async () => {
    const sup = await session('week-supervisor', 'site_supervisor');
    const first = await app.inject({
      method: 'POST',
      url: '/api/timesheets',
      headers: { cookie: sup.cookie },
      payload: { periodStart: '2026-03-04' }, // a Wednesday
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().timesheet.periodStart).toBe('2026-03-02');
    expect(first.json().timesheet.periodEnd).toBe('2026-03-08');
    expect(first.json().timesheet.status).toBe('Draft');

    const again = await app.inject({
      method: 'POST',
      url: '/api/timesheets',
      headers: { cookie: sup.cookie },
      payload: { periodStart: '2026-03-02' },
    });
    expect(again.json().timesheet.id).toBe(first.json().timesheet.id);
  });

  it('refuses hours outside the week', async () => {
    const sup = await session('week-supervisor', 'site_supervisor');
    const { projectId } = await makeProjectWithAmendment();
    const jobId = await makeJob(projectId);
    await assign(sup.user.employeeId, jobId);
    const timesheetId = await openWeek(sup.cookie, '2026-03-02');

    const response = await addEntry(sup.cookie, timesheetId, {
      jobId,
      workDate: '2026-03-09',
      labourType: 'Fitter',
      shiftType: 'NT',
      hours: 8,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('DATE_OUTSIDE_WEEK');
  });
});

describe('cost resolution', () => {
  it('costs a line at the employee’s own rate, ignoring the job’s rate card', async () => {
    const sup = await session('cost-supervisor', 'site_supervisor');
    await prisma.employee.update({ where: { id: sup.user.employeeId }, data: { rate: 79 } });
    const { projectId, amendmentId } = await makeProjectWithAmendment();
    // A rate card exists and would price 'Fitter' at 79, but the employee rate is
    // what counts — a person costs their own rate whatever trade code they carry.
    await makeRateCard(amendmentId);
    const jobId = await makeJob(projectId);
    await assign(sup.user.employeeId, jobId);
    const timesheetId = await openWeek(sup.cookie, '2026-03-02');

    const response = await addEntry(sup.cookie, timesheetId, {
      jobId,
      workDate: '2026-03-02',
      labourType: 'Fitter',
      shiftType: 'NT',
      hours: 8,
    });

    expect(response.statusCode).toBe(201);
    const entry = response.json().timesheet.entries[0];
    expect(entry.preview).toMatchObject({
      costRate: 79,
      costAmount: 632,
      source: 'employee_rate',
      priced: true,
    });
    // Draft lines carry a live preview, not a frozen figure.
    expect(entry.costRate).toBeNull();
    expect(entry.costAmount).toBeNull();
    expect(response.json().timesheet.totals).toMatchObject({ hours: 8, cost: 632 });
  });

  it('refuses to open a week for an employee who has no rate', async () => {
    const sup = await session('rateless-supervisor', 'site_supervisor');
    await prisma.employee.update({ where: { id: sup.user.employeeId }, data: { rate: null } });

    const response = await app.inject({
      method: 'POST',
      url: '/api/timesheets',
      headers: { cookie: sup.cookie },
      payload: { periodStart: '2026-03-02' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('EMPLOYEE_RATE_REQUIRED');
  });

  it('marks a line unpriced when the employee rate is cleared after the week opened', async () => {
    const sup = await session('unpriced-supervisor', 'site_supervisor');
    const { projectId } = await makeProjectWithAmendment();
    const jobId = await makeJob(projectId);
    await assign(sup.user.employeeId, jobId);
    const timesheetId = await openWeek(sup.cookie, '2026-03-02');

    // A legacy state: the week exists, the rate is gone. The line is saved, shown
    // as unpriced, and approval will refuse it.
    await prisma.employee.update({ where: { id: sup.user.employeeId }, data: { rate: null } });

    const response = await addEntry(sup.cookie, timesheetId, {
      jobId,
      workDate: '2026-03-02',
      labourType: 'Boilermaker',
      shiftType: 'NT',
      hours: 4,
    });

    const entry = response.json().timesheet.entries[0];
    expect(entry.preview).toMatchObject({ priced: false, source: 'unpriced' });
    expect(response.json().timesheet.totals.unpricedLines).toBe(1);
  });

  it('a supervisor may not log time to a job they are not on', async () => {
    const sup = await session('unassigned-supervisor', 'site_supervisor');
    const { projectId } = await makeProjectWithAmendment();
    const jobId = await makeJob(projectId);
    const timesheetId = await openWeek(sup.cookie, '2026-03-02');

    const response = await addEntry(sup.cookie, timesheetId, {
      jobId,
      workDate: '2026-03-02',
      labourType: 'Fitter',
      shiftType: 'NT',
      hours: 8,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('JOB_NOT_ASSIGNED');
  });

  it('uses an override when permitted, and refuses one without a reason or permission', async () => {
    const admin = await session('override-admin', 'administrator');
    const sup = await session('override-supervisor', 'site_supervisor');
    const { projectId } = await makeProjectWithAmendment();
    const jobId = await makeJob(projectId);
    await assign(sup.user.employeeId, jobId);
    const timesheetId = await openWeek(sup.cookie, '2026-03-02');

    const overridden = await addEntry(admin.cookie, timesheetId, {
      jobId,
      workDate: '2026-03-02',
      labourType: 'Fitter',
      shiftType: 'NT',
      hours: 1,
      costRateOverride: 100,
      overrideReason: 'Acting in a higher grade',
    });
    expect(overridden.statusCode).toBe(201);
    expect(overridden.json().timesheet.entries[0].preview).toMatchObject({
      costRate: 100,
      source: 'override',
    });

    const forbidden = await addEntry(sup.cookie, timesheetId, {
      jobId,
      workDate: '2026-03-03',
      labourType: 'Fitter',
      shiftType: 'NT',
      hours: 1,
      costRateOverride: 100,
      overrideReason: 'Nope',
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error).toBe('OVERRIDE_FORBIDDEN');

    const noReason = await addEntry(admin.cookie, timesheetId, {
      jobId,
      workDate: '2026-03-04',
      labourType: 'Fitter',
      shiftType: 'NT',
      hours: 1,
      costRateOverride: 100,
    });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error).toBe('VALIDATION_FAILED');
  });
});

describe('approval', () => {
  it('freezes cost on approval and locks the week to its own author', async () => {
    const sup = await session('approval-supervisor', 'site_supervisor');
    const admin = await session('approval-admin', 'administrator');
    await prisma.employee.update({ where: { id: sup.user.employeeId }, data: { rate: 79 } });
    const { projectId } = await makeProjectWithAmendment();
    const jobId = await makeJob(projectId);
    await assign(sup.user.employeeId, jobId);
    const timesheetId = await openWeek(sup.cookie, '2026-03-02');

    const added = await addEntry(sup.cookie, timesheetId, {
      jobId,
      workDate: '2026-03-02',
      labourType: 'Fitter',
      shiftType: 'NT',
      hours: 8,
    });
    expect(added.statusCode, added.body).toBe(201);

    const submitted = await app.inject({
      method: 'POST',
      url: `/api/timesheets/${timesheetId}/submit`,
      headers: { cookie: sup.cookie },
      payload: {},
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().timesheet.status).toBe('Submitted');

    const approved = await app.inject({
      method: 'POST',
      url: `/api/timesheets/${timesheetId}/approve`,
      headers: { cookie: admin.cookie },
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const timesheet = approved.json().timesheet;
    expect(timesheet.status).toBe('Approved');
    expect(timesheet.entries[0]).toMatchObject({ costRate: 79, costAmount: 632 });
  });

  it('lets an approver amend an approved week in place, re-freezing the line', async () => {
    const sup = await session('amend-supervisor', 'site_supervisor');
    const admin = await session('amend-admin', 'administrator');
    await prisma.employee.update({ where: { id: sup.user.employeeId }, data: { rate: 79 } });
    const { projectId } = await makeProjectWithAmendment();
    const jobId = await makeJob(projectId);
    await assign(sup.user.employeeId, jobId);
    const timesheetId = await openWeek(sup.cookie, '2026-03-02');

    const added = await addEntry(sup.cookie, timesheetId, {
      jobId,
      workDate: '2026-03-02',
      labourType: 'Fitter',
      shiftType: 'NT',
      hours: 8,
    });
    const entryId = added.json().timesheet.entries[0].id;
    await app.inject({
      method: 'POST',
      url: `/api/timesheets/${timesheetId}/submit`,
      headers: { cookie: sup.cookie },
      payload: {},
    });
    await app.inject({
      method: 'POST',
      url: `/api/timesheets/${timesheetId}/approve`,
      headers: { cookie: admin.cookie },
      payload: {},
    });

    // The author of the week is not an approver, so they cannot amend it.
    const refused = await app.inject({
      method: 'PATCH',
      url: `/api/timesheet-entries/${entryId}`,
      headers: { cookie: sup.cookie },
      payload: { hours: 4 },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('TIMESHEET_FORBIDDEN');

    // An approver corrects it in place: the week stays approved and the line is
    // re-priced straight away.
    const amended = await app.inject({
      method: 'PATCH',
      url: `/api/timesheet-entries/${entryId}`,
      headers: { cookie: admin.cookie },
      payload: { hours: 10 },
    });
    expect(amended.statusCode, amended.body).toBe(200);
    const after = amended.json().timesheet;
    expect(after.status).toBe('Approved');
    expect(after.entries[0]).toMatchObject({ costRate: 79, costAmount: 790 });
  });

  it('lets a project manager approve their own week', async () => {
    const pm = await session('self-approver', 'project_manager');
    await prisma.employee.update({ where: { id: pm.user.employeeId }, data: { rate: 79 } });
    const { projectId } = await makeProjectWithAmendment();
    const jobId = await makeJob(projectId);
    const timesheetId = await openWeek(pm.cookie, '2026-04-06');

    await addEntry(pm.cookie, timesheetId, {
      jobId,
      workDate: '2026-04-06',
      labourType: 'Fitter',
      shiftType: 'NT',
      hours: 4,
    });
    await app.inject({
      method: 'POST',
      url: `/api/timesheets/${timesheetId}/submit`,
      headers: { cookie: pm.cookie },
      payload: {},
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/timesheets/${timesheetId}/approve`,
      headers: { cookie: pm.cookie },
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().timesheet.status).toBe('Approved');
  });

  it('refuses an approval from someone without the permission', async () => {
    const sup = await session('no-approve-supervisor', 'site_supervisor');
    const { projectId } = await makeProjectWithAmendment();
    const jobId = await makeJob(projectId);
    await assign(sup.user.employeeId, jobId);
    const timesheetId = await openWeek(sup.cookie, '2026-04-13');

    await addEntry(sup.cookie, timesheetId, {
      jobId,
      workDate: '2026-04-13',
      labourType: 'Fitter',
      shiftType: 'NT',
      hours: 4,
    });
    await app.inject({
      method: 'POST',
      url: `/api/timesheets/${timesheetId}/submit`,
      headers: { cookie: sup.cookie },
      payload: {},
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/timesheets/${timesheetId}/approve`,
      headers: { cookie: sup.cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });

  it('unfreezes on reopen and re-freezes on re-approval', async () => {
    const sup = await session('reopen-supervisor', 'site_supervisor');
    const admin = await session('reopen-admin', 'administrator');
    await prisma.employee.update({ where: { id: sup.user.employeeId }, data: { rate: 79 } });
    const { projectId } = await makeProjectWithAmendment();
    const jobId = await makeJob(projectId);
    await assign(sup.user.employeeId, jobId);
    const timesheetId = await openWeek(sup.cookie, '2026-03-02');

    const added = await addEntry(sup.cookie, timesheetId, {
      jobId,
      workDate: '2026-03-02',
      labourType: 'Fitter',
      shiftType: 'NT',
      hours: 8,
    });
    const entryId = added.json().timesheet.entries[0].id;

    await app.inject({
      method: 'POST',
      url: `/api/timesheets/${timesheetId}/submit`,
      headers: { cookie: sup.cookie },
      payload: {},
    });
    await app.inject({
      method: 'POST',
      url: `/api/timesheets/${timesheetId}/approve`,
      headers: { cookie: admin.cookie },
      payload: {},
    });

    const reopened = await app.inject({
      method: 'POST',
      url: `/api/timesheets/${timesheetId}/reopen`,
      headers: { cookie: admin.cookie },
      payload: { note: 'Wrong job' },
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().timesheet.status).toBe('Draft');
    expect(reopened.json().timesheet.entries[0].costAmount).toBeNull();

    // Editable again by the author, and the correction sticks.
    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/timesheet-entries/${entryId}`,
      headers: { cookie: sup.cookie },
      payload: { hours: 10 },
    });
    expect(edited.statusCode).toBe(200);

    await app.inject({
      method: 'POST',
      url: `/api/timesheets/${timesheetId}/submit`,
      headers: { cookie: sup.cookie },
      payload: {},
    });
    const reapproved = await app.inject({
      method: 'POST',
      url: `/api/timesheets/${timesheetId}/approve`,
      headers: { cookie: admin.cookie },
      payload: {},
    });
    expect(reapproved.json().timesheet.entries[0].costAmount).toBe(790); // 10 x 79
  });
});

describe('costing register', () => {
  it('reports frozen labour cost against the job', async () => {
    const sup = await session('costing-supervisor', 'site_supervisor');
    const admin = await session('costing-admin', 'administrator');
    await prisma.employee.update({ where: { id: sup.user.employeeId }, data: { rate: 79 } });
    const { projectId } = await makeProjectWithAmendment();
    const jobId = await makeJob(projectId);
    await assign(sup.user.employeeId, jobId);
    const timesheetId = await openWeek(sup.cookie, '2026-05-04');

    await addEntry(sup.cookie, timesheetId, {
      jobId,
      workDate: '2026-05-04',
      labourType: 'Fitter',
      shiftType: 'NT',
      hours: 8,
    });
    await app.inject({
      method: 'POST',
      url: `/api/timesheets/${timesheetId}/submit`,
      headers: { cookie: sup.cookie },
      payload: {},
    });
    await app.inject({
      method: 'POST',
      url: `/api/timesheets/${timesheetId}/approve`,
      headers: { cookie: admin.cookie },
      payload: {},
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/costing/jobs/${jobId}`,
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const costing = response.json().job;
    expect(costing.hoursActual).toBe(8);
    expect(costing.labourCostActual).toBe(632);
    expect(costing.costActual).toBe(632);
  });
});
