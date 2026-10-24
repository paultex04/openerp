import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getDashboardAnalytics } from './service.js';
import { prisma } from '../db/client.js';

// Mock prisma
vi.mock('../db/client.js', () => {
  return {
    prisma: {
      jobStatusDefinition: {
        findMany: vi.fn(),
      },
      job: {
        groupBy: vi.fn(),
        count: vi.fn(),
        findMany: vi.fn(),
      },
      timesheet: {
        count: vi.fn(),
      },
      invoice: {
        findMany: vi.fn(),
      },
      contractAmendment: {
        findMany: vi.fn(),
      },
    },
  };
});

describe('getDashboardAnalytics', () => {
  const refDate = new Date('2026-10-15T12:00:00Z');

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(prisma.jobStatusDefinition.findMany).mockResolvedValue([
      { key: '01. Scoping', label: 'Scoping', sortOrder: 1 } as any,
      { key: '03. Execution', label: 'In Execution', sortOrder: 3 } as any,
      { key: '10. Invoiced', label: 'Invoiced', sortOrder: 10 } as any,
    ]);

    vi.mocked(prisma.job.groupBy).mockResolvedValue([
      { status: '01. Scoping', _count: { id: 2 } } as any,
      { status: '03. Execution', _count: { id: 5 } } as any,
      { status: '00. Cancelled', _count: { id: 1 } } as any,
    ]);

    vi.mocked(prisma.job.count).mockResolvedValue(8);
    vi.mocked(prisma.timesheet.count).mockResolvedValue(3);

    // Active jobs mock
    vi.mocked(prisma.job.findMany).mockResolvedValue([
      {
        id: 101,
        status: '03. Execution',
        project: { contractId: 1 },
        serviceCodes: [
          {
            plannedSubtotal: { toNumber: () => 10000 },
            actualSubtotal: { toNumber: () => 12000 },
          },
        ],
        invoices: [
          {
            subtotalAmount: { toNumber: () => 5000 },
          },
        ],
        timesheetEntries: [
          {
            costAmount: { toNumber: () => 3000 },
          },
        ],
      } as any,
    ]);

    // Pending invoices mock
    vi.mocked(prisma.invoice.findMany as any).mockImplementation(async (args: any) => {
      // Pending invoices query
      if (args?.where?.status?.in?.includes('DRAFT')) {
        return [
          { totalWithTax: { toNumber: () => 5750 } },
          { totalWithTax: { toNumber: () => 2300 } },
        ] as any;
      }
      // Recognised invoices query
      return [
        {
          id: 1,
          issueDate: new Date('2026-10-05T00:00:00Z'),
          subtotalAmount: { toNumber: () => 100000 },
          taxAmount: { toNumber: () => 15000 },
          totalWithTax: { toNumber: () => 115000 },
          job: {
            project: {
              contract: {
                id: 1,
                number: 'CTR-2026-001',
                description: 'Plant Substation Refurbishment',
                client: { name: 'Sasol Mining' },
              },
            },
          },
        },
        {
          id: 2,
          issueDate: new Date('2026-05-10T00:00:00Z'),
          subtotalAmount: { toNumber: () => 50000 },
          taxAmount: { toNumber: () => 7500 },
          totalWithTax: { toNumber: () => 57500 },
          job: {
            project: {
              contract: {
                id: 1,
                number: 'CTR-2026-001',
                description: 'Plant Substation Refurbishment',
                client: { name: 'Sasol Mining' },
              },
            },
          },
        },
      ] as any;
    });

    // Contract amendments mock
    vi.mocked(prisma.contractAmendment.findMany).mockResolvedValue([
      {
        id: 1,
        amendmentNumber: 'AMD-001',
        expiryDate: new Date('2026-10-20T00:00:00Z'), // ~5 days remaining
        contract: {
          number: 'CTR-2026-001',
          client: { name: 'Sasol Mining' },
        },
      } as any,
      {
        id: 2,
        amendmentNumber: 'AMD-002',
        expiryDate: new Date('2026-10-01T00:00:00Z'), // lapsed ~14 days ago
        contract: {
          number: 'CTR-2026-002',
          client: { name: 'Eskom Rotek' },
        },
      } as any,
    ]);
  });

  it('aggregates operational metrics and stage funnel accurately', async () => {
    const result = await getDashboardAnalytics({
      includeFinancials: false,
      referenceDate: refDate,
    });

    expect(result.financials).toBeNull();
    expect(result.topContracts).toBeNull();

    expect(result.operations.activeJobsCount).toBe(7); // 8 total - 1 cancelled
    expect(result.operations.cancelledJobsCount).toBe(1);
    expect(result.operations.totalJobsCount).toBe(8);
    expect(result.operations.unapprovedTimesheetsCount).toBe(3);
    expect(result.operations.pendingInvoicesCount).toBe(2);
    expect(result.operations.pendingInvoicesValue).toBe(8050); // 5750 + 2300

    expect(result.operations.costVariance).toEqual({
      planned: 10000,
      actual: 12000,
      difference: 2000,
      jobsCounted: 1,
    });

    // Check expiring amendments classifications
    expect(result.operations.expiringAmendments).toHaveLength(2);
    expect(result.operations.expiringAmendments[0]?.band).toBe('expired');
    expect(result.operations.expiringAmendments[1]?.band).toBe('within 30 days');
  });

  it('calculates executive financials, WIP valuation, gross margins and SARS VAT', async () => {
    const result = await getDashboardAnalytics({
      includeFinancials: true,
      referenceDate: refDate,
    });

    expect(result.financials).not.toBeNull();
    const fin = result.financials!;

    // Revenue
    expect(fin.revenue.mtd).toBe(100000); // Only Oct 2026 invoice
    expect(fin.revenue.ytd).toBe(150000); // Oct (100k) + May (50k)
    expect(fin.revenue.trailing12m).toBe(150000);
    expect(fin.revenue.trailingTrend).toHaveLength(12);

    // WIP Valuation: actualSubtotal (12,000) - billedSubtotal (5,000) = 7,000 unbilled
    expect(fin.wip.totalUnbilled).toBe(7000);
    expect(fin.wip.activeJobsWithWip).toBe(1);
    expect(fin.wip.totalActiveJobs).toBe(1);

    // Margins: Actual Revenue (12,000) - Labour Cost (3,000) = 9,000 (75%)
    expect(fin.margins.totalRevenue).toBe(12000);
    expect(fin.margins.totalCost).toBe(3000);
    expect(fin.margins.totalMargin).toBe(9000);
    expect(fin.margins.overallGrossMarginPct).toBe(75);

    // SARS VAT: Current bi-monthly period (Sep-Oct 2026) -> Oct invoice tax 15,000
    expect(fin.vatLiability.outputVatCollected).toBe(15000);
    expect(fin.vatLiability.trailing12mVat).toBe(22500); // 15,000 + 7,500
    expect(fin.vatLiability.standardRatePct).toBe(15);

    // Top Contracts Leaderboard
    expect(result.topContracts).toHaveLength(1);
    expect(result.topContracts![0]).toMatchObject({
      number: 'CTR-2026-001',
      clientName: 'Sasol Mining',
      totalRevenue: 150000,
      activeJobsCount: 1,
    });
  });
});
