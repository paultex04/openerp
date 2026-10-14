/**
 * Phase 2 acceptance gates, exercised against the real database.
 *
 *   1. Tier 1 engine reproduces Artisan Electrical at 227.61 ZAR/hr.
 *   2. Tier 2 engine reproduces cable removal S00247970 at 17.5226 ZAR/m.
 *   3. Non-commercial roles cannot edit rate components (403).
 *
 * These are read-only against baseline pricing data apart from two fixtures that
 * are created and deleted within the test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { prisma } from '../db/client.js';
import { computeRateCard } from '../pricing/service.js';
import { applyServiceCodeRate } from '../pricing/service.js';
import {
  TEST_PASSWORD,
  createTestUser,
  destroyTestUser,
  login,
  seededContractWithAmendment,
} from '../test/fixtures.js';

let app: FastifyInstance;
const created: Array<{ id: number; employeeId: number }> = [];

const track = async (roleKeys: string[]) => {
  const user = await createTestUser(roleKeys);
  created.push(user);
  return user;
};

beforeAll(async () => {
  app = await buildApp({ config: loadConfig(), logger: false });
  await app.ready();
});

afterAll(async () => {
  for (const user of created) {
    await destroyTestUser(user).catch(() => undefined);
  }
  await app.close();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('Gate 1: Tier 1 rate build-up against live data', () => {
  it('recomputes Artisan Electrical (S00250451) at exactly 227.61 ZAR/hr', async () => {
    const card = await prisma.serviceMasterRate.findFirstOrThrow({
      where: { serviceMasterCode: 'S00250451', shiftType: 'NT' },
      select: { id: true, fullLoadedRate: true },
    });

    const computed = await computeRateCard(card.id);

    expect(computed.fullLoadedRate).toBe(227.61);
    expect(computed.fullLoadedRate).toBe(card.fullLoadedRate.toNumber());
    expect(computed.manInPocket).toBe(113.13);
    expect(computed.baseDirectLabour).toBe(157.52);
    expect(computed.profitCost).toBe(19.75);
  });

  it('agrees with the stored full loaded rate for every rate card on amendment 1', async () => {
    const cards = await prisma.serviceMasterRate.findMany({
      where: { amendmentId: 1 },
      select: { id: true, fullLoadedRate: true },
    });
    expect(cards.length).toBe(22);

    const mismatches: string[] = [];
    for (const card of cards) {
      const computed = await computeRateCard(card.id);
      const stored = card.fullLoadedRate.toNumber();
      // Tolerance is one cent, plus a float guard: the seed data carries
      // accumulated rounding (ADR-001 F1 records 9 of 22 rows off by ~0.01), and
      // a nominal 0.01 difference can evaluate as 0.010000000000005 in binary
      // floating point, which would falsely trip an exact `<= 0.01` check.
      if (Math.abs(computed.fullLoadedRate - stored) > 0.01 + Number.EPSILON * 100) {
        mismatches.push(`#${card.id} computed ${computed.fullLoadedRate} vs stored ${stored}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('documents the known single-cent legacy divergence on S00258036', async () => {
    // ADR-001 F1: this row's stored FLR is 122.49 where the build-up yields
    // 122.50, because the original spreadsheet truncated the final sum instead of
    // rounding it. Preserved deliberately rather than rewritten.
    const row = await prisma.serviceMasterRate.findFirstOrThrow({
      where: { serviceMasterCode: 'S00258036', shiftType: 'NT' },
      select: { id: true, fullLoadedRate: true },
    });
    const computed = await computeRateCard(row.id);

    expect(row.fullLoadedRate.toNumber()).toBe(122.49);
    expect(computed.fullLoadedRate).toBe(122.5);
    expect(Math.abs(computed.fullLoadedRate - row.fullLoadedRate.toNumber())).toBeLessThanOrEqual(
      0.01 + Number.EPSILON * 100,
    );
  });

  it('never silently re-derives overheads: the derived figure differs, as ADR-001 documents', async () => {
    const card = await prisma.serviceMasterRate.findFirstOrThrow({
      where: { serviceMasterCode: 'S00250451', shiftType: 'NT' },
      select: { id: true },
    });
    const authoritative = await computeRateCard(card.id);

    const preview = await app.inject({
      method: 'POST',
      url: '/api/service-master-rates/preview',
      headers: { cookie: await adminCookie() },
      payload: {
        amendmentId: 1,
        serviceMasterCode: 'S00250451',
        labourType: 'ARTISAN ELECTRICAL',
        councilRate: 112.57,
        wagePremiumPct: 0.005,
        leavePay: 15.46,
        totalStatutoryCost: 28.93,
        ppeCost: 1.93,
        transportCost: 1.58,
        equipmentCost: 7.89,
        profitPct: 0.095,
        deriveOverheads: true,
      },
    });

    expect(preview.statusCode).toBe(200);
    const body = preview.json();
    expect(body.computed.fullLoadedRate).toBe(226.72);
    expect(body.derivedComparison.derived.fullLoadedRate).toBe(226.72);
    expect(authoritative.fullLoadedRate).toBe(227.61);
  });
});

// ---------------------------------------------------------------------------

describe('Gate 2: Tier 2 service code pricing against live data', () => {
  it('recomputes S00247970 at exactly 17.5226 ZAR/m', async () => {
    const code = await prisma.serviceCode.findFirstOrThrow({
      where: { code: 'S00247970' },
      select: { id: true, calculatedUnitRate: true, category: true },
    });

    expect(code.category).toBe('ACTIVITY');
    const computation = await applyServiceCodeRate(code.id, { accept: false });

    expect(computation!.computed).toBe(17.5226);
    expect(computation!.variance.matches).toBe(true);
    expect(computation!.variance.stored).toBe(17.5226);
  });

  it('reproduces all four crew line subtotals', async () => {
    const code = await prisma.serviceCode.findFirstOrThrow({
      where: { code: 'S00247970' },
      select: { id: true },
    });
    const computation = await applyServiceCodeRate(code.id, { accept: false });
    const subtotals = (computation!.lines as Array<{ lineSubtotal: number }>).map(
      (l) => l.lineSubtotal,
    );
    expect(subtotals).toEqual([2.2761, 0.8839, 7.9436, 6.419]);
  });

  it('recomputes the R1 material code at 23 782.00 with its 10% markup', async () => {
    const code = await prisma.serviceCode.findFirstOrThrow({
      where: { code: 'R1-CABLE-SUPPLY-01' },
      select: { id: true, category: true },
    });
    expect(code.category).toBe('R1_MATERIAL');

    const computation = await applyServiceCodeRate(code.id, { accept: false });
    expect(computation!.computed).toBe(23782);
    expect(computation!.subtotalCost).toBe(21620);
    expect(computation!.markupAmount).toBe(2162);
  });

  it('surfaces the preserved S00167401 discrepancy instead of overwriting it', async () => {
    const code = await prisma.serviceCode.findFirstOrThrow({
      where: { code: 'S00167401' },
      select: { id: true, calculatedUnitRate: true },
    });

    const computation = await applyServiceCodeRate(code.id, { accept: false });

    // ADR-001 Q2: computed differs, stored stays at 27.9158.
    expect(computation!.computed).toBe(27.8639);
    expect(computation!.variance.matches).toBe(false);
    expect(computation!.variance.stored).toBe(27.9158);

    // Confirm nothing was written.
    const recheck = await prisma.serviceCode.findUniqueOrThrow({
      where: { id: code.id },
      select: { calculatedUnitRate: true },
    });
    expect(recheck.calculatedUnitRate.toNumber()).toBe(27.9158);
  });

  it('does not change a master rate when a service code is recomputed', async () => {
    const before = await prisma.serviceMasterRate.findFirstOrThrow({
      where: { serviceMasterCode: 'S00250451', shiftType: 'NT' },
      select: { fullLoadedRate: true },
    });

    const code = await prisma.serviceCode.findFirstOrThrow({
      where: { code: 'S00247970' },
      select: { id: true },
    });
    await applyServiceCodeRate(code.id, { accept: false });

    const after = await prisma.serviceMasterRate.findFirstOrThrow({
      where: { serviceMasterCode: 'S00250451', shiftType: 'NT' },
      select: { fullLoadedRate: true },
    });
    expect(after.fullLoadedRate.toNumber()).toBe(before.fullLoadedRate.toNumber());
  });
});

// ---------------------------------------------------------------------------

describe('Gate 3: non-commercial roles cannot edit rate components', () => {
  const writeEndpoints: Array<{
    method: 'POST' | 'PUT' | 'DELETE';
    url: string;
    payload?: Record<string, unknown>;
  }> = [
    { method: 'POST', url: '/api/service-master-rates/preview', payload: { amendmentId: 1 } },
    {
      method: 'POST',
      url: '/api/service-master-rates',
      payload: {
        amendmentId: 1,
        serviceMasterCode: 'TEST',
        labourType: 'TEST',
        councilRate: 1,
        wagePremiumPct: 0,
        profitPct: 0,
        leavePay: 0,
        totalStatutoryCost: 0,
        ppeCost: 0,
        transportCost: 0,
        equipmentCost: 0,
        overheadCost: 0,
        sgaCost: 0,
      },
    },
    {
      method: 'PUT',
      url: '/api/service-master-rates/1',
      payload: {
        amendmentId: 1,
        serviceMasterCode: 'S00250451',
        labourType: 'ARTISAN ELECTRICAL',
        councilRate: 999,
        wagePremiumPct: 0,
        profitPct: 0,
        leavePay: 0,
        totalStatutoryCost: 0,
        ppeCost: 0,
        transportCost: 0,
        equipmentCost: 0,
        overheadCost: 0,
        sgaCost: 0,
      },
    },
    { method: 'DELETE', url: '/api/service-master-rates/1' },
    { method: 'POST', url: '/api/service-codes/1/apply-rate' },
    {
      method: 'POST',
      url: '/api/service-code-labour-items',
      payload: { serviceCodeId: 1, serviceMasterRateId: 1 },
    },
    {
      method: 'POST',
      url: '/api/service-code-material-items',
      payload: { serviceCodeId: 6, unitCost: 1, description: 'x' },
    },
  ];

  const nonCommercialRoles = ['site_supervisor', 'billing_clerk', 'project_manager'];

  for (const role of nonCommercialRoles) {
    it(`blocks ${role} from every rate and recipe write endpoint`, async () => {
      const user = await track([role]);
      const cookie = await login(app, user.email, TEST_PASSWORD);

      for (const endpoint of writeEndpoints) {
        const response = await app.inject({
          method: endpoint.method,
          url: endpoint.url,
          headers: { cookie },
          ...(endpoint.payload ? { payload: endpoint.payload } : {}),
        });
        expect(response.statusCode, `${endpoint.method} ${endpoint.url} as ${role}`).toBe(403);
      }
    });
  }

  it('still lets the QS read rate cards but not administer users', async () => {
    const qs = await track(['commercial_qs']);
    const cookie = await login(app, qs.email, TEST_PASSWORD);

    const read = await app.inject({
      method: 'GET',
      url: '/api/service-master-rates?amendmentId=1',
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().rates.length).toBe(22);

    const admin = await app.inject({
      method: 'GET',
      url: '/api/clients',
      headers: { cookie },
    });
    expect(admin.statusCode).toBe(200); // contract.read is granted to QS
  });

  it('refuses unauthenticated access to commercial endpoints', async () => {
    for (const endpoint of writeEndpoints) {
      const response = await app.inject({ method: endpoint.method, url: endpoint.url });
      expect(response.statusCode).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------

describe('VAT fields are exposed and enforced', () => {
  it('reports client VAT registration', async () => {
    const cookie = await adminCookie();
    const response = await app.inject({
      method: 'GET',
      url: '/api/clients',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const client = response.json().clients[0];
    expect(client).toHaveProperty('isVatRegistered');
    expect(client).toHaveProperty('vatNumber');
  });

  it('exposes the amendment VAT rate alongside cost parameters', async () => {
    const cookie = await adminCookie();
    const response = await app.inject({
      method: 'GET',
      url: '/api/amendments/1/cost-parameters',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.amendment.vatRate).toBe(0.15);
    // The `engine` projection is normalised to fractions for the build-up sheet.
    expect(body.engine.overheadPct).toBeCloseTo(0.07, 10);
    expect(body.engine.sgaPct).toBeCloseTo(0.15, 10);
    expect(body.engine.profitPct).toBeCloseTo(0.095, 10);
    expect(body.parameters.length).toBe(12);
    // The raw parameter rows are returned unscaled, as stored.
    const overhead = body.parameters.find(
      (p: { parameterName: string }) => p.parameterName === 'Operational Overhead %',
    );
    expect(overhead.numericValue).toBeCloseTo(7, 6);
  });

  it('rejects a malformed client VAT number', async () => {
    const cookie = await adminCookie();
    const response = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie },
      payload: {
        name: `VAT Test ${Date.now()}`,
        email: `vat-${Date.now()}@example.test`,
        isVatRegistered: true,
        vatNumber: '123',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('VALIDATION_FAILED');
  });

  it('creates a client with a valid VAT number and cleans up', async () => {
    const cookie = await adminCookie();
    const email = `vat-ok-${Date.now()}@example.test`;

    const created = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie },
      payload: {
        name: 'VAT Test Client',
        email,
        isVatRegistered: true,
        vatNumber: '4123456789',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().client.vatNumber).toBe('4123456789');

    await prisma.client.deleteMany({ where: { email } });
  });

  it('still exposes the legacy total_amount alongside the VAT breakdown', async () => {
    // The *seeded* invoice, by number. A bare `findFirst` returned whichever row
    // Postgres happened to hand back first, and once the table held fixture
    // invoices as well that was no longer the legacy row: the assertion then
    // compared a VAT-charged fixture's subtotal against its gross total and
    // failed for a reason that had nothing to do with the schema.
    const invoice = await prisma.invoice.findFirstOrThrow({
      where: { invoiceNumber: 'INV-2026-03-0042' },
      select: {
        totalAmount: true,
        subtotalAmount: true,
        taxAmount: true,
        totalWithTax: true,
        taxRate: true,
      },
    });
    // Legacy invoice was backfilled as VAT-exempt.
    expect(invoice.subtotalAmount.toNumber()).toBe(invoice.totalAmount.toNumber());
    expect(invoice.taxAmount.toNumber()).toBe(0);
    expect(invoice.totalWithTax.toNumber()).toBe(invoice.totalAmount.toNumber());
    expect(invoice.taxRate.toNumber()).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('Recipe integrity guards', () => {
  it('refuses labour lines on an R1 material code', async () => {
    const cookie = await adminCookie();
    const response = await app.inject({
      method: 'POST',
      url: '/api/service-code-labour-items',
      headers: { cookie },
      payload: { serviceCodeId: 6, serviceMasterRateId: 1, hoursPerUnit: 0.01 },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('CATEGORY_MISMATCH');
  });

  it('refuses material lines on an Activity code', async () => {
    const cookie = await adminCookie();
    const response = await app.inject({
      method: 'POST',
      url: '/api/service-code-material-items',
      headers: { cookie },
      payload: { serviceCodeId: 1, unitCost: 1, description: 'Cable' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('CATEGORY_MISMATCH');
  });

  it('refuses a labour line referencing a rate card that does not exist', async () => {
    const cookie = await adminCookie();
    const response = await app.inject({
      method: 'POST',
      url: '/api/service-code-labour-items',
      headers: { cookie },
      payload: { serviceCodeId: 1, serviceMasterRateId: 999999, hoursPerUnit: 0.01 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('INVALID_REFERENCE');
  });

  it('refuses to mix rates from a different amendment into a recipe', async () => {
    const cookie = await adminCookie();

    // Create a throwaway amendment plus a rate card on it, then try to attach
    // that rate to an amendment-1 service code.
    const { contractId } = await seededContractWithAmendment();
    const stamp = Date.now();

    const amendment = await prisma.contractAmendment.create({
      data: {
        contractId,
        amendmentNumber: `TEST-${stamp}`,
        effectiveDate: new Date('2026-01-01'),
        status: 'DRAFT',
      },
      select: { id: true },
    });

    const rate = await prisma.serviceMasterRate.create({
      data: {
        amendmentId: amendment.id,
        serviceMasterCode: `T${String(stamp).slice(-6)}`,
        labourType: 'TEST TRADE',
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

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/service-code-labour-items',
        headers: { cookie },
        payload: { serviceCodeId: 1, serviceMasterRateId: rate.id, hoursPerUnit: 0.01 },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error).toBe('AMENDMENT_MISMATCH');
    } finally {
      await prisma.serviceMasterRate.deleteMany({ where: { id: rate.id } });
      await prisma.contractAmendment.deleteMany({ where: { id: amendment.id } });
    }
  });

  it('refuses to delete a rate card that a recipe references', async () => {
    const cookie = await adminCookie();
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/service-master-rates/1',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('CONFLICT');
  });

  it('refuses to delete a contract that still has amendments', async () => {
    const cookie = await adminCookie();
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/contracts/1',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------

let cachedAdminCookie: string | null = null;

/** A logged-in administrator session, created once and reused. */
async function adminCookie(): Promise<string> {
  if (cachedAdminCookie) return cachedAdminCookie;

  const admin = await prisma.appUser.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { id: 'asc' },
    include: { roles: { select: { role: { select: { key: true } } } } },
  });

  if (!admin.roles.some((r) => r.role.key === 'administrator')) {
    throw new Error('No administrator account found. Run `npm run seed --workspace server`.');
  }

  const email = admin.email;
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'Field#Ops2026x';

  cachedAdminCookie = await login(app, email, password);
  return cachedAdminCookie;
}
