'use client';

/**
 * Command Centre.
 *
 * The landing view for a signed-in user: the four numbers that decide whether
 * anything needs attention today - how much work is live, how much money is
 * sitting in unpaid invoices, whether the jobs that have actuals are landing on
 * or over plan, and which contract amendments are about to lapse.
 *
 * Every figure is derived server-side or from a server response; nothing is
 * recomputed from a locally-editable total. Each query is gated on the
 * permission that authorises it, so a field supervisor gets a dashboard without
 * commercial or billing numbers rather than an empty shell with locked panels.
 */
import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  AlertTriangle,
  CalendarClock,
  FileWarning,
  Gauge,
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
  type AmendmentSummary,
  type ContractRow,
  type InvoiceRow,
  type JobRow,
  type ProjectDetail,
  type ProjectRow,
} from '@/lib/api';
import { formatDate, formatZar } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useJobWorkflow } from '@/hooks/use-job-workflow';

/**
 * Statuses that count as "not active" for the live-jobs tile.
 *
 * Cancelled work is excluded; invoiced work is *not*, because a job stays
 * commercially open until its invoice is settled and excluding it would hide the
 * largest pipeline on some months.
 */
const INACTIVE_STATUSES = new Set(['00. Cancelled']);

/** Invoices still awaiting money. */
const PENDING_INVOICE_STATUSES = new Set(['Draft', 'Submitted', 'Approved', 'Partially Paid']);

/** Alert horizons for amendment expiry, in days. */
const EXPIRED = 'expired';
const WITHIN_30 = 'within 30 days';
const WITHIN_90 = 'within 90 days';

/**
 * One-line summary of the expiry alerts, naming the most urgent band present.
 *
 * Counting only "urgent" items produced "0 urgent" beside a populated table,
 * which reads as a contradiction. Reporting the worst band and its size is
 * accurate at every population.
 */
function summariseExpiry(rows: readonly ExpiringAmendment[]): string {
  const lapsed = rows.filter((row) => row.band === EXPIRED).length;
  const soon = rows.filter((row) => row.band === WITHIN_30).length;
  const soonish = rows.filter((row) => row.band === WITHIN_90).length;

  const parts: string[] = [];
  if (lapsed > 0) parts.push(`${lapsed} lapsed`);
  if (soon > 0) parts.push(`${soon} within 30 days`);
  if (soonish > 0) parts.push(`${soonish} within 90 days`);
  return parts.join(', ');
}

function classifyExpiry(expiry: Date): string {
  const days = daysUntil(expiry);
  if (days < 0) return EXPIRED;
  if (days <= 30) return WITHIN_30;
  if (days <= 90) return WITHIN_90;
  return 'ok';
}

function daysUntil(date: Date): number {
  // Compare on date boundaries, not instants: an amendment expiring at 00:00
  // tomorrow is "0 days" to a person reading a calendar, not "0.3 days".
  const today = new Date();
  const startOfToday = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const target = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.round((target - startOfToday) / 86_400_000);
}

interface ExpiringAmendment {
  amendment: AmendmentSummary;
  contractNumber: string;
  clientName: string;
  band: string;
  days: number;
}

/**
 * Column definitions.
 *
 * Module scope so the array identity is stable: `DataTable` memoises its row
 * model on these references, and definitions rebuilt each render would re-run
 * sorting on every keystroke in the search box.
 */
const expiringColumns: ColumnDef<any, ExpiringAmendment, unknown>[] = [
  {
    id: 'amendment',
    header: 'Amendment',
    // Sorts on the reference so the column is orderable.
    accessorFn: (row) => `${row.contractNumber}/${row.amendment.amendmentNumber}`,
    cell: ({ row }) => (
      <span className="block max-w-0 w-full">
        <span
          className="block truncate font-medium"
          title={`${row.original.contractNumber}/${row.original.amendment.amendmentNumber}`}
        >
          {row.original.contractNumber}/{row.original.amendment.amendmentNumber}
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
    accessorFn: (row) => row.amendment.expiryDate ?? '',
    header: 'Expires',
    cell: ({ row }) => (
      <span className="text-xs whitespace-nowrap">
        {formatDate(row.original.amendment.expiryDate)}
      </span>
    ),
  },
  {
    // Sorted by days remaining, which is the ordering that matters, rather than
    // by date string - same order, but the intent is legible.
    id: 'days',
    accessorFn: (row) => row.days,
    header: 'Left',
    cell: ({ row }) => <ExpiryBadge band={row.original.band} days={row.original.days} />,
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
  const mayReadProjects = can('project.read');
  const mayReadJobs = can('job.read') || can('job.read.assigned');
  const mayReadInvoices = can('invoice.read');
  const mayReadContracts = can('contract.read');

  const { statuses, label } = useJobWorkflow({ enabled: mayReadJobs });

  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: ProjectRow[] }>('/api/projects'),
    enabled: mayReadProjects,
  });

  const jobs = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.get<{ jobs: JobRow[] }>('/api/jobs'),
    enabled: mayReadJobs,
  });

  const invoices = useQuery({
    queryKey: ['invoices'],
    queryFn: () => api.get<{ invoices: InvoiceRow[] }>('/api/invoices'),
    enabled: mayReadInvoices,
  });

  const contracts = useQuery({
    queryKey: ['contracts'],
    queryFn: () => api.get<{ contracts: ContractRow[] }>('/api/contracts'),
    enabled: mayReadContracts,
  });

  /*
   * Planned-vs-actual variance is only exposed on the per-project endpoint, so
   * the dashboard fans out to it. These requests run in parallel via useQueries
   * rather than being chained, and a project that fails contributes nothing
   * rather than blanking the tile.
   *
   * KNOWN LIMITATION: this is one request per project. It is acceptable at the
   * current scale, but a portfolio of hundreds of projects would need a
   * server-side roll-up endpoint - not a client-side fix.
   */
  const projectIds = (projects.data?.projects ?? []).map((project) => project.id);
  const projectDetails = useQueries({
    queries: projectIds.map((id) => ({
      queryKey: ['project', id],
      queryFn: () => api.get<ProjectDetail>(`/api/projects/${id}`),
      enabled: mayReadProjects,
      staleTime: 60_000,
    })),
  });

  const variance = useMemo(() => {
    const details = projectDetails
      .map((result) => result.data)
      .filter((detail): detail is ProjectDetail => Boolean(detail));

    let planned = 0;
    let actual = 0;
    for (const detail of details) {
      for (const job of detail.project.jobs) {
        planned += job.plannedSubtotal;
        actual += job.actualSubtotal;
      }
    }
    return { planned, actual, difference: actual - planned, jobsCounted: details.length };
  }, [projectDetails]);

  const expiring = useMemo<ExpiringAmendment[]>(() => {
    const rows: ExpiringAmendment[] = [];
    for (const contract of contracts.data?.contracts ?? []) {
      for (const amendment of contract.amendments) {
        if (!amendment.expiryDate) continue;
        const expiry = new Date(amendment.expiryDate);
        if (Number.isNaN(expiry.getTime())) continue;
        const band = classifyExpiry(expiry);
        if (band === 'ok') continue;
        rows.push({
          amendment,
          contractNumber: contract.number,
          clientName: contract.client.name,
          band,
          days: daysUntil(expiry),
        });
      }
    }
    // Soonest first, and an already-lapsed amendment outranks one expiring next
    // week - a lapsed amendment is the more urgent of the two.
    return rows.sort((a, b) => a.days - b.days);
  }, [contracts.data]);

  const allJobs = jobs.data?.jobs ?? [];
  const activeJobs = allJobs.filter((job) => !INACTIVE_STATUSES.has(job.status));
  const pendingInvoices = (invoices.data?.invoices ?? []).filter((invoice) =>
    PENDING_INVOICE_STATUSES.has(invoice.status),
  );
  const pendingValue = pendingInvoices.reduce((sum, invoice) => sum + invoice.totalWithTax, 0);

  // Ordered by the live workflow rather than alphabetically: an administrator
  // who moves a stage moves this list with it, and a stage whose label no longer
  // starts with a number still sorts where the pipeline says it belongs.
  const stageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const job of allJobs) counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
    const order = new Map(statuses.map((status) => [status.key, status.sortOrder]));
    return [...counts.entries()].sort(
      ([a], [b]) =>
        (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
    );
  }, [allJobs, statuses]);

  const loading = authLoading;
  const nothingToShow =
    !loading && !mayReadProjects && !mayReadJobs && !mayReadInvoices && !mayReadContracts;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Command Centre</h1>
        <p className="text-sm text-muted-foreground">
          Live work, money in flight, cost variance and contract exposure.
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
          {/* Primary metrics. Skeletons hold the grid so the page does not reflow
              when each query lands at a different moment. */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {mayReadJobs && (
              <MetricTile
                label="Active jobs"
                value={loading ? null : String(activeJobs.length)}
                caption={
                  activeJobs.length === allJobs.length
                    ? 'None cancelled'
                    : `${allJobs.length - activeJobs.length} cancelled excluded`
                }
                icon={Gauge}
                href="/operations"
              />
            )}

            {mayReadInvoices && (
              <MetricTile
                label="Pending invoices"
                value={loading ? null : String(pendingInvoices.length)}
                // The money is the point of the tile; the count is context.
                caption={loading ? null : formatZar(pendingValue)}
                icon={CalendarClock}
                href="/billing"
              />
            )}

            {mayReadProjects && (
              <MetricTile
                label="Cost variance (actual − planned)"
                value={loading ? null : formatZar(variance.difference)}
                caption={
                  loading ? null : variance.jobsCounted === 0 ? (
                    'No actuals recorded yet'
                  ) : (
                    <>
                      <span className={varianceTone(variance.difference)}>
                        {variance.difference > 0
                          ? `Over by ${formatZar(Math.abs(variance.difference))}`
                          : variance.difference < 0
                            ? `Under by ${formatZar(Math.abs(variance.difference))}`
                            : 'On plan'}
                      </span>
                      {' against '}
                      {formatZar(variance.planned)} planned
                    </>
                  )
                }
                icon={variance.difference > 0 ? TrendingUp : TrendingDown}
                href="/operations"
                // Positive variance is bad news here, so it is flagged, not celebrated.
                tone={
                  variance.difference > 0
                    ? 'negative'
                    : variance.difference < 0
                      ? 'positive'
                      : 'neutral'
                }
              />
            )}

            {mayReadContracts && (
              <MetricTile
                label="Amendment expiry alerts"
                value={loading ? null : String(expiring.length)}
                caption={
                  loading
                    ? null
                    : expiring.length === 0
                      ? 'None within 90 days'
                      : // Name the most urgent band present rather than counting
                        // "urgent". "0 urgent" next to one alert reads as a
                        // contradiction, because it is counting only lapsed or
                        // 30-day items while ignoring the 90-day ones shown.
                        summariseExpiry(expiring)
                }
                icon={FileWarning}
                href="/commercial?tab=contracts"
                tone={
                  expiring.some((row) => row.band === EXPIRED || row.band === WITHIN_30)
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
                  ) : stageCounts.length === 0 ? (
                    <Empty>
                      <EmptyDescription>No jobs on the board.</EmptyDescription>
                    </Empty>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {stageCounts.map(([status, count]) => (
                        <li key={status} className="flex items-center justify-between gap-3">
                          <Badge variant={statusVariant(status)}>{label(status)}</Badge>
                          <span className="font-mono text-sm tabular-nums">{count}</span>
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
                    Lapsed and soon-to-lapse contract amendments. A lapsed amendment invalidates the
                    authority to bill the work beneath it.
                  </CardDescription>
                </CardHeader>
                <CardContent className="min-h-0 flex-1">
                  {loading ? (
                    <Skeleton className="h-32 w-full" />
                  ) : expiring.length === 0 ? (
                    <Empty>
                      <EmptyDescription>No amendment expires within 90 days.</EmptyDescription>
                    </Empty>
                  ) : (
                    <DataTable<ExpiringAmendment>
                      caption="Contract amendments within 90 days of expiry"
                      data={expiring}
                      columns={expiringColumns}
                      rowKey={(row) => row.amendment.id}
                      searchKeys={['contractNumber', 'clientName', 'amendment.amendmentNumber']}
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
        </>
      )}
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
  /** A node, not a string: the variance caption carries its own colour, which a
      plain string cannot express without smuggling class names through data. */
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
        {/*
          Tabular figures on a fixed line height, so a six-digit rand amount
          keeps its width and does not resize the tile as the number changes.

          Deliberately the UI font rather than `font-mono`: a monospaced face
          renders the space in "R 35,64" at full character width, which makes a
          currency amount read as two separate tokens. `tabular-nums` gives the
          column alignment without that.
        */}
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
