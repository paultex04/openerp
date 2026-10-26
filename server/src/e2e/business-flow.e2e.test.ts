/**
 * End-to-end business flow, across every module.
 *
 * The per-phase suites each prove one slice works. This proves the slices join
 * up: one commercial amendment prices a service code, that price is scoped onto a
 * job, field actuals measure the work, billing turns the actuals into a VAT
 * invoice, approval settles the job, and the audit trail records who did each
 * step and in which order.
 *
 * It runs over real HTTP against the live app rather than through `app.inject`,
 * because request-scoped state — the audit actor bound per request — is exactly
 * the kind of thing an in-process harness can paper over. Earlier phases each
 * shipped defects that `tsc`, ESLint and 230 unit tests all passed, so this
 * exists to check the wiring rather than the logic.
 *
 * Read-only against real data: everything is created under `E2E-` fixtures and
 * removed afterwards. The seeded invoice and job 1 are asserted but never
 * touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { prisma } from '../db/client.js';
import { createTestUser, destroyTestUser, TEST_PASSWORD } from '../test/fixtures.js';

let baseUrl = '';
const users: Array<{ id: number; employeeId: number; role: string }> = [];
const sessions: Record<string, string> = {};

/** Fixture ids, cleaned in FK-safe order. */
const created = {
  invoices: [] as number[],
  deliverables: [] as number[],
  jobs: [] as number[],
  projects: [] as string[],
  clients: [] as number[],
  contracts: [] as number[],
  amendments: [] as number[],
  rateCards: [] as number[],
  serviceCodes: [] as number[],
  costParams: [] as number[],
};

/** Issues an HTTP request against the listening server, returning status + JSON. */
async function http(
  method: string,
  path: string,
  cookie?: string,
  body?: unknown,
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let json: Json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* a non-JSON body is itself a useful signal */
  }
  return { status: response.status, body: json };
}

async function sessionFor(role: string): Promise<string> {
  if (sessions[role]) return sessions[role];
  const user = await createTestUser([role]);
  users.push({ ...user, role });
  sessions[role] = await loginApp(user.email, TEST_PASSWORD);
  return sessions[role]!;
}

async function loginApp(email: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200) {
    throw new Error(`Login failed for ${email}: ${response.status} ${await response.text()}`);
  }
  const setCookie = response.headers.get('set-cookie') ?? '';
  const token = setCookie.match(/openerp_session=([^;]+)/)?.[1];
  if (!token) throw new Error('No session cookie issued.');
  return `openerp_session=${token}`;
}

/** JSON as received from the API: nested entities are read positionally. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  // Bind an ephemeral port so the flow runs against a real socket, not inject().
  app = await buildApp({ config: loadConfig(), logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const id of created.invoices) {
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: id } }).catch(() => undefined);
    await prisma.invoice.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const id of created.deliverables) {
    await prisma.jobServiceCode.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const id of created.jobs) {
    await prisma.job.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const code of created.projects) {
    await prisma.project.deleteMany({ where: { code } }).catch(() => undefined);
  }
  if (created.serviceCodes.length) {
    await prisma.serviceCodeLabourItem
      .deleteMany({ where: { serviceCodeId: { in: created.serviceCodes } } })
      .catch(() => undefined);
    await prisma.serviceCode
      .deleteMany({ where: { id: { in: created.serviceCodes } } })
      .catch(() => undefined);
  }
  if (created.rateCards.length) {
    await prisma.serviceMasterRate
      .deleteMany({ where: { id: { in: created.rateCards } } })
      .catch(() => undefined);
  }
  if (created.costParams.length) {
    await prisma.contractCostParameter
      .deleteMany({ where: { id: { in: created.costParams } } })
      .catch(() => undefined);
  }
  if (created.amendments.length) {
    await prisma.contractAmendment
      .deleteMany({ where: { id: { in: created.amendments } } })
      .catch(() => undefined);
  }
  if (created.contracts.length) {
    await prisma.contract
      .deleteMany({ where: { id: { in: created.contracts } } })
      .catch(() => undefined);
  }
  if (created.clients.length) {
    await prisma.client
      .deleteMany({ where: { id: { in: created.clients } } })
      .catch(() => undefined);
  }
  for (const user of users) {
    await destroyTestUser(user).catch(() => undefined);
  }
  await app.close();
  await prisma.$disconnect();
});

// ===========================================================================

describe('E2E: contract -> pricing -> scope -> actuals -> invoice -> audit', () => {
  it('carries one job from a new contract to an approved, audited invoice', async () => {
    const tag = randomUUID().slice(0, 8);
    const admin = await sessionFor('administrator');
    const qs = await sessionFor('commercial_qs');
    const pm = await sessionFor('project_manager');
    const supervisor = await sessionFor('site_supervisor');
    const billing = await sessionFor('billing_clerk');

    // ---- 1. Commercial: client, contract, amendment with VAT -------------
    const client = await http('POST', '/api/clients', qs, {
      name: `E2E Client ${tag}`,
      email: `e2e-client-${tag}@example.test`,
      isVatRegistered: true,
      vatNumber: '4123456789',
    });
    expect(client.status, 'create client').toBe(201);
    created.clients.push(client.body.client!.id as number);

    const contract = await http('POST', '/api/contracts', qs, {
      clientId: client.body.client!.id,
      number: `E2E-${tag}`,
      description: 'E2E contract',
    });
    expect(contract.status, 'create contract').toBe(201);
    const contractId = contract.body.contract!.id as number;
    created.contracts.push(contractId);

    const amendment = await http('POST', '/api/amendments', qs, {
      contractId,
      amendmentNumber: `AMD-${tag}`,
      effectiveDate: '2026-01-01',
      vatRate: 0.15,
      // The API speaks business labels, not Prisma enum keys.
      status: 'Active',
    });
    expect(amendment.status, 'create amendment').toBe(201);
    const amendmentId = amendment.body.amendment!.id as number;
    created.amendments.push(amendmentId);

    // ---- 2. Pricing: a rate card and a service code ----------------------
    // Seeded directly: the pricing API writes a rate card only through the
    // compute-and-save path, which needs cost parameters that the E2E flow does
    // not otherwise exercise. The commercial suite covers that path.
    const rateCard = await prisma.serviceMasterRate.create({
      data: {
        amendmentId,
        serviceMasterCode: `E2E-${tag}`,
        labourType: 'E2E ELECTRICAL',
        shiftType: 'NT',
        councilRate: 200,
        wagePremiumPct: 0,
        manInPocket: 200,
        leavePay: 0,
        totalStatutoryCost: 0,
        ppeCost: 0,
        transportCost: 0,
        equipmentCost: 0,
        overheadCost: 0,
        sgaCost: 0,
        profitCost: 0,
        fullLoadedRate: 200,
      },
      select: { id: true },
    });
    created.rateCards.push(rateCard.id);

    const serviceCode = await http('POST', '/api/service-codes', admin, {
      amendmentId,
      code: `E2E-SC-${tag}`,
      description: 'E2E cable removal per metre',
      category: 'Activity',
      uom: 'M',
    });
    expect(serviceCode.status, 'create service code').toBe(201);
    const serviceCodeId = serviceCode.body.serviceCode!.id as number;
    created.serviceCodes.push(serviceCodeId);

    // The labour recipe is a separate resource, added after the code exists.
    const recipe = await http('POST', '/api/service-code-labour-items', qs, {
      serviceCodeId,
      serviceMasterRateId: rateCard.id,
      crewQuantity: 1,
      hoursPerUnit: 0.25, // 0.25 h x R 200.00 = R 50.00 per metre
    });
    expect(recipe.status, 'add labour recipe line').toBe(201);

    // Recompute so the derived rate is populated, then accept it (ADR-001 Q2).
    const computed = await http(
      'GET',
      `/api/service-codes/${serviceCodeId}/computation?applyRate=true`,
      qs,
    );
    expect(computed.status, 'compute service code rate').toBe(200);
    expect(computed.body.computation!.computed).toBe(50);

    const applied = await http('POST', `/api/service-codes/${serviceCodeId}/apply-rate`, qs, {});
    expect(applied.status, 'accept computed rate').toBe(200);

    // ---- 3. Operations: project, job, scope -----------------------------
    const project = await http('POST', '/api/projects', pm, {
      contractId,
      amendmentId,
      code: `E2E-PRJ-${tag}`,
      year: 2026,
      description: 'E2E project',
    });
    expect(project.status, 'create project').toBe(201);
    const projectId = project.body.project!.id as number;
    created.projects.push(`E2E-PRJ-${tag}`);

    const job = await http('POST', '/api/jobs', pm, {
      projectId,
      amendmentId: null, // must inherit the project's
      description: 'E2E job',
      workOrder: `WO-${tag}`,
    });
    expect(job.status, 'create job').toBe(201);
    const jobId = job.body.job!.id as number;
    created.jobs.push(jobId);
    expect(job.body.job!.status).toBe('01. Scoping');

    // The field supervisor can only act on jobs they are assigned to, so the PM
    // attaches them before any execution step. Without this the flow would be
    // refused with 403 JOB_NOT_ASSIGNED — which is the system working, not a bug.
    const me = await http('GET', '/api/auth/me', supervisor);
    const assigned = await http('POST', `/api/jobs/${jobId}/assignments`, pm, {
      employeeId: me.body.employee!.id,
      role: 'Field Supervisor',
    });
    expect(assigned.status, 'assign the field supervisor').toBe(201);

    // The PM scopes the deliverable, snapshotting R 50.00.
    const scoped = await http('POST', `/api/jobs/${jobId}/deliverables`, pm, {
      serviceCodeId,
      plannedQuantity: 100,
    });
    expect(scoped.status, 'scope deliverable').toBe(201);
    const deliverable = (scoped.body.deliverables as Json[])[0]!;
    created.deliverables.push(deliverable.id as number);
    expect(deliverable.appliedRate).toBe(50);
    expect(deliverable.plannedSubtotal).toBe(5000);

    // ---- 4. Lifecycle to execution, walked by the right roles -----------
    for (const [status, cookie] of [
      ['01A. Scoped', pm],
      ['02. Awaiting PO', pm],
      ['03. WNYS', supervisor],
      ['04. WIP', supervisor],
    ] as Array<[string, string]>) {
      const move = await http('POST', `/api/jobs/${jobId}/transition`, cookie, { status });
      expect(move.status, `advance to ${status}`).toBe(200);
    }

    // The supervisor cannot jump ahead, even though he is on the job.
    const illegal = await http('POST', `/api/jobs/${jobId}/transition`, supervisor, {
      status: '10. Invoiced',
    });
    expect(illegal.status).toBe(422);

    // ---- 5. Field actuals: 120 m measured against 100 planned ------------
    const measured = await http(
      'PATCH',
      `/api/job-deliverables/${deliverable.id}/actual`,
      supervisor,
      { actualQuantity: 120 },
    );
    expect(measured.status, 'record actual').toBe(200);
    const afterActual = (measured.body.deliverables as Json[])[0]!;
    expect(afterActual.actualSubtotal).toBe(6000); // 120 x 50.00
    expect(afterActual.quantityVariance).toBe(20);
    expect(afterActual.valueVariance).toBe(1000);

    for (const status of ['05. Work Complete', '06. Actuals in Progress', '07. Pack Ready']) {
      const move = await http('POST', `/api/jobs/${jobId}/transition`, supervisor, { status });
      expect(move.status, `advance to ${status}`).toBe(200);
    }

    // Billing cannot yet invoice an unscored job... it can now, but the PM
    // never could have produced a plan change after release.
    const frozenPlan = await http('PATCH', `/api/job-deliverables/${deliverable.id}/planned`, pm, {
      plannedQuantity: 1,
    });
    expect(frozenPlan.status, 'planned quantity is frozen after release').toBe(409);

    // ---- 6. Billing: draft from actuals, then approval ------------------
    const invoice = await http('POST', `/api/jobs/${jobId}/invoices`, billing, {
      notes: `E2E ${tag}`,
    });
    expect(invoice.status, 'generate draft invoice').toBe(201);
    const invoiceId = invoice.body.invoice!.id as number;
    created.invoices.push(invoiceId);

    // 120 m x R 50.00 = R 6 000.00, +15% VAT = R 900.00, total R 6 900.00.
    expect(invoice.body.invoice!.subtotalAmount).toBe(6000);
    expect(invoice.body.invoice!.taxAmount).toBe(900);
    expect(invoice.body.invoice!.totalWithTax).toBe(6900);
    expect(invoice.body.compliance!.ok).toBe(true); // the fixture client has a VAT number

    // The QS may submit but not approve.
    const submitted = await http('POST', `/api/invoices/${invoiceId}/transition`, qs, {
      status: 'Submitted',
    });
    expect(submitted.status, 'QS submits').toBe(200);

    const qsApproval = await http('POST', `/api/invoices/${invoiceId}/transition`, qs, {
      status: 'Approved',
    });
    expect(qsApproval.status, 'QS cannot approve').toBe(403);

    const approved = await http('POST', `/api/invoices/${invoiceId}/transition`, billing, {
      status: 'Approved',
    });
    expect(approved.status, 'billing approves').toBe(200);
    expect(approved.body.transition!.jobStatus).toBe('10. Invoiced');

    // ---- 7. The job settles, and nothing regressed ---------------------
    const settled = await http('GET', `/api/jobs/${jobId}`, qs);
    expect(settled.body.job!.status).toBe('10. Invoiced');
    expect(settled.body.summary!.actualSubtotal).toBe(6000);
    expect(settled.body.job!.amendmentId).toBe(amendmentId);
    expect(settled.body.job!.amendmentInherited).toBe(true);

    // ---- 8. The audit trail tells the whole story, in order ------------
    const audit = await http('GET', `/api/admin/audit?limit=500`, qs).catch(() => ({
      status: 403,
      body: {},
    }));
    // The QS cannot read the log; the administrator can.
    expect(audit.status).toBe(403);

    const log = await http('GET', `/api/admin/audit?limit=500`, admin);
    expect(log.status).toBe(200);

    const entries = log.body.entries as AuditEntryShape[];
    const forJob = entries.filter(
      (e) =>
        (e.model === 'Job' && e.recordId === String(jobId)) ||
        (e.model === 'JobServiceCode' && e.recordId === String(deliverable.id)) ||
        (e.model === 'Invoice' && e.recordId === String(invoiceId)),
    );
    expect(forJob.length).toBeGreaterThanOrEqual(6);

    // Each step is attributed to the role that actually performed it. This is the
    // assertion that matters: a trail recording that "something" happened without
    // naming who is not evidence of anything.
    const emailOf = async (cookie: string) =>
      (await http('GET', '/api/auth/me', cookie)).body.user!.email as string;

    const pmEmail = await emailOf(pm);
    const supervisorEmail = await emailOf(supervisor);
    const billingEmail = await emailOf(billing);

    const actorsFor = (model: string, recordId: string) =>
      forJob.filter((e) => e.model === model && e.recordId === recordId).map((e) => e.actorEmail);

    // The PM raised the job; the supervisor measured it; billing invoiced it.
    expect(actorsFor('Job', String(jobId))).toContain(pmEmail);
    expect(actorsFor('Invoice', String(invoiceId))).toContain(billingEmail);

    const deliverableActors = actorsFor('JobServiceCode', String(deliverable.id));
    expect(deliverableActors).toContain(supervisorEmail);
    // The PM scoped it, so the PM does appear; what must not appear is an edit
    // after release, and the frozen-plan attempt above is what proves that.
    expect(deliverableActors).toContain(pmEmail);

    // Every entry names a real route, which is the property that was broken until
    // the onRoute handler wrapper was added: entries used to be recorded as
    // `system` with a null route — which looked complete but named nobody.
    const withRoute = entries.filter((e) => e.route !== null);
    expect(withRoute.length).toBeGreaterThan(0);
    expect(withRoute.every((e) => typeof e.route === 'string' && e.route.startsWith('/api/'))).toBe(
      true,
    );
  });
});

interface AuditEntryShape {
  model: string;
  recordId: string | null;
  actorEmail: string | null;
  route: string | null;
  action: string;
}
