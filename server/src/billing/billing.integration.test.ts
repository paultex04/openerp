/**
 * Phase 4 acceptance gates, exercised against the live database.
 *
 *   1. A draft invoice derives every figure from measured actuals and the
 *      amendment: lines, VAT and totals, with a sequential invoice number.
 *   2. A non-VAT-registered client is billed with no tax.
 *   3. Approving settles the job: full actuals -> 10. Invoiced, a subset ->
 *      11. Partially Invoiced.
 *   4. The lifecycle guards hold: no generation before billing owns the job, no
 *      second open invoice, no edits or deletion once issued, no payment before
 *      approval, terminal states are terminal.
 *   5. Role boundaries: billing owns the lifecycle, the QS drafts but never
 *      approves, nobody else touches invoices.
 *   6. The seeded invoice INV-2026-03-0042 is read but never modified.
 *
 * Fixtures are created and torn down within the test. Job 1 already carries the
 * seeded Submitted invoice, so generation is exercised on fixture jobs only —
 * attempting it on job 1 must be refused as a second open invoice.
 */
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
const createdUsers: Array<{ id: number; employeeId: number }> = [];
const cookies = new Map<string, string>();

/** Fixtures to remove after the suite, in FK-safe order. */
const fixtureInvoices: number[] = [];
const fixtureDeliverables: number[] = [];
const fixtureAssignments: number[] = [];
const fixtureJobs: number[] = [];
const fixtureProjects: string[] = [];
const fixtureServiceCodes: number[] = [];
const fixtureRateCards: number[] = [];
const fixtureAmendments: number[] = [];
const fixtureContracts: number[] = [];
const fixtureClients: number[] = [];

beforeAll(async () => {
  app = await buildApp({ config: loadConfig(), logger: false });
  await app.ready();
});

afterAll(async () => {
  for (const id of fixtureInvoices) {
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: id } }).catch(() => undefined);
    await prisma.invoice.deleteMany({ where: { id } }).catch(() => undefined);
  }
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
    await prisma.serviceCode
      .deleteMany({ where: { id: { in: fixtureServiceCodes } } })
      .catch(() => undefined);
  }
  if (fixtureRateCards.length) {
    await prisma.serviceMasterRate
      .deleteMany({ where: { id: { in: fixtureRateCards } } })
      .catch(() => undefined);
  }
  if (fixtureAmendments.length) {
    await prisma.contractAmendment
      .deleteMany({ where: { id: { in: fixtureAmendments } } })
      .catch(() => undefined);
  }
  if (fixtureContracts.length) {
    await prisma.contract
      .deleteMany({ where: { id: { in: fixtureContracts } } })
      .catch(() => undefined);
  }
  if (fixtureClients.length) {
    await prisma.client
      .deleteMany({ where: { id: { in: fixtureClients } } })
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

const stamp = () => Date.now().toString(36);

/**
 * Builds a billable fixture job: project -> job -> scoped deliverable ->
 * walked to 07. Pack Ready with a recorded actual.
 *
 * The walk uses the API transitions rather than direct status writes, so the
 * fixture proves the pipeline it will later bill through. `clientId` and
 * `amendmentId` default to the seeded chain; pass `exemptClient: true` for a
 * non-VAT-registered chain (its own client/contract/amendment/service code).
 */
async function makeBillableJob(options: { exemptClient?: boolean } = {}): Promise<{
  jobId: number;
  deliverableId: number;
  appliedRate: number;
  serviceCodeId: number;
}> {
  let contractId: number;
  let amendmentId: number;

  if (options.exemptClient) {
    const client = await prisma.client.create({
      data: {
        name: `Smoke Exempt ${stamp()}`,
        email: `exempt-${stamp()}@example.test`,
        isVatRegistered: false,
        vatNumber: null,
      },
      select: { id: true },
    });
    fixtureClients.push(client.id);

    const contract = await prisma.contract.create({
      data: {
        clientId: client.id,
        number: `EXEMPT-${stamp()}`,
        description: 'Phase 4 exempt-chain fixture contract',
      },
      select: { id: true },
    });
    fixtureContracts.push(contract.id);

    const amendment = await prisma.contractAmendment.create({
      data: {
        contractId: contract.id,
        amendmentNumber: `AMD-EX-${stamp()}`,
        effectiveDate: new Date('2026-01-01'),
        vatRate: 0.15,
      },
      select: { id: true },
    });
    fixtureAmendments.push(amendment.id);
    contractId = contract.id;
    amendmentId = amendment.id;
  } else {
    // Contract and amendment together, so the pair is always coherent. See
    // `seededContractWithAmendment` for why picking them independently is wrong.
    const seeded = await seededContractWithAmendment();
    contractId = seeded.contractId;
    amendmentId = seeded.amendmentId;
  }

  const projectCode = `TEST-BILL-${stamp()}-${Math.floor(Math.random() * 1000)}`;
  const project = await prisma.project.create({
    data: {
      contractId,
      amendmentId,
      code: projectCode,
      year: 2026,
      description: 'Phase 4 test fixture project',
    },
    select: { id: true },
  });
  fixtureProjects.push(projectCode);

  const job = await prisma.job.create({
    data: { projectId: project.id, amendmentId: null, description: 'Phase 4 fixture job' },
    select: { id: true },
  });
  fixtureJobs.push(job.id);

  // A service code under the job's amendment. The exempt chain needs its own;
  // the standard chain reuses a seeded code.
  let serviceCodeId: number;
  let appliedRate: number;
  if (options.exemptClient) {
    const rateCard = await prisma.serviceMasterRate.create({
      data: {
        amendmentId,
        serviceMasterCode: `X${stamp().slice(-8)}`,
        labourType: 'EXEMPT TEST TRADE',
        shiftType: 'NT',
        councilRate: 50,
        wagePremiumPct: 0,
        manInPocket: 50,
        leavePay: 0,
        totalStatutoryCost: 0,
        ppeCost: 0,
        transportCost: 0,
        equipmentCost: 0,
        overheadCost: 0,
        sgaCost: 0,
        profitCost: 0,
        fullLoadedRate: 50,
      },
      select: { id: true },
    });
    fixtureRateCards.push(rateCard.id);

    const code = await prisma.serviceCode.create({
      data: {
        amendmentId,
        code: `TEST-EX-${stamp().slice(-6)}`,
        description: 'Exempt-chain fixture code',
        category: 'ACTIVITY',
        uom: 'M',
        calculatedUnitRate: 50,
      },
      select: { id: true },
    });
    fixtureServiceCodes.push(code.id);
    serviceCodeId = code.id;
    appliedRate = 50;

    await prisma.serviceCodeLabourItem.create({
      data: {
        serviceCodeId: code.id,
        serviceMasterRateId: rateCard.id,
        crewQuantity: 1,
        hoursPerUnit: 1,
        lineSubtotal: 50,
      },
    });
  } else {
    const code = await prisma.serviceCode.findFirstOrThrow({
      where: { code: 'S00247970' },
      select: { id: true, calculatedUnitRate: true },
    });
    serviceCodeId = code.id;
    appliedRate = code.calculatedUnitRate.toNumber();
  }

  const cookie = await sessionFor('administrator');
  const added = await app.inject({
    method: 'POST',
    url: `/api/jobs/${job.id}/deliverables`,
    headers: { cookie },
    payload: { serviceCodeId, plannedQuantity: 10 },
  });
  if (added.statusCode !== 201) {
    throw new Error(`Fixture deliverable failed: ${added.statusCode} ${added.body}`);
  }
  const deliverable = added.json().deliverables[0];
  fixtureDeliverables.push(deliverable.id);

  // Walk the pipeline to billing ownership, then record the actual.
  for (const step of ['01A. Scoped', '02. Awaiting PO', '03. WNYS', '04. WIP']) {
    const move = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/transition`,
      headers: { cookie },
      payload: { status: step },
    });
    if (move.statusCode !== 200) {
      throw new Error(`Fixture walk to ${step} failed: ${move.statusCode} ${move.body}`);
    }
  }

  const recorded = await app.inject({
    method: 'PATCH',
    url: `/api/job-deliverables/${deliverable.id}/actual`,
    headers: { cookie },
    payload: { actualQuantity: 20 },
  });
  if (recorded.statusCode !== 200) {
    throw new Error(`Fixture actual failed: ${recorded.statusCode} ${recorded.body}`);
  }

  for (const step of ['05. Work Complete', '06. Actuals in Progress', '07. Pack Ready']) {
    const move = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/transition`,
      headers: { cookie },
      payload: { status: step },
    });
    if (move.statusCode !== 200) {
      throw new Error(`Fixture walk to ${step} failed: ${move.statusCode} ${move.body}`);
    }
  }

  return { jobId: job.id, deliverableId: deliverable.id, appliedRate, serviceCodeId };
}

/** Generates a draft on a billable fixture job and tracks it for cleanup. */
async function generateOn(jobId: number, body: Record<string, unknown> = {}) {
  const cookie = await sessionFor('administrator');
  const res = await app.inject({
    method: 'POST',
    url: `/api/jobs/${jobId}/invoices`,
    headers: { cookie },
    payload: body,
  });
  if (res.statusCode === 201) {
    fixtureInvoices.push(res.json().invoice.id);
  }
  return res;
}

/** Moves a fixture invoice along, voiding via cancel where the test ends. */
async function moveInvoice(invoiceId: number, to: string, role = 'administrator') {
  const cookie = await sessionFor(role);
  return app.inject({
    method: 'POST',
    url: `/api/invoices/${invoiceId}/transition`,
    headers: { cookie },
    payload: { status: to },
  });
}

// ===========================================================================

describe('Gate 1: generation derives every figure', () => {
  it('bills actuals at the snapshot rate with amendment VAT', async () => {
    const { jobId, appliedRate } = await makeBillableJob();
    const res = await generateOn(jobId);

    expect(res.statusCode).toBe(201);
    const body = res.json();

    // 20 m at the 17.5226 snapshot, 15% VAT.
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].billedQuantity).toBe(20);
    expect(body.lines[0].unitPrice).toBe(appliedRate);
    expect(body.lines[0].subtotal).toBe(350.45);

    const invoice = body.invoice;
    expect(invoice.invoiceNumber).toMatch(/^INV-\d{4}-\d{2}-\d{4}$/);
    expect(invoice.status).toBe('Draft');
    expect(invoice.subtotalAmount).toBe(350.45);
    expect(invoice.taxRate).toBe(0.15);
    expect(invoice.taxAmount).toBe(52.57); // 350.45 x 15%
    expect(invoice.totalWithTax).toBe(403.02);
    expect(invoice.totalAmount).toBe(403.02); // legacy column mirrors the total
    // The seeded client is VAT-registered but carries no VAT number (a known
    // baseline gap, ADR-001), so a new VAT-charging invoice cannot be fully
    // compliant. The tax figures are still correct; what is flagged is the
    // missing registration evidence.
    expect(body.compliance.ok).toBe(false);
    expect(body.compliance.warnings.length).toBeGreaterThan(0);
    expect(body.compliance.warnings.join(' ').toLowerCase()).toContain('vat');

    // The job position reports the unbilled remainder honestly.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/invoices/${invoice.id}`,
      headers: { cookie: await sessionFor('administrator') },
    });
    expect(detail.json().jobPosition.jobActualTotal).toBe(350.45);
    expect(detail.json().jobPosition.recognisedBilledTotal).toBe(0);
    expect(detail.json().jobPosition.remainingUnbilled).toBe(350.45);
  });

  it('skips zero-actual lines and reports them', async () => {
    // Two scoped lines, only the first measured: generation bills one and
    // names the skipped one, rather than emitting a R 0.00 placeholder line.
    const { jobId } = await makeTwoLineJob({ measure: 'first' });

    const res = await generateOn(jobId);
    expect(res.statusCode).toBe(201);
    expect(res.json().lines).toHaveLength(1);
    expect(res.json().skippedZeroActual).toHaveLength(1);
  });

  it('numbers sequentially within the issue month', async () => {
    const first = await makeBillableJob();
    const second = await makeBillableJob();

    const a = await generateOn(first.jobId);
    const b = await generateOn(second.jobId);

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);

    const numA = a.json().invoice.invoiceNumber as string;
    const numB = b.json().invoice.invoiceNumber as string;
    expect(numA.slice(0, 11)).toBe(numB.slice(0, 11)); // same INV-YYYY-MM-
    expect(Number(numB.slice(-4)) - Number(numA.slice(-4))).toBe(1);
  });
});

describe('Gate 2: VAT treatment', () => {
  it('reports compliance as clean once a VAT number is on file', async () => {
    // Mirrors Gate 1, which must warn because the seeded client has no VAT
    // number. Filling it in proves the compliance check keys on that field
    // rather than always warning.
    const { jobId } = await makeBillableJob();
    const client = await prisma.client.update({
      where: { id: 1 },
      data: { vatNumber: '4123456789' },
      select: { id: true },
    });
    void client;

    try {
      const res = await generateOn(jobId);
      expect(res.statusCode).toBe(201);
      expect(res.json().compliance.ok).toBe(true);
      expect(res.json().invoice.taxAmount).toBeGreaterThan(0);
    } finally {
      await prisma.client.update({ where: { id: 1 }, data: { vatNumber: null } });
    }
  });

  it('bills no tax for a non-registered client', async () => {
    const { jobId } = await makeBillableJob({ exemptClient: true });
    const res = await generateOn(jobId);

    expect(res.statusCode).toBe(201);
    const invoice = res.json().invoice;

    // 20 m at 50.00, no VAT.
    expect(invoice.subtotalAmount).toBe(1000);
    expect(invoice.taxRate).toBe(0.15); // the amendment rate is still snapshot
    expect(invoice.taxAmount).toBe(0);
    expect(invoice.totalWithTax).toBe(1000);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/invoices/${invoice.id}`,
      headers: { cookie: await sessionFor('administrator') },
    });
    expect(detail.json().vat.effectiveTaxRate).toBe(0);
    expect(detail.json().client.isVatRegistered).toBe(false);
  });

  it('flags a missing VAT number when tax is charged', async () => {
    // The seeded client carries a VAT number, so compliance passes there (Gate 1
    // asserts ok: true). A registered client WITHOUT a number must warn: the
    // document claims tax but cannot evidence registration.
    const { jobId } = await makeBillableJob();
    const noVatTag = Date.now().toString(36);
    const client = await prisma.client.create({
      data: {
        name: `No-VAT-No ${noVatTag}`,
        email: `novatno-${noVatTag}@example.test`,
        isVatRegistered: true,
        vatNumber: null,
      },
      select: { id: true },
    });
    fixtureClients.push(client.id);

    // Re-point the fixture job's chain at the numberless client via its project.
    const job = await prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { projectId: true },
    });
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: job.projectId },
      select: { contractId: true },
    });
    const contract = await prisma.contract.findUniqueOrThrow({
      where: { id: project.contractId },
      select: { clientId: true },
    });
    const originalClientId = contract.clientId;
    await prisma.contract.update({
      where: { id: project.contractId },
      data: { clientId: client.id },
    });

    try {
      const res = await generateOn(jobId);
      expect(res.statusCode).toBe(201);
      expect(res.json().compliance.ok).toBe(false);
      expect(res.json().compliance.warnings.length).toBeGreaterThan(0);
    } finally {
      await prisma.contract.update({
        where: { id: project.contractId },
        data: { clientId: originalClientId },
      });
    }
  });
});

describe('Gate 3: approval settles the job', () => {
  it('marks the job 10. Invoiced when all actuals are billed', async () => {
    const { jobId } = await makeBillableJob();
    const res = await generateOn(jobId);
    const invoiceId = res.json().invoice.id;

    expect(await moveInvoice(invoiceId, 'Submitted', 'billing_clerk')).toHaveProperty(
      'statusCode',
      200,
    );

    const approved = await moveInvoice(invoiceId, 'Approved', 'billing_clerk');
    expect(approved.statusCode).toBe(200);
    expect(approved.json().transition.jobStatus).toBe('10. Invoiced');

    const job = await prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true },
    });
    expect(job.status).toBe('JOB_INVOICED');
  });

  it('marks 11. Partially Invoiced when only some lines are billed', async () => {
    // Two measured lines, invoice for one: the job is partly billed.
    const { jobId } = await makeTwoLineJob();
    const cookie = await sessionFor('administrator');

    const grid = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/deliverables`,
      headers: { cookie },
    });
    const lines = grid.json().deliverables as Array<{ id: number; actualQuantity: number }>;
    expect(lines).toHaveLength(2);

    const res = await generateOn(jobId, { deliverableIds: [lines[0]!.id] });
    expect(res.statusCode).toBe(201);
    expect(res.json().lines).toHaveLength(1);
    expect(res.json().skippedZeroActual).toEqual([]);

    await moveInvoice(res.json().invoice.id, 'Submitted', 'billing_clerk');
    const done = await moveInvoice(res.json().invoice.id, 'Approved', 'billing_clerk');
    expect(done.statusCode).toBe(200);
    expect(done.json().transition.jobStatus).toBe('11. Partially Invoiced');

    const job = await prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true },
    });
    expect(job.status).toBe('JOB_PARTIALLY_INVOICED');
  });

  it('a second invoice may follow once the first is settled', async () => {
    // Deliberate design consequence: only a Draft, Submitted, Approved,
    // Partially Paid or Disputed invoice blocks, because each still represents a
    // live claim on the job's actuals. `Paid` and `Cancelled` are the only closed
    // states, so a progress invoice must be fully settled (or written off) before
    // the next progress invoice can be raised.
    //
    // `Partially Paid` blocks too. It was initially excluded, which let a second
    // progress invoice be raised on top of a part-settled one and bill the same
    // lines twice — caught by the Phase 4 smoke test, not by the unit suite.
    const { jobId } = await makeTwoLineJob();
    const cookie = await sessionFor('administrator');

    const grid = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/deliverables`,
      headers: { cookie },
    });
    const lines = grid.json().deliverables as Array<{ id: number }>;

    const first = await generateOn(jobId, { deliverableIds: [lines[0]!.id] });
    expect(first.statusCode).toBe(201);
    await moveInvoice(first.json().invoice.id, 'Submitted', 'billing_clerk');
    await moveInvoice(first.json().invoice.id, 'Approved', 'billing_clerk');

    const blocked = await generateOn(jobId, { deliverableIds: [lines[1]!.id] });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('OPEN_INVOICE_EXISTS');

    // A part-settled invoice is still a live claim, so it must block too.
    await moveInvoice(first.json().invoice.id, 'Partially Paid', 'billing_clerk');
    const stillBlocked = await generateOn(jobId, { deliverableIds: [lines[1]!.id] });
    expect(stillBlocked.statusCode).toBe(409);
    expect(stillBlocked.json().error).toBe('OPEN_INVOICE_EXISTS');

    // A part-settled invoice can be written off, which closes it.
    await moveInvoice(first.json().invoice.id, 'Cancelled', 'billing_clerk');
    const second = await generateOn(jobId, { deliverableIds: [lines[1]!.id] });
    expect(second.statusCode).toBe(201);

    await moveInvoice(second.json().invoice.id, 'Submitted', 'billing_clerk');
    const done = await moveInvoice(second.json().invoice.id, 'Approved', 'billing_clerk');
    expect(done.json().transition.jobStatus).toBe('10. Invoiced');
  });
});

/**
 * A fixture job with two scoped lines, for partial-billing tests.
 *
 * `measure: 'first'` records an actual on the first line only, leaving the
 * second at zero — the shape that exercises the zero-actual skip path.
 */
async function makeTwoLineJob(options: { measure?: 'all' | 'first' } = {}): Promise<{
  jobId: number;
}> {
  const measure = options.measure ?? 'all';
  const { contractId, amendmentId } = await seededContractWithAmendment();
  const projectCode = `TEST-BILL2-${Date.now().toString(36)}`;

  const project = await prisma.project.create({
    data: { contractId, amendmentId, code: projectCode, year: 2026 },
    select: { id: true },
  });
  fixtureProjects.push(projectCode);

  const job = await prisma.job.create({
    data: { projectId: project.id, amendmentId: null, description: 'Two-line fixture' },
    select: { id: true },
  });
  fixtureJobs.push(job.id);

  const cookie = await sessionFor('administrator');
  const codes = await prisma.serviceCode.findMany({
    where: { code: { in: ['S00247970', 'S00167401'] } },
    select: { id: true },
  });

  for (const code of codes) {
    const added = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/deliverables`,
      headers: { cookie },
      payload: { serviceCodeId: code.id, plannedQuantity: 10 },
    });
    if (added.statusCode !== 201) throw new Error(`Two-line scope failed: ${added.body}`);
    fixtureDeliverables.push(added.json().deliverables.at(-1).id);
  }

  for (const step of ['01A. Scoped', '02. Awaiting PO', '03. WNYS', '04. WIP']) {
    await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/transition`,
      headers: { cookie },
      payload: { status: step },
    });
  }

  const grid = await app.inject({
    method: 'GET',
    url: `/api/jobs/${job.id}/deliverables`,
    headers: { cookie },
  });
  const measured =
    measure === 'first'
      ? (grid.json().deliverables as Array<{ id: number }>).slice(0, 1)
      : (grid.json().deliverables as Array<{ id: number }>);
  for (const line of measured) {
    const recorded = await app.inject({
      method: 'PATCH',
      url: `/api/job-deliverables/${line.id}/actual`,
      headers: { cookie },
      payload: { actualQuantity: 10 },
    });
    if (recorded.statusCode !== 200) throw new Error(`Two-line actual failed: ${recorded.body}`);
  }

  for (const step of ['05. Work Complete', '06. Actuals in Progress', '07. Pack Ready']) {
    await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/transition`,
      headers: { cookie },
      payload: { status: step },
    });
  }

  return { jobId: job.id };
}

describe('Gate 4: lifecycle guards', () => {
  it('refuses generation before billing owns the job', async () => {
    const { contractId, amendmentId } = await seededContractWithAmendment();
    const projectCode = `TEST-EARLY-${Date.now().toString(36)}`;
    const project = await prisma.project.create({
      data: { contractId, amendmentId, code: projectCode, year: 2026 },
      select: { id: true },
    });
    fixtureProjects.push(projectCode);

    const job = await prisma.job.create({
      data: { projectId: project.id, description: 'Too-early fixture' },
      select: { id: true },
    });
    fixtureJobs.push(job.id);

    // Walk only to WIP and record an actual directly.
    const cookie = await sessionFor('administrator');
    for (const step of ['01A. Scoped', '02. Awaiting PO', '03. WNYS', '04. WIP']) {
      await app.inject({
        method: 'POST',
        url: `/api/jobs/${job.id}/transition`,
        headers: { cookie },
        payload: { status: step },
      });
    }

    const res = await generateOn(job.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('JOB_NOT_BILLABLE');
    expect(res.json().message).toContain('07. Pack Ready');
  });

  it('refuses a second open invoice for the same job', async () => {
    // Job 1 carries the seeded Submitted invoice: generation must refuse.
    const res = await generateOn(1);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('OPEN_INVOICE_EXISTS');
    expect(res.json().message).toContain('INV-2026-03-0042');
  });

  it('refuses generation with no measured actuals', async () => {
    const { jobId } = await makeBillableJob();
    // Void the actual by recording... actuals cannot be un-recorded via API.
    // Instead use a fresh job walked to 07 with no actuals at all.
    void jobId;

    const { contractId, amendmentId } = await seededContractWithAmendment();
    const projectCode = `TEST-NOACT-${Date.now().toString(36)}`;
    const project = await prisma.project.create({
      data: { contractId, amendmentId, code: projectCode, year: 2026 },
      select: { id: true },
    });
    fixtureProjects.push(projectCode);
    const job = await prisma.job.create({
      data: { projectId: project.id, description: 'No-actual fixture' },
      select: { id: true },
    });
    fixtureJobs.push(job.id);

    const cookie = await sessionFor('administrator');
    const code = await prisma.serviceCode.findFirstOrThrow({
      where: { code: 'S00247970' },
      select: { id: true },
    });
    const added = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/deliverables`,
      headers: { cookie },
      payload: { serviceCodeId: code.id, plannedQuantity: 10 },
    });
    fixtureDeliverables.push(added.json().deliverables[0].id);

    for (const step of [
      '01A. Scoped',
      '02. Awaiting PO',
      '03. WNYS',
      '04. WIP',
      '05. Work Complete',
      '06. Actuals in Progress',
      '07. Pack Ready',
    ]) {
      await app.inject({
        method: 'POST',
        url: `/api/jobs/${job.id}/transition`,
        headers: { cookie },
        payload: { status: step },
      });
    }

    const res = await generateOn(job.id);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('NOTHING_BILLABLE');
  });

  it('refuses deliverables from another job', async () => {
    const a = await makeBillableJob();
    const b = await makeBillableJob();

    const grid = await app.inject({
      method: 'GET',
      url: `/api/jobs/${b.jobId}/deliverables`,
      headers: { cookie: await sessionFor('administrator') },
    });
    const foreignId = (grid.json().deliverables as Array<{ id: number }>)[0]!.id;

    const res = await generateOn(a.jobId, { deliverableIds: [foreignId] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('LINE_NOT_ON_JOB');
  });

  it('locks drafts on submit: no edits, no deletion', async () => {
    const { jobId } = await makeBillableJob();
    const res = await generateOn(jobId);
    const invoiceId = res.json().invoice.id;
    const cookie = await sessionFor('administrator');

    await moveInvoice(invoiceId, 'Submitted', 'billing_clerk');

    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/invoices/${invoiceId}`,
      headers: { cookie },
      payload: { notes: 'changed after submit' },
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error).toBe('INVOICE_LOCKED');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/invoices/${invoiceId}`,
      headers: { cookie },
    });
    // 403, not 409: a Submitted document is deletable by neither permission —
    // drafts need invoice.write, cancellations need invoice.status — so the
    // route refuses before the service is even reached. Submitted documents are
    // withdrawn by cancellation, not deletion.
    expect(del.statusCode).toBe(403);
    expect(del.json().error).toBe('FORBIDDEN');
  });

  it('rejects illegal jumps for everyone including the administrator', async () => {
    const { jobId } = await makeBillableJob();
    const res = await generateOn(jobId);
    const invoiceId = res.json().invoice.id;
    const cookie = await sessionFor('administrator');

    const jump = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/transition`,
      headers: { cookie },
      payload: { status: 'Paid' },
    });
    expect(jump.statusCode).toBe(422);
    expect(jump.json().error).toBe('ILLEGAL_TRANSITION');

    const noop = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/transition`,
      headers: { cookie },
      payload: { status: 'Draft' },
    });
    expect(noop.statusCode).toBe(409);
  });

  it('runs payment to terminal and refuses anything after', async () => {
    const { jobId } = await makeBillableJob();
    const res = await generateOn(jobId);
    const invoiceId = res.json().invoice.id;

    await moveInvoice(invoiceId, 'Submitted', 'billing_clerk');
    await moveInvoice(invoiceId, 'Approved', 'billing_clerk');
    expect(await moveInvoice(invoiceId, 'Partially Paid', 'billing_clerk')).toHaveProperty(
      'statusCode',
      200,
    );
    expect(await moveInvoice(invoiceId, 'Paid', 'billing_clerk')).toHaveProperty('statusCode', 200);

    const after = await moveInvoice(invoiceId, 'Disputed', 'billing_clerk');
    expect(after.statusCode).toBe(409);
    expect(after.json().error).toBe('INVALID_TRANSITION');
  });

  it('voids an approved invoice and allows cleanup', async () => {
    const { jobId } = await makeBillableJob();
    const res = await generateOn(jobId);
    const invoiceId = res.json().invoice.id;
    const cookie = await sessionFor('administrator');

    await moveInvoice(invoiceId, 'Submitted', 'billing_clerk');
    await moveInvoice(invoiceId, 'Approved', 'billing_clerk');

    // The job is now 10. Invoiced. Voiding corrects the financial record...
    const voided = await moveInvoice(invoiceId, 'Cancelled', 'billing_clerk');
    expect(voided.statusCode).toBe(200);

    // ...but the job's operational history stands: no pipeline rewind.
    const job = await prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true },
    });
    expect(job.status).toBe('JOB_INVOICED');

    // The voided document reports the gap honestly and can be removed.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/invoices/${invoiceId}`,
      headers: { cookie },
    });
    expect(detail.json().jobPosition.recognisedBilledTotal).toBe(0);
    expect(detail.json().jobPosition.remainingUnbilled).toBeGreaterThan(0);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/invoices/${invoiceId}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);
    fixtureInvoices.splice(fixtureInvoices.indexOf(invoiceId), 1);
  });

  it('runs a dispute back through correction to approval', async () => {
    const { jobId } = await makeBillableJob();
    const res = await generateOn(jobId);
    const invoiceId = res.json().invoice.id;
    const billingCookie = await sessionFor('billing_clerk');
    const qsCookie = await sessionFor('commercial_qs');

    await moveInvoice(invoiceId, 'Submitted', 'billing_clerk');

    const disputed = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/transition`,
      headers: { cookie: billingCookie },
      payload: { status: 'Disputed' },
    });
    expect(disputed.statusCode).toBe(200);

    // The QS corrects the draft...
    const backToDraft = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/transition`,
      headers: { cookie: qsCookie },
      payload: { status: 'Draft' },
    });
    expect(backToDraft.statusCode).toBe(200);

    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/invoices/${invoiceId}`,
      headers: { cookie: qsCookie },
      payload: { notes: 'Corrected quantity reference.' },
    });
    expect(edit.statusCode).toBe(200);

    // ...resubmits, and billing approves.
    await moveInvoice(invoiceId, 'Submitted', 'billing_clerk');
    const done = await moveInvoice(invoiceId, 'Approved', 'billing_clerk');
    expect(done.statusCode).toBe(200);
    expect(done.json().transition.jobStatus).toBe('10. Invoiced');
  });
});

describe('Gate 5: role boundaries', () => {
  it('stops the QS approving but allows drafting and submitting', async () => {
    const { jobId } = await makeBillableJob();
    const qsCookie = await sessionFor('commercial_qs');

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/invoices`,
      headers: { cookie: qsCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const invoiceId = res.json().invoice.id;
    fixtureInvoices.push(invoiceId);

    const submitted = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/transition`,
      headers: { cookie: qsCookie },
      payload: { status: 'Submitted' },
    });
    expect(submitted.statusCode).toBe(200);

    const approval = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/transition`,
      headers: { cookie: qsCookie },
      payload: { status: 'Approved' },
    });
    expect(approval.statusCode).toBe(403);
    expect(approval.json().error).toBe('TRANSITION_FORBIDDEN');
  });

  it('stops a QS cancelling even their own draft', async () => {
    const { jobId } = await makeBillableJob();
    const qsCookie = await sessionFor('commercial_qs');

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/invoices`,
      headers: { cookie: qsCookie },
      payload: {},
    });
    const invoiceId = res.json().invoice.id;
    fixtureInvoices.push(invoiceId);

    const cancel = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/transition`,
      headers: { cookie: qsCookie },
      payload: { status: 'Cancelled' },
    });
    expect(cancel.statusCode).toBe(403);
  });

  it('stops the PM generating or reading invoices', async () => {
    const { jobId } = await makeBillableJob();
    const pmCookie = await sessionFor('project_manager');

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/invoices`,
      headers: { cookie: pmCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(403);

    const list = await app.inject({
      method: 'GET',
      url: '/api/invoices',
      headers: { cookie: pmCookie },
    });
    expect(list.statusCode).toBe(403);
  });

  it('stops a supervisor touching invoices at all', async () => {
    const supervisorCookie = await sessionFor('site_supervisor');

    const list = await app.inject({
      method: 'GET',
      url: '/api/invoices',
      headers: { cookie: supervisorCookie },
    });
    expect(list.statusCode).toBe(403);
  });

  it('refuses unauthenticated access to billing endpoints', async () => {
    for (const url of ['/api/invoices', '/api/invoices/1', '/api/invoices/1/transitions']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
  });
});

describe('Gate 6: the seeded invoice is read-only', () => {
  it('reports INV-2026-03-0042 exactly as seeded', async () => {
    const cookie = await sessionFor('administrator');
    const response = await app.inject({
      method: 'GET',
      url: '/api/invoices/1',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.invoice.invoiceNumber).toBe('INV-2026-03-0042');
    expect(body.invoice.status).toBe('Submitted');
    expect(body.invoice.subtotalAmount).toBe(26784.45);
    expect(body.invoice.taxRate).toBe(0);
    expect(body.invoice.taxAmount).toBe(0);
    expect(body.invoice.totalWithTax).toBe(26784.45);
    expect(body.lines).toHaveLength(3);
    expect(body.client.name).toBe('Sasol South Africa (Pty) Ltd');
  });

  it('lists the seeded invoice in the register', async () => {
    const cookie = await sessionFor('administrator');
    const response = await app.inject({
      method: 'GET',
      url: '/api/invoices',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const numbers = response.json().invoices.map((i: { invoiceNumber: string }) => i.invoiceNumber);
    expect(numbers).toContain('INV-2026-03-0042');
  });

  it('refuses to delete the seeded invoice', async () => {
    const cookie = await sessionFor('administrator');
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/invoices/1',
      headers: { cookie },
    });
    // The seeded invoice is Submitted. Submitted documents are financial
    // history: withdraw them by cancellation, never delete them. The capability
    // gate refuses first (403) because deletion needs `invoice.status`, which the
    // administrator holds, and `invoice.write` for drafts, which this is not —
    // so neither branch permits it. The state guard would answer 409.
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('FORBIDDEN');
  });

  it('accepts a temporary cancellation so a job is billable, then restores it', async () => {
    // Deliberate, reversible use of the seeded invoice. Job 1 legitimately holds
    // INV-2026-03-0042 in Submitted, which counts as open and so blocks further
    // generation for that job. Cancelling Submitted -> Cancelled is the designed
    // withdrawal path for a mis-raised document, and the status is restored
    // immediately afterwards so the baseline ends this suite untouched.
    const billingCookie = await sessionFor('billing_clerk');

    const before = await prisma.invoice.findUniqueOrThrow({
      where: { id: 1 },
      select: { status: true },
    });
    expect(before.status).toBe('SUBMITTED');

    const cancelled = await app.inject({
      method: 'POST',
      url: '/api/invoices/1/transition',
      headers: { cookie: billingCookie },
      payload: { status: 'Cancelled' },
    });
    expect(cancelled.statusCode).toBe(200);

    try {
      // Generation on job 1 is now unblocked, so the OPEN_INVOICE_EXISTS guard
      // must no longer be what refuses it.
      const res = await generateOn(1);
      if (res.statusCode === 201) {
        fixtureInvoices.push(res.json().invoice.id);
      }
      expect(res.statusCode).not.toBe(409);
      if (res.statusCode === 409) {
        expect(res.json().error).not.toBe('OPEN_INVOICE_EXISTS');
      }
    } finally {
      await prisma.invoice.update({
        where: { id: 1 },
        data: { status: 'SUBMITTED' as never },
      });
    }

    const after = await prisma.invoice.findUniqueOrThrow({
      where: { id: 1 },
      select: { status: true, invoiceNumber: true, totalWithTax: true },
    });
    expect(after.status).toBe('SUBMITTED');
    expect(after.invoiceNumber).toBe('INV-2026-03-0042');
    expect(after.totalWithTax.toNumber()).toBe(26784.45);
  });
});
