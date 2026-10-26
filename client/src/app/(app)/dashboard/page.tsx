'use client';

/**
 * Command Centre & Executive Analytics (Phase 4).
 *
 * The landing view for a signed-in user:
 *  - Executive & Financial Intelligence: Trailing 12-Month Revenue trend chart,
 *    unbilled Work-In-Progress (WIP) valuation, fleet gross margin %, SARS VAT liability,
 *    and top revenue-generating contracts.
 *  - Operational Command: Live jobs, pending invoice collections, unapproved timesheets,
 *    planned-vs-actual variance, and contract amendment expiry horizon.
 *
 * Derived server-side in a single fast, indexed roll-up query (/api/analytics/dashboard).
 * Commercial numbers are gated on `invoice.read`, so field supervisors receive a focused
 * operational dashboard without empty shells or locked panels.
 */
import { useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  AlertTriangle,
  ArrowUpRight,
  Briefcase,
  CalendarClock,
  FileWarning,
  Gauge,
  Percent,
  Receipt,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { SectionHeading, varianceTone } from '@/components/lifecycle/status-badge';
import { statusVariant, invoiceVariant } from '@/lib/lifecycle-status';
import { DataTable } from '@/components/data-table/data-table';
import { usePermissions } from '@/components/auth/usePermissions';
import {
  api,
  type DashboardAnalyticsResponse,
  type ExpiringAmendmentSummary,
  type InvoiceRow,
  type RevenueMonthlyTrend,
} from '@/lib/api';
import { formatDate, formatZar } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useJobWorkflow } from '@/hooks/use-job-workflow';

/** Invoices still awaiting money. */
const PENDING_INVOICE_STATUSES = new Set(['Draft', 'Submitted', 'Approved', 'Partially Paid']);

/** Alert horizons for amendment expiry. */
const EXPIRED = 'expired';
const WITHIN_30 = 'within 30 days';
const WITHIN_90 = 'within 90 days';

function summariseExpiry(rows: readonly ExpiringAmendmentSummary[]): string {
  const lapsed = rows.filter((row) => row.band === EXPIRED).length;
  const soon = rows.filter((row) => row.band === WITHIN_30).length;
  const soonish = rows.filter((row) => row.band === WITHIN_90).length;

  const parts: string[] = [];
  if (lapsed > 0) parts.push(`${lapsed} lapsed`);
  if (soon > 0) parts.push(`${soon} within 30 days`);
  if (soonish > 0) parts.push(`${soonish} within 90 days`);
  return parts.join(', ');
}

const expiringColumns: ColumnDef<any, ExpiringAmendmentSummary, unknown>[] = [
  {
    id: 'amendment',
    header: 'Amendment',
    accessorFn: (row) => `${row.contractNumber}/${row.amendmentNumber}`,
    cell: ({ row }) => (
      <span className="block max-w-0 w-full">
        <span
          className="block truncate font-medium"
          title={`${row.original.contractNumber}/${row.original.amendmentNumber}`}
        >
          {row.original.contractNumber}/{row.original.amendmentNumber}
        </span>
        <span
          className="block truncate text-xs text-muted-foreground"
          title={row.original.clientName}
        >
          {row.original.clientName}
        </span>
      </span>
    ),
  },
  {
    id: 'expiryDate',
    accessorKey: 'expiryDate',
    header: 'Expires',
    cell: ({ row }) => (
      <span className="text-xs whitespace-nowrap">{formatDate(row.original.expiryDate)}</span>
    ),
  },
  {
    id: 'days',
    accessorFn: (row) => row.daysRemaining,
    header: 'Left',
    cell: ({ row }) => <ExpiryBadge band={row.original.band} days={row.original.daysRemaining} />,
  },
];

const pendingInvoiceColumns: ColumnDef<any, InvoiceRow, unknown>[] = [
  {
    id: 'invoiceNumber',
    accessorKey: 'invoiceNumber',
    header: 'Invoice',
    cell: ({ row }) => <span className="font-medium">{row.original.invoiceNumber}</span>,
  },
  {
    id: 'client',
    accessorFn: (row) => row.job.project.contract.client.name,
    header: 'Client',
    cell: ({ row }) => (
      <span className="block max-w-[12rem] truncate text-muted-foreground">
        {row.original.job.project.contract.client.name}
      </span>
    ),
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => (
      <Badge variant={invoiceVariant(row.original.status)}>{row.original.status}</Badge>
    ),
  },
  {
    id: 'dueDate',
    accessorKey: 'dueDate',
    header: 'Due',
    cell: ({ row }) => (
      <span className="text-xs whitespace-nowrap">{formatDate(row.original.dueDate)}</span>
    ),
  },
  {
    id: 'totalWithTax',
    accessorKey: 'totalWithTax',
    header: 'Total incl. VAT',
    meta: { align: 'right' },
    cell: ({ row }) => <span className="font-medium">{formatZar(row.original.totalWithTax)}</span>,
  },
];

export default function DashboardPage() {
  const { can, loading: authLoading } = usePermissions();
  const [bandFilter, setBandFilter] = useState('');
  const [pendingStatusFilter, setPendingStatusFilter] = useState('');

  const mayReadJobs = can('job.read') || can('job.read.assigned');
  const mayReadInvoices = can('invoice.read');
  const mayReadProjects = can('project.read');
  const mayReadContracts = can('contract.read');
  const mayReadTimesheets = can('timesheet.read');

  const { label } = useJobWorkflow({ enabled: mayReadJobs });

  // Single consolidated roll-up query
  const analyticsQuery = useQuery({
    queryKey: ['dashboard-analytics'],
    queryFn: () => api.get<DashboardAnalyticsResponse>('/api/analytics/dashboard'),
    staleTime: 30_000,
  });

  // Query for pending invoices detail table (only when user has invoice permission)
  const invoices = useQuery({
    queryKey: ['invoices'],
    queryFn: () => api.get<{ invoices: InvoiceRow[] }>('/api/invoices'),
    enabled: mayReadInvoices,
  });

  const analytics = analyticsQuery.data;
  const financials = analytics?.financials;
  const operations = analytics?.operations;
  const topContracts = analytics?.topContracts ?? [];

  const pendingInvoices = useMemo(
    () =>
      (invoices.data?.invoices ?? []).filter((invoice) =>
        PENDING_INVOICE_STATUSES.has(invoice.status),
      ),
    [invoices.data],
  );

  const loading = authLoading || analyticsQuery.isLoading;
  const nothingToShow =
    !loading &&
    !mayReadProjects &&
    !mayReadJobs &&
    !mayReadInvoices &&
    !mayReadContracts &&
    !mayReadTimesheets;

  const expiringAmendments = operations?.expiringAmendments ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-8 pb-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Command Centre</h1>
        <p className="text-sm text-muted-foreground">
          Executive performance, live works, cash collections and risk horizon.
        </p>
      </header>

      {nothingToShow && (
        <Card>
          <CardContent>
            <Empty>
              <EmptyHeader>
                <Gauge aria-hidden="true" className="size-5" />
                <EmptyTitle>No dashboard access</EmptyTitle>
                <EmptyDescription>
                  Your roles grant none of the read permissions this view summarises. Contact an
                  administrator if you expected access.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      )}

      {!nothingToShow && (
        <>
          {/* =============================================================== */}
          {/* Phase 4: Executive & Financial Intelligence                     */}
          {/* =============================================================== */}
          {financials && (
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">Financial Performance</h2>
                  <p className="text-xs text-muted-foreground">
                    Trailing revenue trends, unbilled WIP valuation, gross margins and SARS VAT
                    obligations.
                  </p>
                </div>
                <Badge variant="outline" className="font-mono text-xs">
                  SARS 15% VAT Standard
                </Badge>
              </div>

              {/* 4 Financial KPI Stat Cards */}
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricTile
                  label="Trailing 12M Revenue"
                  value={loading ? null : formatZar(financials.revenue.trailing12m)}
                  caption={
                    loading
                      ? null
                      : `MTD: ${formatZar(financials.revenue.mtd)} · YTD: ${formatZar(financials.revenue.ytd)}`
                  }
                  icon={TrendingUp}
                  href="/billing"
                  tone="positive"
                  visual={
                    !loading && (
                      <Sparkline
                        data={financials.revenue.trailingTrend.map((t) => t.revenue)}
                        tone="positive"
                      />
                    )
                  }
                />

                <MetricTile
                  label="Work-In-Progress (WIP)"
                  value={loading ? null : formatZar(financials.wip.totalUnbilled)}
                  caption={
                    loading
                      ? null
                      : `${financials.wip.activeJobsWithWip} of ${financials.wip.totalActiveJobs} active jobs unbilled`
                  }
                  icon={Briefcase}
                  href="/operations"
                  visual={
                    !loading && (
                      <div className="w-16 flex flex-col gap-1 items-end">
                        <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
                          {Math.round(
                            (financials.wip.activeJobsWithWip /
                              (financials.wip.totalActiveJobs || 1)) *
                              100,
                          )}
                          %
                        </span>
                        <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-amber-500 rounded-full transition-all duration-500"
                            style={{
                              width: `${Math.min(100, Math.round((financials.wip.activeJobsWithWip / (financials.wip.totalActiveJobs || 1)) * 100))}%`,
                            }}
                          />
                        </div>
                      </div>
                    )
                  }
                />

                <MetricTile
                  label="Average Gross Margin"
                  value={loading ? null : `${financials.margins.overallGrossMarginPct}%`}
                  caption={
                    loading
                      ? null
                      : `Net ${formatZar(financials.margins.totalMargin)} profit on actuals`
                  }
                  icon={Percent}
                  href="/timesheets"
                  tone={
                    (financials?.margins.overallGrossMarginPct ?? 0) >= 20
                      ? 'positive'
                      : (financials?.margins.overallGrossMarginPct ?? 0) >= 10
                        ? 'neutral'
                        : 'negative'
                  }
                  visual={
                    !loading && (
                      <div className="w-16 flex flex-col gap-1 items-end">
                        <span className="text-[10px] font-mono text-muted-foreground">
                          Target ≥ 20%
                        </span>
                        <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                          <div
                            className={cn(
                              'h-full rounded-full transition-all duration-500',
                              financials.margins.overallGrossMarginPct >= 20
                                ? 'bg-emerald-500'
                                : financials.margins.overallGrossMarginPct >= 10
                                  ? 'bg-amber-500'
                                  : 'bg-rose-500',
                            )}
                            style={{
                              width: `${Math.min(100, Math.max(5, (financials.margins.overallGrossMarginPct / 40) * 100))}%`,
                            }}
                          />
                        </div>
                      </div>
                    )
                  }
                />

                <MetricTile
                  label="SARS Output VAT Liability"
                  value={loading ? null : formatZar(financials.vatLiability.outputVatCollected)}
                  caption={loading ? null : `${financials.vatLiability.currentPeriodLabel}`}
                  icon={Receipt}
                  href="/billing"
                  visual={
                    !loading && (
                      <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0 h-5">
                        15% Output
                      </Badge>
                    )
                  }
                />
              </div>

              {/* Revenue Trailing Trend Chart + Top Contracts Leaderboard */}
              <div className="grid gap-4 lg:grid-cols-3">
                {/* 12-Month Revenue Chart */}
                <Card className="lg:col-span-2 flex flex-col">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="text-base">12-Month Revenue Trailing Trend</CardTitle>
                        <CardDescription>
                          Recognised VAT-exclusive invoiced volume across trailing months.
                        </CardDescription>
                      </div>
                      <span className="font-mono text-xs font-semibold text-primary">
                        Total {formatZar(financials.revenue.trailing12m)}
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1 flex flex-col justify-end pt-4">
                    {loading ? (
                      <Skeleton className="h-44 w-full" />
                    ) : (
                      <MonthlyRevenueChart trend={financials.revenue.trailingTrend} />
                    )}
                  </CardContent>
                </Card>

                {/* Top 5 Contracts Leaderboard */}
                <Card className="flex flex-col">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Top Contracts by Turnover</CardTitle>
                    <CardDescription>
                      Commercial agreements ranked by recognised billed turnover.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex-1 overflow-y-auto">
                    {loading ? (
                      <div className="space-y-3">
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                      </div>
                    ) : topContracts.length === 0 ? (
                      <Empty>
                        <EmptyDescription>No billed contracts recorded yet.</EmptyDescription>
                      </Empty>
                    ) : (
                      <ul className="divide-y divide-border/60">
                        {topContracts.map((contract, idx) => {
                          const peakRevenue = topContracts[0]?.totalRevenue || 1;
                          const ratio = Math.min(
                            100,
                            Math.max(4, Math.round((contract.totalRevenue / peakRevenue) * 100)),
                          );
                          return (
                            <li key={contract.id} className="py-2.5 space-y-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[10px] font-semibold text-muted-foreground">
                                    {idx + 1}
                                  </span>
                                  <div className="min-w-0 truncate">
                                    <Link
                                      href={`/commercial?tab=contracts&search=${contract.number}`}
                                      className="font-medium text-xs truncate hover:underline flex items-center gap-1"
                                    >
                                      {contract.number}
                                      <ArrowUpRight className="size-3 text-muted-foreground shrink-0" />
                                    </Link>
                                    <p className="text-[11px] text-muted-foreground truncate">
                                      {contract.clientName}
                                    </p>
                                  </div>
                                </div>
                                <div className="text-right shrink-0">
                                  <p className="font-mono text-xs font-semibold tabular-nums">
                                    {formatZar(contract.totalRevenue)}
                                  </p>
                                  <span className="text-[10px] text-muted-foreground">
                                    {contract.activeJobsCount} active{' '}
                                    {contract.activeJobsCount === 1 ? 'job' : 'jobs'}
                                  </span>
                                </div>
                              </div>
                              <div className="h-1 w-full bg-muted/60 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-primary/70 rounded-full transition-all duration-500"
                                  style={{ width: `${ratio}%` }}
                                />
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </div>
            </section>
          )}

          {/* =============================================================== */}
          {/* Operational Command Centre                                      */}
          {/* =============================================================== */}
          <section className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Operations & Workflow</h2>
              <p className="text-xs text-muted-foreground">
                Field delivery, stage transitions, crew hours and contract compliance horizons.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {mayReadJobs && (
                <MetricTile
                  label="Active jobs"
                  value={loading ? null : String(operations?.activeJobsCount ?? 0)}
                  caption={
                    loading
                      ? null
                      : (operations?.cancelledJobsCount ?? 0) === 0
                        ? 'None cancelled'
                        : `${operations?.cancelledJobsCount} cancelled excluded`
                  }
                  icon={Gauge}
                  href="/operations"
                />
              )}

              {mayReadInvoices && (
                <MetricTile
                  label="Pending invoices"
                  value={loading ? null : String(operations?.pendingInvoicesCount ?? 0)}
                  caption={loading ? null : formatZar(operations?.pendingInvoicesValue ?? 0)}
                  icon={CalendarClock}
                  href="/billing"
                />
              )}

              {mayReadProjects && (
                <MetricTile
                  label="Cost variance (actual − planned)"
                  value={loading ? null : formatZar(operations?.costVariance.difference ?? 0)}
                  caption={
                    loading ? null : (operations?.costVariance.jobsCounted ?? 0) === 0 ? (
                      'No actuals recorded yet'
                    ) : (
                      <>
                        <span className={varianceTone(operations?.costVariance.difference ?? 0)}>
                          {(operations?.costVariance.difference ?? 0) > 0
                            ? `Over by ${formatZar(Math.abs(operations?.costVariance.difference ?? 0))}`
                            : (operations?.costVariance.difference ?? 0) < 0
                              ? `Under by ${formatZar(Math.abs(operations?.costVariance.difference ?? 0))}`
                              : 'On plan'}
                        </span>
                        {' against '}
                        {formatZar(operations?.costVariance.planned ?? 0)} planned
                      </>
                    )
                  }
                  icon={(operations?.costVariance.difference ?? 0) > 0 ? TrendingUp : TrendingDown}
                  href="/operations"
                  tone={
                    (operations?.costVariance.difference ?? 0) > 0
                      ? 'negative'
                      : (operations?.costVariance.difference ?? 0) < 0
                        ? 'positive'
                        : 'neutral'
                  }
                />
              )}

              {mayReadContracts && (
                <MetricTile
                  label="Amendment expiry alerts"
                  value={loading ? null : String(expiringAmendments.length)}
                  caption={
                    loading
                      ? null
                      : expiringAmendments.length === 0
                        ? 'None within 90 days'
                        : summariseExpiry(expiringAmendments)
                  }
                  icon={FileWarning}
                  href="/commercial?tab=contracts"
                  tone={
                    expiringAmendments.some((row) => row.band === EXPIRED || row.band === WITHIN_30)
                      ? 'negative'
                      : 'neutral'
                  }
                />
              )}
            </div>

            <div className="grid min-h-0 flex-1 auto-rows-fr gap-4 lg:grid-cols-2">
              {(mayReadJobs || mayReadProjects) && (
                <Card className="flex min-h-0 flex-col">
                  <CardHeader>
                    <CardTitle className="text-base">Pipeline by stage</CardTitle>
                    <CardDescription>
                      Where every job currently sits in the lifecycle.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="min-h-0 flex-1 overflow-y-auto">
                    {loading ? (
                      <div className="space-y-2">
                        <Skeleton className="h-6 w-full" />
                        <Skeleton className="h-6 w-4/5" />
                        <Skeleton className="h-6 w-2/3" />
                      </div>
                    ) : (operations?.stageCounts ?? []).length === 0 ? (
                      <Empty>
                        <EmptyDescription>No jobs on the board.</EmptyDescription>
                      </Empty>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {(operations?.stageCounts ?? []).map((stage) => (
                          <li
                            key={stage.status}
                            className="flex items-center justify-between gap-3"
                          >
                            <Badge variant={statusVariant(stage.status)}>
                              {label(stage.status)}
                            </Badge>
                            <span className="font-mono text-sm tabular-nums">{stage.count}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              )}

              {mayReadContracts && (
                <Card className="flex min-h-0 flex-col">
                  <CardHeader>
                    <CardTitle className="text-base">Amendments expiring</CardTitle>
                    <CardDescription>
                      Lapsed and soon-to-lapse contract amendments. A lapsed amendment invalidates
                      the authority to bill the work beneath it.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="min-h-0 flex-1">
                    {loading ? (
                      <Skeleton className="h-32 w-full" />
                    ) : expiringAmendments.length === 0 ? (
                      <Empty>
                        <EmptyDescription>No amendment expires within 90 days.</EmptyDescription>
                      </Empty>
                    ) : (
                      <DataTable<ExpiringAmendmentSummary>
                        tableId="dashboard-expiring-amendments"
                        caption="Contract amendments within 90 days of expiry"
                        data={expiringAmendments}
                        columns={expiringColumns}
                        rowKey={(row) => row.id}
                        searchKeys={['contractNumber', 'clientName', 'amendmentNumber']}
                        searchPlaceholder="Search contract or client…"
                        initialSort={[{ id: 'days', desc: false }]}
                        pageSize={10}
                        emptyMessage="No amendment expires within 90 days."
                        filters={[
                          {
                            id: 'band',
                            label: 'Urgency',
                            value: bandFilter,
                            options: [
                              { value: '', label: 'Any' },
                              { value: EXPIRED, label: 'Lapsed' },
                              { value: WITHIN_30, label: 'Within 30 days' },
                              { value: WITHIN_90, label: 'Within 90 days' },
                            ],
                            onChange: setBandFilter,
                            predicate: (row, selected) => row.band === selected,
                          },
                        ]}
                      />
                    )}
                  </CardContent>
                </Card>
              )}
            </div>

            {mayReadInvoices && (
              <Card className="flex min-h-0 flex-[2] flex-col">
                <CardHeader>
                  <CardTitle className="text-base">Invoices awaiting money</CardTitle>
                  <CardDescription>
                    Draft, submitted, approved and part-paid invoices, newest first.
                  </CardDescription>
                </CardHeader>
                <CardContent className="min-h-0 flex-1">
                  {loading ? (
                    <Skeleton className="h-40 w-full" />
                  ) : pendingInvoices.length === 0 ? (
                    <Empty>
                      <EmptyDescription>Nothing outstanding.</EmptyDescription>
                    </Empty>
                  ) : (
                    <DataTable<InvoiceRow>
                      tableId="dashboard-pending-invoices"
                      caption="Invoices awaiting money"
                      data={pendingInvoices}
                      columns={pendingInvoiceColumns}
                      rowKey={(invoice) => invoice.id}
                      searchKeys={[
                        'invoiceNumber',
                        'job.project.contract.number',
                        'job.project.contract.client.name',
                      ]}
                      searchPlaceholder="Search invoice or client…"
                      initialSort={[{ id: 'totalWithTax', desc: true }]}
                      pageSize={10}
                      emptyMessage="Nothing outstanding."
                      filters={[
                        {
                          id: 'status',
                          label: 'Status',
                          value: pendingStatusFilter,
                          options: [
                            { value: '', label: 'All pending' },
                            ...[...PENDING_INVOICE_STATUSES].map((status) => ({
                              value: status,
                              label: status,
                            })),
                          ],
                          onChange: setPendingStatusFilter,
                          predicate: (invoice, selected) => invoice.status === selected,
                        },
                      ]}
                    />
                  )}
                </CardContent>
              </Card>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** Formats compact currency labels for chart Y-axes (e.g. R 120k, R 1.5M). */
function formatCompactZar(amount: number): string {
  if (amount >= 1_000_000) {
    return `R ${(amount / 1_000_000).toFixed(1)}M`;
  }
  if (amount >= 1_000) {
    return `R ${(amount / 1_000).toFixed(0)}k`;
  }
  return `R ${Math.round(amount)}`;
}

/** Micro SVG trend sparkline for KPI tiles. */
function Sparkline({
  data,
  tone = 'positive',
}: {
  data: number[];
  tone?: 'positive' | 'neutral' | 'negative';
}) {
  const gradientId = useId();
  if (!data || data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const width = 80;
  const height = 24;
  const points = data.map((val, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((val - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const pathD = `M ${points.join(' L ')}`;
  const areaD = `M 0,${height} L ${points.join(' L ')} L ${width},${height} Z`;

  const strokeColor =
    tone === 'negative'
      ? 'var(--color-negative, #ef4444)'
      : tone === 'positive'
        ? 'var(--color-primary, #3b82f6)'
        : 'var(--color-muted-foreground, #888888)';

  return (
    <div className="h-6 w-20 shrink-0">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity="0.25" />
            <stop offset="100%" stopColor={strokeColor} stopOpacity="0.0" />
          </linearGradient>
        </defs>
        <path d={areaD} fill={`url(#${gradientId})`} />
        <path
          d={pathD}
          fill="none"
          stroke={strokeColor}
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/**
 * Monthly Revenue Bar Chart Component.
 * Responsive, accessible SVG/HTML bar chart with reference gridlines, currency scale and hover stats.
 */
function MonthlyRevenueChart({ trend }: { trend: RevenueMonthlyTrend[] }) {
  const maxRevenue = useMemo(() => {
    const max = Math.max(...trend.map((t) => t.revenue), 0);
    return max > 0 ? max : 10_000;
  }, [trend]);

  const yTicks = [
    { label: formatCompactZar(maxRevenue), pct: 100 },
    { label: formatCompactZar(maxRevenue * 0.75), pct: 75 },
    { label: formatCompactZar(maxRevenue * 0.5), pct: 50 },
    { label: formatCompactZar(maxRevenue * 0.25), pct: 25 },
    { label: 'R 0', pct: 0 },
  ];

  return (
    <div className="w-full space-y-2">
      <div className="relative flex h-48 w-full gap-3 pt-2">
        {/* Y-Axis scale */}
        <div className="flex flex-col justify-between text-right text-[10px] font-mono text-muted-foreground/80 w-12 shrink-0 py-0.5 select-none">
          {yTicks.map((tick) => (
            <span key={tick.pct} className="tabular-nums">
              {tick.label}
            </span>
          ))}
        </div>

        {/* Chart plot area */}
        <div className="relative flex-1 h-full">
          {/* Horizontal reference gridlines */}
          <div className="absolute inset-0 flex flex-col justify-between pointer-events-none">
            {yTicks.map((tick) => (
              <div
                key={tick.pct}
                className="w-full border-b border-dashed border-border/50"
              />
            ))}
          </div>

          {/* Bar columns */}
          <div className="relative z-10 flex h-full items-end gap-1.5 sm:gap-2.5 px-1">
            {trend.map((bucket) => {
              const heightPercent = Math.max(Math.round((bucket.revenue / maxRevenue) * 100), 4);
              const isCurrent = bucket.revenue > 0;

              return (
                <div
                  key={bucket.month}
                  className="group relative flex-1 flex flex-col items-center h-full justify-end"
                >
                  {/* Tooltip on hover */}
                  <div className="absolute bottom-full mb-2 hidden group-hover:flex flex-col items-center z-30 pointer-events-none animate-in fade-in-0 zoom-in-95 duration-100">
                    <div className="rounded-md bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-lg border whitespace-nowrap">
                      <p className="font-semibold text-foreground">{bucket.label}</p>
                      <p className="text-primary font-mono font-semibold">{formatZar(bucket.revenue)}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {bucket.invoiceCount} {bucket.invoiceCount === 1 ? 'tax invoice' : 'tax invoices'} ·{' '}
                        {Math.round((bucket.revenue / maxRevenue) * 100)}% of peak
                      </p>
                    </div>
                    <div className="size-1.5 rotate-45 bg-popover border-r border-b -mt-1" />
                  </div>

                  {/* Bar with gradient and active hover */}
                  <div
                    style={{ height: `${heightPercent}%` }}
                    className={cn(
                      'w-full rounded-t-sm transition-all duration-300',
                      isCurrent
                        ? 'bg-gradient-to-t from-primary/70 via-primary/85 to-primary group-hover:from-primary group-hover:to-primary/90 shadow-xs'
                        : 'bg-muted-foreground/15 group-hover:bg-muted-foreground/30',
                    )}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* X-axis labels aligned under bars */}
      <div className="flex pl-15 pr-1 justify-between pt-1 text-[10px] text-muted-foreground font-mono">
        {trend.map((bucket, index) => (
          <span
            key={bucket.month}
            className={cn(
              'flex-1 text-center truncate px-0.5',
              index % 2 === 1 && 'hidden sm:inline',
            )}
          >
            {bucket.label.split(' ')[0]}
          </span>
        ))}
      </div>
    </div>
  );
}

function MetricTile({
  label,
  value,
  caption,
  icon: Icon,
  href,
  tone = 'neutral',
  visual,
}: {
  label: string;
  value: string | null;
  caption: React.ReactNode;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  href: string;
  tone?: 'neutral' | 'positive' | 'negative';
  visual?: React.ReactNode;
}) {
  return (
    <Card className="transition-all duration-200 hover:shadow-md hover:border-primary/30 flex flex-col justify-between">
      <div>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-2">
          <SectionHeading>{label}</SectionHeading>
          <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <p
              className={cn(
                'text-2xl leading-none font-semibold tabular-nums tracking-tight',
                tone === 'negative' && 'text-negative',
                tone === 'positive' && 'text-positive',
              )}
            >
              {value ?? <Skeleton className="h-8 w-24" />}
            </p>
            {visual}
          </div>
          {caption !== null && (
            <p className="text-xs leading-relaxed text-muted-foreground">{caption}</p>
          )}
        </CardContent>
      </div>
      <div className="px-6 pb-4 pt-1 border-t border-border/40 mt-2">
        <Link
          href={href}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-primary transition-colors underline-offset-4 hover:underline"
        >
          <span>View breakdown</span>
          <ArrowUpRight className="size-3" />
          <span className="sr-only"> for {label.toLowerCase()}</span>
        </Link>
      </div>
    </Card>
  );
}

function ExpiryBadge({ band, days }: { band: string; days: number }) {
  if (band === EXPIRED) {
    return (
      <Badge variant="destructive">
        <AlertTriangle aria-hidden="true" className="size-3" />
        Lapsed {Math.abs(days)}d ago
      </Badge>
    );
  }
  return <Badge variant="warning">{days}d left</Badge>;
}
