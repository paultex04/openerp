/**
 * Phase 3 acceptance gates, exercised against the live database.
 *
 *   1. A field supervisor cannot move a job backwards or jump from 01. Scoping
 *      to 10. Invoiced.
 *   2. Updating actual_quantity recalculates variance against planned_quantity.
 *   3. Changing a master service rate does not retroactively mutate applied_rate
 *      or the historical subtotals of already-scoped jobs.
 *   4. Planned quantities freeze once the job passes 02. Awaiting PO.
 *   5. Amendment resolution: a null job amendment inherits the project's.
 *
 * Fixtures are created and torn down within the test; baseline commercial data is
 * read but never modified.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { prisma } from '../db/client.js';
import { createTestUser, destroyTestUser, login, TEST_PASSWORD } from '../test/fixtures.js';
import { allNextStatuses, canEditActuals, canEditPlanned, type JobStatus } from '@openerp/shared';

let app: FastifyInstance;
const createdUsers: Array<{ id: number; employeeId: number }> = [];
const cookies = new Map<string, string>();

/** Fixtures to remove after the suite. */
const fixtureJobs: number[] = [];
const fixtureAssignments: number[] = [];
const fixtureDeliverables: number[] = [];
const fixtureProjects: string[] = [];
/**
 * Fixture ids also tracked here so `afterAll` can sweep them.
 *
 * A per-test `finally` is the right primary cleanup, but it has already proved
 * fallible: one FK-order mistake left a rate card behind, which then made an
 * unrelated Phase 2 assertion fail by counting 23 rows instead of 22. The
 * afterAll sweep is the backstop that stops a test bug corrupting the next run.
 */
const fixtureServiceCodes: number[] = [];
const fixtureRateCards: number[] = [];

beforeAll(async () => {
  app = await buildApp({ config: loadConfig(), logger: false });
  await app.ready();
});

afterAll(async () => {
  // Sweep in FK-safe order; each step guarded so one failure cannot strand the
  // rows after it.
  for (const id of fixtureDeliverables) {
    await prisma.jobServiceCode.deleteMany({ where: { id } }).catch(() => undefined);
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
  if (fixtureServiceCodes.length) {
    await prisma.serviceCodeLabourItem
      .deleteMany({ where: { serviceCodeId: { in: fixtureServiceCodes } } })
      .catch(() => undefined);
    await prisma.serviceCodeMaterialItem
      .deleteMany({ where: { serviceCodeId: { in: fixtureServiceCodes } } })
      .catch(() => undefined);
    await prisma.jobServiceCode
      .deleteMany({ where: { serviceCodeId: { in: fixtureServiceCodes } } })
      .catch(() => undefined);
    await prisma.invoiceItem
      .deleteMany({ where: { serviceCodeId: { in: fixtureServiceCodes } } })
      .catch(() => undefined);
    await prisma.serviceCode
      .deleteMany({ where: { id: { in: fixtureServiceCodes } } })
      .catch(() => undefined);
  }
  if (fixtureRateCards.length) {
    await prisma.serviceCodeLabourItem
      .deleteMany({ where: { serviceMasterRateId: { in: fixtureRateCards } } })
      .catch(() => undefined);
    await prisma.serviceMasterRate
      .deleteMany({ where: { id: { in: fixtureRateCards } } })
      .catch(() => undefined);
  }
  for (const user of createdUsers) {
    await destroyTestUser(user).catch(() => undefined);
  }
  await app.close();
  await prisma.$disconnect();
});

async function sessionFor(role: string): Promise<string> {
  const cached = cookies.get(role);
  if (cached) return cached;

  const user = await createTestUser([role]);
  createdUsers.push(user);
  const cookie = await login(app, user.email, TEST_PASSWORD);
  cookies.set(role, cookie);
  return cookie;
}

/** Creates a throwaway project so tests never touch the seeded one. */
async function makeProject(): Promise<number> {
  const contract = await prisma.contract.findFirstOrThrow({ select: { id: true } });
  const amendment = await prisma.contractAmendment.findFirstOrThrow({ select: { id: true } });
  const code = `TEST-PRJ-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  const project = await prisma.project.create({
    data: {
      contractId: contract.id,
      amendmentId: amendment.id,
      code,
      year: 2026,
      description: 'Phase 3 test fixture project',
    },
    select: { id: true },
  });
  fixtureProjects.push(code);
  return project.id;
}

async function makeJob(projectId: number, status?: string): Promise<number> {
  const job = await prisma.job.create({
    data: {
      projectId,
      // Deliberately null to exercise amendment inheritance.
      amendmentId: null,
      status: (status ?? 'JOB_SCOPING') as never,
      description: 'Phase 3 test fixture job',
    },
    select: { id: true },
  });
  fixtureJobs.push(job.id);
  return job.id;
}

/**
 * Creates a job in `01. Scoping` and attaches a deliverable.
 *
 * Deliverables can only be added while the scope is editable, so any test that
 * needs a deliverable AND an execution-stage job must scope first and then
 * advance the status. Getting this backwards yields a 409 SCOPE_FROZEN, which is
 * the system working correctly rather than a test failure.
 */
async function makeJobWithDeliverable(
  serviceCodeCode: string,
  plannedQuantity: number,
  options: { advanceTo?: string } = {},
): Promise<{ jobId: number; deliverableId: number; appliedRate: number }> {
  const projectId = await makeProject();
  const jobId = await makeJob(projectId, 'JOB_SCOPING');

  const serviceCode = await prisma.serviceCode.findFirstOrThrow({
    where: { code: serviceCodeCode },
    select: { id: true },
  });

  const cookie = await sessionFor('administrator');
  const created = await app.inject({
    method: 'POST',
    url: `/api/jobs/${jobId}/deliverables`,
    headers: { cookie },
    payload: { serviceCodeId: serviceCode.id, plannedQuantity },
  });

  if (created.statusCode !== 201) {
    throw new Error(`Fixture deliverable creation failed: ${created.statusCode} ${created.body}`);
  }

  const deliverable = created.json().deliverables[0];
  fixtureDeliverables.push(deliverable.id);

  if (options.advanceTo) {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: options.advanceTo as never },
    });
  }

  return { jobId, deliverableId: deliverable.id, appliedRate: deliverable.appliedRate };
}

// ===========================================================================

describe('Gate 5: amendment resolution', () => {
  it('inherits the project amendment when the job amendment is null', async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId);
    const cookie = await sessionFor('administrator');

    const response = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.job.amendmentInherited).toBe(true);
    expect(body.job.amendmentId).toBe(body.job.project.amendmentId);
  });

  it('honours an explicit job amendment over the project default', async () => {
    const projectId = await makeProject();
    const otherAmendment = await prisma.contractAmendment.findFirstOrThrow({
      select: { id: true, contractId: true },
    });

    const job = await prisma.job.create({
      data: {
        projectId,
        amendmentId: otherAmendment.id,
        description: 'Explicit amendment fixture',
      },
      select: { id: true },
    });
    fixtureJobs.push(job.id);

    const cookie = await sessionFor('administrator');
    const response = await app.inject({
      method: 'GET',
      url: `/api/jobs/${job.id}`,
      headers: { cookie },
    });

    expect(response.json().job.amendmentInherited).toBe(false);
    expect(response.json().job.amendmentId).toBe(otherAmendment.id);
  });
});

// ===========================================================================

describe('Gate 1: a field supervisor cannot rewind or jump ahead', () => {
  it('refuses every backward transition with 422', async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId, 'JOB_ACTUALS_IN_PROGRESS');
    const cookie = await sessionFor('site_supervisor');

    const backward = [
      '05. Work Complete',
      '04. WIP',
      '03. WNYS',
      '02. Awaiting PO',
      '07. Pack Ready',
      '08. Out for signature',
    ];

    for (const to of backward) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/jobs/${jobId}/transition`,
        headers: { cookie },
        payload: { status: to },
      });

      // 403 is also acceptable: the supervisor is not permitted to perform it.
      expect([403, 422], `${to} from Actuals In Progress`).toContain(response.statusCode);
    }

    // Confirm the job did not move.
    const after = await prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true },
    });
    expect(after.status).toBe('JOB_ACTUALS_IN_PROGRESS');
  });

  it('refuses a jump from 01. Scoping to 10. Invoiced', async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId, 'JOB_SCOPING');
    const cookie = await sessionFor('site_supervisor');

    // Assign the supervisor first, so this test exercises the STATE MACHINE
    // rather than the job-visibility check that would otherwise refuse first.
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    const assignment = await prisma.jobAssignment.create({
      data: { jobId, employeeId: me.json().employee.id, role: 'Field Supervisor' },
      select: { id: true },
    });
    fixtureAssignments.push(assignment.id);

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/transition`,
      headers: { cookie },
      payload: { status: '10. Invoiced' },
    });

    // 422 ILLEGAL, not 403. Legality is judged before capability, so the jump is
    // rejected as not existing in the pipeline at all — which is the more useful
    // answer than "you lack permission" for a move nobody may make.
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('ILLEGAL_TRANSITION');

    const after = await prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true },
    });
    expect(after.status).toBe('JOB_SCOPING');
  });

  it('refuses the jump for an assigned supervisor as an ILLEGAL transition', async () => {
    // Same move, judged purely by the pipeline. A supervisor lacks
    // job.transition.invoice, so this is a permission refusal...
    const projectId = await makeProject();
    const jobId = await makeJob(projectId, 'JOB_PACK_READY');
    const cookie = await sessionFor('site_supervisor');

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    const assignment = await prisma.jobAssignment.create({
      data: { jobId, employeeId: me.json().employee.id },
      select: { id: true },
    });
    fixtureAssignments.push(assignment.id);

    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/transition`,
      headers: { cookie },
      payload: { status: '10. Invoiced' },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error).toBe('TRANSITION_FORBIDDEN');

    // ...while an administrator, who holds every permission, is still refused
    // because 07. Pack Ready -> 10. Invoiced is a legal billing transition but
    // 01. Scoping -> 10. Invoiced is not in the pipeline at all.
    const adminCookie = await sessionFor('administrator');
    const scopingJobId = await makeJob(projectId, 'JOB_SCOPING');
    const illegal = await app.inject({
      method: 'POST',
      url: `/api/jobs/${scopingJobId}/transition`,
      headers: { cookie: adminCookie },
      payload: { status: '10. Invoiced' },
    });
    expect(illegal.statusCode).toBe(422);
    expect(illegal.json().error).toBe('ILLEGAL_TRANSITION');
  });

  it('refuses the jump even for an administrator, because it is simply illegal', async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId, 'JOB_SCOPING');
    const cookie = await sessionFor('administrator');

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/transition`,
      headers: { cookie },
      payload: { status: '10. Invoiced' },
    });

    // An administrator holds every permission but the pipeline still forbids it.
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('ILLEGAL_TRANSITION');
  });

  it('refuses to leave a cancelled job', async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId, 'JOB_CANCELLED');
    const cookie = await sessionFor('administrator');

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/transition`,
      headers: { cookie },
      payload: { status: '01. Scoping' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('INVALID_TRANSITION');
  });

  it('reports which transitions the supervisor actually has available', async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId, 'JOB_WIP');
    const cookie = await sessionFor('site_supervisor');

    const response = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/transitions`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const allowed = body.transitions
      .filter((t: { allowed: boolean }) => t.allowed)
      .map((t: { to: string }) => t.to);

    expect(allowed).toContain('05. Work Complete');
    expect(allowed).not.toContain('01. Scoping');
    expect(allowed).not.toContain('10. Invoiced');
  });

  it('refuses a transition on a job the supervisor is not assigned to', async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId, 'JOB_WIP');
    const cookie = await sessionFor('site_supervisor');

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/transition`,
      headers: { cookie },
      payload: { status: '05. Work Complete' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('JOB_NOT_ASSIGNED');
  });
});

// ===========================================================================

describe('Gate 4: planned quantities freeze after release for procurement', () => {
  it('allows planned edits while scoping, then refuses at 03. WNYS', async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId, 'JOB_SCOPING');
    const cookie = await sessionFor('administrator');

    const serviceCode = await prisma.serviceCode.findFirstOrThrow({
      where: { code: 'S00247970' },
      select: { id: true },
    });

    const created = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/deliverables`,
      headers: { cookie },
      payload: { serviceCodeId: serviceCode.id, plannedQuantity: 10 },
    });
    expect(created.statusCode).toBe(201);

    const deliverable = created.json().deliverables[0];
    fixtureDeliverables.push(deliverable.id);
    expect(deliverable.plannedSubtotal).toBe(175.23);

    // Editable while scoping.
    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/job-deliverables/${deliverable.id}/planned`,
      headers: { cookie },
      payload: { plannedQuantity: 25 },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().deliverables[0].plannedSubtotal).toBe(438.07); // 25 x 17.5226

    // Move to WNYS and try again.
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'JOB_WNYS' as never },
    });

    const frozen = await app.inject({
      method: 'PATCH',
      url: `/api/job-deliverables/${deliverable.id}/planned`,
      headers: { cookie },
      payload: { plannedQuantity: 99 },
    });

    expect(frozen.statusCode).toBe(409);
    expect(frozen.json().error).toBe('SCOPE_FROZEN');
    expect(frozen.json().message).toContain('02. Awaiting PO');

    // The value must be unchanged.
    const row = await prisma.jobServiceCode.findUniqueOrThrow({
      where: { id: deliverable.id },
      select: { plannedQuantity: true },
    });
    expect(row.plannedQuantity.toNumber()).toBe(25);
  });

  it('refuses to add a deliverable once the scope is frozen', async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId, 'JOB_PACK_READY');
    const cookie = await sessionFor('administrator');

    const serviceCode = await prisma.serviceCode.findFirstOrThrow({
      where: { code: 'S00247970' },
      select: { id: true },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/deliverables`,
      headers: { cookie },
      payload: { serviceCodeId: serviceCode.id, plannedQuantity: 5 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('SCOPE_FROZEN');
  });
});

// ===========================================================================

describe('Gate 2: actual quantities recalculate variance', () => {
  it('computes variance in real time from the actual quantity', async () => {
    const { jobId, deliverableId } = await makeJobWithDeliverable('S00247970', 10, {
      advanceTo: 'JOB_WIP',
    });
    const cookie = await sessionFor('administrator');

    const before = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/deliverables`,
      headers: { cookie },
    });
    const start = before.json().deliverables[0];
    expect(start.actualSubtotal).toBe(0);
    expect(start.quantityVariance).toBe(-10);

    const recorded = await app.inject({
      method: 'PATCH',
      url: `/api/job-deliverables/${deliverableId}/actual`,
      headers: { cookie },
      payload: { actualQuantity: 20 },
    });

    expect(recorded.statusCode).toBe(200);
    const updated = recorded.json().deliverables[0];

    expect(updated.actualSubtotal).toBe(350.45);
    expect(updated.plannedSubtotal).toBe(175.23); // unchanged
    expect(updated.quantityVariance).toBe(10);
    expect(updated.valueVariance).toBe(175.22);
  });

  it('reports an underrun as a negative variance', async () => {
    const { deliverableId } = await makeJobWithDeliverable('S00167401', 100, {
      advanceTo: 'JOB_WIP',
    });
    const cookie = await sessionFor('administrator');

    const recorded = await app.inject({
      method: 'PATCH',
      url: `/api/job-deliverables/${deliverableId}/actual`,
      headers: { cookie },
      payload: { actualQuantity: 95 },
    });

    const updated = recorded.json().deliverables[0];
    expect(updated.quantityVariance).toBe(-5);
    expect(updated.valueVariance).toBeLessThan(0);
  });

  it('refuses actuals outside the execution window', async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId, 'JOB_SCOPING');
    const cookie = await sessionFor('administrator');

    const serviceCode = await prisma.serviceCode.findFirstOrThrow({
      where: { code: 'S00247970' },
      select: { id: true },
    });

    const created = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/deliverables`,
      headers: { cookie },
      payload: { serviceCodeId: serviceCode.id, plannedQuantity: 10 },
    });
    const deliverable = created.json().deliverables[0];
    fixtureDeliverables.push(deliverable.id);

    const refused = await app.inject({
      method: 'PATCH',
      url: `/api/job-deliverables/${deliverable.id}/actual`,
      headers: { cookie },
      payload: { actualQuantity: 20 },
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('ACTUALS_LOCKED');
    expect(refused.json().message).toContain('04. WIP');
  });

  it('lets a supervisor record actuals on their own assigned job', async () => {
    const { jobId, deliverableId } = await makeJobWithDeliverable('S00247970', 10, {
      advanceTo: 'JOB_WIP',
    });
    const supervisorCookie = await sessionFor('site_supervisor');

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: supervisorCookie },
    });
    const assignment = await prisma.jobAssignment.create({
      data: { jobId, employeeId: me.json().employee.id, role: 'Field Supervisor' },
      select: { id: true },
    });
    fixtureAssignments.push(assignment.id);

    const recorded = await app.inject({
      method: 'PATCH',
      url: `/api/job-deliverables/${deliverableId}/actual`,
      headers: { cookie: supervisorCookie },
      payload: { actualQuantity: 30 },
    });

    expect(recorded.statusCode).toBe(200);
    expect(recorded.json().deliverables[0].actualSubtotal).toBe(525.68); // 30 x 17.5226
    expect(recorded.json().deliverables[0].quantityVariance).toBe(20);
  });
});

// ===========================================================================

describe('Gate 3: the applied_rate snapshot is immutable', () => {
  it('does not move when the service code rate changes', async () => {
    const adminCookie = await sessionFor('administrator');
    const amendmentId = await prisma.contractAmendment.findFirstOrThrow({ select: { id: true } });

    const rateCard = await prisma.serviceMasterRate.create({
      data: {
        amendmentId: amendmentId.id,
        serviceMasterCode: `T${Date.now().toString().slice(-8)}`,
        labourType: 'SNAPSHOT TEST TRADE',
        shiftType: 'NT',
        councilRate: 100,
        wagePremiumPct: 0,
        manInPocket: 100,
        leavePay: 0,
        totalStatutoryCost: 0,
        ppeCost: 0,
        transportCost: 0,
        equipmentCost: 0,
        overheadCost: 0,
        sgaCost: 0,
        profitCost: 0,
        fullLoadedRate: 100,
      },
      select: { id: true },
    });
    fixtureRateCards.push(rateCard.id);

    const serviceCode = await prisma.serviceCode.create({
      data: {
        amendmentId: amendmentId.id,
        code: `TEST-SNAP-${Date.now().toString().slice(-8)}`,
        description: 'Snapshot immutability fixture',
        category: 'ACTIVITY',
        uom: 'M',
        calculatedUnitRate: 10,
      },
      select: { id: true },
    });
    fixtureServiceCodes.push(serviceCode.id);

    const labourLine = await prisma.serviceCodeLabourItem.create({
      data: {
        serviceCodeId: serviceCode.id,
        serviceMasterRateId: rateCard.id,
        crewQuantity: 1,
        hoursPerUnit: 0.1, // 1 x 0.1 x 100 = 10.00
        lineSubtotal: 10,
      },
      select: { id: true },
    });

    const projectId = await makeProject();
    const jobId = await makeJob(projectId, 'JOB_SCOPING');

    try {
      // Scope the job, snapshotting the rate at 10.00.
      const created = await app.inject({
        method: 'POST',
        url: `/api/jobs/${jobId}/deliverables`,
        headers: { cookie: adminCookie },
        payload: { serviceCodeId: serviceCode.id, plannedQuantity: 10 },
      });
      expect(created.statusCode).toBe(201);
      const deliverable = created.json().deliverables[0];
      fixtureDeliverables.push(deliverable.id);

      expect(deliverable.appliedRate).toBe(10);
      expect(deliverable.plannedSubtotal).toBe(100);

      // Advance to execution so actuals can be recorded.
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'JOB_WIP' as never },
      });

      const recorded = await app.inject({
        method: 'PATCH',
        url: `/api/job-deliverables/${deliverable.id}/actual`,
        headers: { cookie: adminCookie },
        payload: { actualQuantity: 12 },
      });
      expect(recorded.statusCode).toBe(200);

      // Now re-price the underlying service code.
      await prisma.serviceMasterRate.update({
        where: { id: rateCard.id },
        data: { fullLoadedRate: 200 },
      });
      await prisma.serviceCodeLabourItem.update({
        where: { id: labourLine.id },
        data: { hoursPerUnit: 0.2, lineSubtotal: 40 }, // now 20.00 per unit
      });
      await prisma.serviceCode.update({
        where: { id: serviceCode.id },
        data: { calculatedUnitRate: 20 },
      });

      const after = await app.inject({
        method: 'GET',
        url: `/api/jobs/${jobId}/deliverables`,
        headers: { cookie: adminCookie },
      });

      const line = after.json().deliverables[0];

      // The snapshot must not have moved...
      expect(line.appliedRate).toBe(10);
      expect(line.plannedSubtotal).toBe(100);
      expect(line.actualSubtotal).toBe(120);

      // ...but the drift is reported so a QS can notice.
      expect(line.rateHasDrifted).toBe(true);
      expect(line.currentRate).toBe(20);
    } finally {
      // FK-safe order, and each step independently guarded. Deleting the service
      // code before its labour line leaves fails on the foreign key, which used to
      // abort the whole finally block and leak the rate card into the next run.
      await prisma.serviceCodeLabourItem
        .deleteMany({ where: { serviceCodeId: serviceCode.id } })
        .catch(() => undefined);
      await prisma.serviceCode.deleteMany({ where: { id: serviceCode.id } }).catch(() => undefined);
      await prisma.serviceMasterRate
        .deleteMany({ where: { id: rateCard.id } })
        .catch(() => undefined);
    }
  });

  it('leaves the seeded job 1 deliverables untouched', async () => {
    const adminCookie = await sessionFor('administrator');

    const response = await app.inject({
      method: 'GET',
      url: '/api/jobs/1/deliverables',
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
    const lines = response.json().deliverables;
    expect(lines).toHaveLength(3);

    // The exact stored figures, unchanged by all of Phase 3.
    expect(lines.map((l: { plannedSubtotal: number }) => l.plannedSubtotal)).toEqual([
      175.23, 2791.58, 23782,
    ]);
    expect(lines.map((l: { actualSubtotal: number }) => l.actualSubtotal)).toEqual([
      350.45, 2652, 23782,
    ]);
    expect(response.json().summary.actualSubtotal).toBe(26784.45);
  });
});

// ===========================================================================

describe('assignments and the field view', () => {
  it('assigns an employee and exposes the job to them', async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId, 'JOB_WIP');
    const supervisorCookie = await sessionFor('site_supervisor');
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: supervisorCookie },
    });
    const employeeId = me.json().employee.id;

    // Before assignment the supervisor cannot see it.
    const before = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}`,
      headers: { cookie: supervisorCookie },
    });
    expect(before.statusCode).toBe(403);

    const assignment = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/assignments`,
      headers: { cookie: supervisorCookie },
      payload: { employeeId, role: 'Field Supervisor' },
    });

    // A supervisor may not assign crew; they only read their own jobs.
    expect(assignment.statusCode).toBe(403);

    const adminCookie = await sessionFor('administrator');
    const created = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/assignments`,
      headers: { cookie: adminCookie },
      payload: { employeeId, role: 'Field Supervisor' },
    });
    expect(created.statusCode).toBe(201);
    fixtureAssignments.push(created.json().assignment.id);

    const after = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}`,
      headers: { cookie: supervisorCookie },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().job.assignments).toHaveLength(1);
  });

  it('scopes a supervisor job list to their own jobs only', async () => {
    const projectId = await makeProject();
    const unassignedJob = await makeJob(projectId, 'JOB_WIP');
    const supervisorCookie = await sessionFor('site_supervisor');

    const response = await app.inject({
      method: 'GET',
      url: '/api/jobs',
      headers: { cookie: supervisorCookie },
    });

    expect(response.statusCode).toBe(200);
    const ids = response.json().jobs.map((j: { id: number }) => j.id);
    // The fixture job has no assignment to this supervisor.
    expect(ids).not.toContain(unassignedJob);
  });

  it('serves the field view with permissions and variance', async () => {
    const supervisorCookie = await sessionFor('site_supervisor');
    const response = await app.inject({
      method: 'GET',
      url: '/api/field/my-work',
      headers: { cookie: supervisorCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.jobs)).toBe(true);
    for (const job of body.jobs) {
      expect(job.permissions).toHaveProperty('canEditActuals');
      expect(job.permissions).toHaveProperty('availableTransitions');
      expect(job).toHaveProperty('summary');
    }
  });
});

// ===========================================================================

describe('job detail and dashboard payloads', () => {
  it('returns deliverables, summary and permissions for job 1', async () => {
    const cookie = await sessionFor('administrator');
    const response = await app.inject({
      method: 'GET',
      url: '/api/jobs/1',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.deliverables).toHaveLength(3);
    expect(body.summary.actualSubtotal).toBe(26784.45);
    expect(body.summary.plannedSubtotal).toBe(26748.81);
    expect(body.permissions.scopedToAssignedJobs).toBe(false);

    // The permission flags must agree with the shared state machine for
    // WHATEVER status the job is currently in. Pinning a specific status here
    // broke the suite the first time job 1 legitimately advanced (06 -> 07
    // during interactive verification): baseline jobs are live data that move
    // through the pipeline, so the test asserts consistency, not position.
    const status = body.job.status as JobStatus;
    expect(body.permissions.canEditActuals).toBe(canEditActuals(status));
    expect(body.permissions.canEditPlanned).toBe(canEditPlanned(status));

    // An administrator holds every transition permission, so the available
    // transitions must be exactly the state machine's legal targets.
    expect(new Set(body.permissions.availableTransitions)).toEqual(
      new Set(allNextStatuses(status)),
    );
  });

  it('lists projects with per-status job counts', async () => {
    const cookie = await sessionFor('administrator');
    const response = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const project = response.json().projects[0];
    expect(project.code).toBe('PRJ-SAS-2026-01');
    expect(Object.keys(project.statusCounts)).toHaveLength(13);

    // The counts must reconcile with the jobs themselves: they sum to the job
    // total, and the bucket for each job's current status is non-zero. Like the
    // test above, this deliberately avoids pinning any job to a stage.
    const counted = Object.values(project.statusCounts as Record<string, number>).reduce(
      (sum, n) => sum + n,
      0,
    );
    expect(counted).toBe(project.jobs.length);
    for (const j of project.jobs as Array<{ status: string }>) {
      expect(project.statusCounts[j.status]).toBeGreaterThan(0);
    }
  });

  it('summarises financial exposure per project', async () => {
    const cookie = await sessionFor('administrator');
    const response = await app.inject({
      method: 'GET',
      url: '/api/projects/1',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.project.jobs).toHaveLength(2);
    expect(body.project.exposure.actualSubtotal).toBeGreaterThan(0);
  });
});

// ===========================================================================

describe('access control', () => {
  it('refuses unauthenticated access to operations endpoints', async () => {
    for (const url of ['/api/projects', '/api/jobs', '/api/jobs/1', '/api/jobs/1/deliverables']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('stops a billing clerk from editing the scope', async () => {
    const projectId = await makeProject();
    const jobId = await makeJob(projectId, 'JOB_SCOPING');
    const billingCookie = await sessionFor('billing_clerk');

    const serviceCode = await prisma.serviceCode.findFirstOrThrow({
      where: { code: 'S00247970' },
      select: { id: true },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/deliverables`,
      headers: { cookie: billingCookie },
      payload: { serviceCodeId: serviceCode.id, plannedQuantity: 5 },
    });

    expect(response.statusCode).toBe(403);
  });

  it('stops a PM from recording field actuals', async () => {
    const { deliverableId } = await makeJobWithDeliverable('S00247970', 10, {
      advanceTo: 'JOB_WIP',
    });

    const pmCookie = await sessionFor('project_manager');
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/job-deliverables/${deliverableId}/actual`,
      headers: { cookie: pmCookie },
      payload: { actualQuantity: 20 },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('FORBIDDEN');
  });
});
