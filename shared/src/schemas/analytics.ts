/**
 * Executive and financial analytics models and response types (Phase 4).
 */

export interface RevenueMonthlyTrend {
  month: string; // e.g. "2026-10"
  label: string; // e.g. "Oct 26"
  revenue: number; // Recognised revenue (VAT-exclusive subtotal)
  invoiceCount: number;
}

export interface FinancialAnalytics {
  revenue: {
    mtd: number;
    ytd: number;
    trailing12m: number;
    trailingTrend: RevenueMonthlyTrend[];
  };
  wip: {
    totalUnbilled: number;
    activeJobsWithWip: number;
    totalActiveJobs: number;
  };
  margins: {
    overallGrossMarginPct: number;
    totalRevenue: number;
    totalCost: number;
    totalMargin: number;
  };
  vatLiability: {
    outputVatCollected: number;
    currentPeriodLabel: string;
    trailing12mVat: number;
    standardRatePct: number;
  };
}

export interface ContractRevenueLeader {
  id: number;
  number: string;
  description: string;
  clientName: string;
  totalRevenue: number;
  activeJobsCount: number;
}

export interface ExpiringAmendmentSummary {
  id: number;
  amendmentNumber: string;
  contractNumber: string;
  clientName: string;
  expiryDate: string;
  daysRemaining: number;
  band: 'expired' | 'within 30 days' | 'within 90 days';
}

export interface OperationalAnalytics {
  activeJobsCount: number;
  totalJobsCount: number;
  cancelledJobsCount: number;
  pendingInvoicesCount: number;
  pendingInvoicesValue: number;
  unapprovedTimesheetsCount: number;
  costVariance: {
    planned: number;
    actual: number;
    difference: number;
    jobsCounted: number;
  };
  stageCounts: Array<{
    status: string;
    label: string;
    count: number;
  }>;
  expiringAmendments: ExpiringAmendmentSummary[];
}

export interface DashboardAnalyticsResponse {
  financials: FinancialAnalytics | null;
  operations: OperationalAnalytics;
  topContracts: ContractRevenueLeader[] | null;
}
