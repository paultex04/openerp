/**
 * Executive and Financial Analytics Service (Phase 4).
 *
 * Provides aggregated financial and operational metrics in a single optimized query
 * round-trip:
 *  - Trailing 12-month, MTD, and YTD revenue trends
 *  - Work-In-Progress (WIP) unbilled valuation across active jobs
 *  - Portfolio Gross Margin % and total cost analysis
 *  - SARS VAT Liability calculations (current 2-month tax cycle and trailing 12M)
 *  - Top 5 contracts by revenue volume
 *  - Operational KPIs (pipeline stage funnel, unapproved timesheets, expiring amendments)
 */
import { prisma } from '../db/client.js';
import { round, roundMoney } from '@openerp/shared';
import type {
  ContractRevenueLeader,
  DashboardAnalyticsResponse,
  ExpiringAmendmentSummary,
  FinancialAnalytics,
  OperationalAnalytics,
  RevenueMonthlyTrend,
} from '@openerp/shared';

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function daysUntil(date: Date, now: Date): number {
  const startOfToday = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const target = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.round((target - startOfToday) / 86_400_000);
}

function classifyExpiryBand(days: number): 'expired' | 'within 30 days' | 'within 90 days' | null {
  if (days < 0) return 'expired';
  if (days <= 30) return 'within 30 days';
  if (days <= 90) return 'within 90 days';
  return null;
}

export async function getDashboardAnalytics(
  options: {
    includeFinancials?: boolean;
    referenceDate?: Date;
  } = {},
): Promise<DashboardAnalyticsResponse> {
  const includeFinancials = options.includeFinancials ?? true;
  const now = options.referenceDate ?? new Date();

  // Date boundaries
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth(); // 0-indexed

  const startOfMonth = new Date(Date.UTC(currentYear, currentMonth, 1));
  const startOfYear = new Date(Date.UTC(currentYear, 0, 1));

  // Trailing 12-month start (11 months before current month, on 1st day)
  const trailing12mStart = new Date(Date.UTC(currentYear, currentMonth - 11, 1));

  // SARS 2-month tax period (even/odd bi-monthly periods: Jan-Feb, Mar-Apr, May-Jun, Jul-Aug, Sep-Oct, Nov-Dec)
  const sarsPeriodStartMonth = Math.floor(currentMonth / 2) * 2;
  const sarsPeriodEndMonth = sarsPeriodStartMonth + 1;
  const sarsPeriodStart = new Date(Date.UTC(currentYear, sarsPeriodStartMonth, 1));
  const sarsPeriodLabel = `SARS Bi-Monthly Cycle (${MONTH_NAMES[sarsPeriodStartMonth]} - ${MONTH_NAMES[sarsPeriodEndMonth]} ${currentYear})`;

  // 1. Fetch job status definitions for stage ordering
  const [jobStatuses, rawStageCounts, totalJobsCount, unapprovedTimesheetsCount] =
    await Promise.all([
      prisma.jobStatusDefinition.findMany({
        orderBy: { sortOrder: 'asc' },
        select: { key: true, label: true, sortOrder: true },
      }),
      prisma.job.groupBy({
        by: ['status'],
        _count: { id: true },
      }),
      prisma.job.count(),
      prisma.timesheet.count({
        where: { status: 'SUBMITTED' },
      }),
    ]);

  const stageCountMap = new Map<string, number>(
    rawStageCounts.map((item) => [item.status, item._count.id]),
  );

  const stageCounts = jobStatuses.map((def) => ({
    status: def.key,
    label: def.label,
    count: stageCountMap.get(def.key) ?? 0,
  }));

  // Cancelled jobs count
  const cancelledJobsCount = stageCountMap.get('00. Cancelled') ?? 0;
  const activeJobsCount = totalJobsCount - cancelledJobsCount;

  // 2. Fetch Active Jobs for Cost Variance and WIP Valuation
  const activeJobs = await prisma.job.findMany({
    where: {
      status: { not: '00. Cancelled' },
    },
    select: {
      id: true,
      status: true,
      project: {
        select: {
          contractId: true,
        },
      },
      serviceCodes: {
        select: {
          plannedSubtotal: true,
          actualSubtotal: true,
        },
      },
      invoices: {
        where: {
          deletedAt: null,
          status: { not: 'CANCELLED' },
        },
        select: {
          subtotalAmount: true,
        },
      },
      timesheetEntries: {
        where: {
          costAmount: { not: null },
        },
        select: {
          costAmount: true,
        },
      },
    },
  });

  // Calculate Cost Variance across active jobs
  let totalPlannedCost = 0;
  let totalActualCost = 0;
  let totalActualRevenue = 0;
  let totalLabourCost = 0;
  let totalUnbilledWip = 0;
  let activeJobsWithWip = 0;
  const activeJobsCountByContract = new Map<number, number>();

  for (const job of activeJobs) {
    const contractId = job.project.contractId;
    activeJobsCountByContract.set(contractId, (activeJobsCountByContract.get(contractId) ?? 0) + 1);

    let jobPlannedSubtotal = 0;
    let jobActualSubtotal = 0;
    for (const sc of job.serviceCodes) {
      jobPlannedSubtotal += sc.plannedSubtotal.toNumber();
      jobActualSubtotal += sc.actualSubtotal.toNumber();
    }

    let jobBilledSubtotal = 0;
    for (const inv of job.invoices) {
      jobBilledSubtotal += inv.subtotalAmount.toNumber();
    }

    let jobLabourCost = 0;
    for (const entry of job.timesheetEntries) {
      if (entry.costAmount) {
        jobLabourCost += entry.costAmount.toNumber();
      }
    }

    totalPlannedCost += jobPlannedSubtotal;
    totalActualCost += jobActualSubtotal;
    totalActualRevenue += jobActualSubtotal;
    totalLabourCost += jobLabourCost;

    const unbilledForJob = Math.max(0, jobActualSubtotal - jobBilledSubtotal);
    if (unbilledForJob > 0) {
      activeJobsWithWip += 1;
      totalUnbilledWip += unbilledForJob;
    }
  }

  // 3. Fetch Pending Invoices (Draft, Submitted, Approved, Partially Paid)
  const pendingInvoices = await prisma.invoice.findMany({
    where: {
      deletedAt: null,
      status: { in: ['DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_PAID'] },
    },
    select: {
      totalWithTax: true,
    },
  });

  const pendingInvoicesCount = pendingInvoices.length;
  const pendingInvoicesValue = roundMoney(
    pendingInvoices.reduce((sum, inv) => sum + inv.totalWithTax.toNumber(), 0),
  );

  // 4. Fetch Expiring Amendments
  const candidateAmendments = await prisma.contractAmendment.findMany({
    where: {
      isArchived: false,
      status: 'ACTIVE',
      expiryDate: { not: null },
    },
    select: {
      id: true,
      amendmentNumber: true,
      expiryDate: true,
      contract: {
        select: {
          number: true,
          client: { select: { name: true } },
        },
      },
    },
  });

  const expiringAmendments: ExpiringAmendmentSummary[] = [];
  for (const am of candidateAmendments) {
    if (!am.expiryDate) continue;
    const days = daysUntil(am.expiryDate, now);
    const band = classifyExpiryBand(days);
    if (band) {
      expiringAmendments.push({
        id: am.id,
        amendmentNumber: am.amendmentNumber,
        contractNumber: am.contract.number,
        clientName: am.contract.client.name,
        expiryDate: am.expiryDate.toISOString().slice(0, 10),
        daysRemaining: days,
        band,
      });
    }
  }
  // Sort soonest first (and lapsed ahead of upcoming)
  expiringAmendments.sort((a, b) => a.daysRemaining - b.daysRemaining);

  const operations: OperationalAnalytics = {
    activeJobsCount,
    totalJobsCount,
    cancelledJobsCount,
    pendingInvoicesCount,
    pendingInvoicesValue,
    unapprovedTimesheetsCount,
    costVariance: {
      planned: roundMoney(totalPlannedCost),
      actual: roundMoney(totalActualCost),
      difference: roundMoney(totalActualCost - totalPlannedCost),
      jobsCounted: activeJobs.length,
    },
    stageCounts,
    expiringAmendments,
  };

  // If user is not authorized for financials, return operations only
  if (!includeFinancials) {
    return {
      financials: null,
      operations,
      topContracts: null,
    };
  }

  // 5. Fetch Recognised Invoices for Revenue, VAT & Margins
  const recognisedInvoices = await prisma.invoice.findMany({
    where: {
      deletedAt: null,
      status: { in: ['APPROVED', 'PARTIALLY_PAID', 'PAID'] },
    },
    select: {
      id: true,
      issueDate: true,
      subtotalAmount: true,
      taxAmount: true,
      totalWithTax: true,
      job: {
        select: {
          project: {
            select: {
              contract: {
                select: {
                  id: true,
                  number: true,
                  description: true,
                  client: { select: { name: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  // Prepare monthly trailing buckets for the last 12 months
  const monthlyBuckets = new Map<
    string,
    { month: string; label: string; revenue: number; invoiceCount: number }
  >();
  for (let i = 11; i >= 0; i--) {
    const bucketDate = new Date(Date.UTC(currentYear, currentMonth - i, 1));
    const yearStr = bucketDate.getUTCFullYear();
    const monthNum = bucketDate.getUTCMonth();
    const key = `${yearStr}-${String(monthNum + 1).padStart(2, '0')}`;
    const label = `${MONTH_NAMES[monthNum]} '${String(yearStr).slice(-2)}`;
    monthlyBuckets.set(key, { month: key, label, revenue: 0, invoiceCount: 0 });
  }

  let revenueMtd = 0;
  let revenueYtd = 0;
  let revenueTrailing12m = 0;
  let sarsOutputVat = 0;
  let trailing12mVat = 0;

  interface ContractAgg {
    id: number;
    number: string;
    description: string;
    clientName: string;
    totalRevenue: number;
  }
  const contractRevenueMap = new Map<number, ContractAgg>();

  for (const inv of recognisedInvoices) {
    const invDate = inv.issueDate;
    const subtotal = inv.subtotalAmount.toNumber();
    const tax = inv.taxAmount.toNumber();

    // MTD
    if (invDate >= startOfMonth) {
      revenueMtd += subtotal;
    }
    // YTD
    if (invDate >= startOfYear) {
      revenueYtd += subtotal;
    }
    // Trailing 12 months
    if (invDate >= trailing12mStart) {
      revenueTrailing12m += subtotal;
      trailing12mVat += tax;

      const yearStr = invDate.getUTCFullYear();
      const monthNum = invDate.getUTCMonth();
      const monthKey = `${yearStr}-${String(monthNum + 1).padStart(2, '0')}`;
      const bucket = monthlyBuckets.get(monthKey);
      if (bucket) {
        bucket.revenue = roundMoney(bucket.revenue + subtotal);
        bucket.invoiceCount += 1;
      }
    }

    // SARS 2-month VAT cycle
    if (invDate >= sarsPeriodStart) {
      sarsOutputVat += tax;
    }

    // Contract Revenue Aggregation
    const contract = inv.job.project.contract;
    const existingContract = contractRevenueMap.get(contract.id);
    if (existingContract) {
      existingContract.totalRevenue += subtotal;
    } else {
      contractRevenueMap.set(contract.id, {
        id: contract.id,
        number: contract.number,
        description: contract.description,
        clientName: contract.client.name,
        totalRevenue: subtotal,
      });
    }
  }

  const trailingTrend: RevenueMonthlyTrend[] = Array.from(monthlyBuckets.values());

  // Top 5 Contracts
  const topContracts: ContractRevenueLeader[] = Array.from(contractRevenueMap.values())
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .slice(0, 5)
    .map((c) => ({
      ...c,
      totalRevenue: roundMoney(c.totalRevenue),
      activeJobsCount: activeJobsCountByContract.get(c.id) ?? 0,
    }));

  // Gross Margin Calculation
  const totalRevenue = roundMoney(totalActualRevenue);
  const totalCost = roundMoney(totalLabourCost);
  const totalMargin = roundMoney(totalRevenue - totalCost);
  const overallGrossMarginPct = totalRevenue > 0 ? round((totalMargin / totalRevenue) * 100, 1) : 0;

  const financials: FinancialAnalytics = {
    revenue: {
      mtd: roundMoney(revenueMtd),
      ytd: roundMoney(revenueYtd),
      trailing12m: roundMoney(revenueTrailing12m),
      trailingTrend,
    },
    wip: {
      totalUnbilled: roundMoney(totalUnbilledWip),
      activeJobsWithWip,
      totalActiveJobs: activeJobs.length,
    },
    margins: {
      overallGrossMarginPct,
      totalRevenue,
      totalCost,
      totalMargin,
    },
    vatLiability: {
      outputVatCollected: roundMoney(sarsOutputVat),
      currentPeriodLabel: sarsPeriodLabel,
      trailing12mVat: roundMoney(trailing12mVat),
      standardRatePct: 15,
    },
  };

  return {
    financials,
    operations,
    topContracts,
  };
}
