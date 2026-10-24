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
import { useMemo, useState } from 'react';
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
                />

                <MetricTile
                  label="SARS Output VAT Liability"
                  value={loading ? null : formatZar(financials.vatLiability.outputVatCollected)}
                  caption={loading ? null : `${financials.vatLiability.currentPeriodLabel}`}
                  icon={Receipt}
                  href="/billing"
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
                        {topContracts.map((contract, idx) => (
                          <li
                            key={contract.id}
                            className="flex items-center justify-between py-2.5 gap-2"
                          >
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
                          </li>
                        ))}
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

/**
 * Monthly Revenue Bar Chart Component.
 * Responsive, accessible SVG/HTML bar chart showing trailing 12 months with tooltips.
 */
function MonthlyRevenueChart({ trend }: { trend: RevenueMonthlyTrend[] }) {
  const maxRevenue = useMemo(() => {
    const max = Math.max(...trend.map((t) => t.revenue), 0);
    return max > 0 ? max : 10_000;
  }, [trend]);

  return (
    <div className="w-full">
      <div className="flex h-36 items-end gap-1.5 sm:gap-2.5 pt-4">
        {trend.map((bucket) => {
          const heightPercent = Math.max(Math.round((bucket.revenue / maxRevenue) * 100), 4);
          const isCurrent = bucket.revenue > 0;

          return (
            <div
              key={bucket.month}
              className="group relative flex-1 flex flex-col items-center h-full justify-end"
            >
              {/* Tooltip on hover */}
              <div className="absolute bottom-full mb-1.5 hidden group-hover:flex flex-col items-center z-20 pointer-events-none">
                <div className="rounded bg-popover px-2 py-1 text-[11px] font-medium text-popover-foreground shadow-md border whitespace-nowrap">
                  <p className="font-semibold">{bucket.label}</p>
                  <p className="text-primary font-mono">{formatZar(bucket.revenue)}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {bucket.invoiceCount} {bucket.invoiceCount === 1 ? 'invoice' : 'invoices'}
                  </p>
                </div>
                <div className="size-1.5 rotate-45 bg-popover border-r border-b -mt-1" />
              </div>

              {/* Bar */}
              <div
                style={{ height: `${heightPercent}%` }}
                className={cn(
                  'w-full rounded-t transition-all duration-300',
                  isCurrent
                    ? 'bg-primary/80 group-hover:bg-primary'
                    : 'bg-muted-foreground/15 group-hover:bg-muted-foreground/30',
                )}
              />
            </div>
          );
        })}
      </div>

      {/* X-axis labels */}
      <div className="flex justify-between border-t border-border/60 pt-2 text-[10px] text-muted-foreground font-mono">
        {trend.map((bucket, index) => (
          <span
            key={bucket.month}
            className={cn(
              'flex-1 text-center truncate px-0.5',
              index % 2 === 1 && 'hidden sm:inline', // On mobile, show alternate months to avoid overlap
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
}: {
  label: string;
  value: string | null;
  caption: React.ReactNode;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  href: string;
  tone?: 'neutral' | 'positive' | 'negative';
}) {
  return (
    <Card className="transition-shadow hover:shadow-sm">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-2">
        <SectionHeading>{label}</SectionHeading>
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <p
          className={cn(
            'text-2xl leading-9 font-semibold tabular-nums',
            tone === 'negative' && 'text-negative',
            tone === 'positive' && 'text-positive',
          )}
        >
          {value ?? <Skeleton className="h-9 w-24" />}
        </p>
        {caption !== null && (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{caption}</p>
        )}
        <Link
          href={href}
          className="mt-3 inline-block text-xs font-medium underline-offset-4 hover:underline"
        >
          View detail
          <span className="sr-only"> for {label.toLowerCase()}</span>
        </Link>
      </CardContent>
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
