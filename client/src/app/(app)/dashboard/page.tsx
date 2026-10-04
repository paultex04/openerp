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
import { useMemo } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  FileWarning,
  Gauge,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { SectionHeading, varianceTone } from '@/components/lifecycle/status-badge';
import { statusVariant, invoiceVariant } from '@/lib/lifecycle-status';
import { NumericCell } from '@/components/data-table/NumericCell';
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

export default function DashboardPage() {
  const { can, loading: authLoading } = usePermissions();
  const mayReadProjects = can('project.read');
  const mayReadJobs = can('job.read') || can('job.read.assigned');
  const mayReadInvoices = can('invoice.read');
  const mayReadContracts = can('contract.read');

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

  const stageCounts = allJobs.reduce<Record<string, number>>((counts, job) => {
    counts[job.status] = (counts[job.status] ?? 0) + 1;
    return counts;
  }, {});

  const loading = authLoading;
  const nothingToShow =
    !loading && !mayReadProjects && !mayReadJobs && !mayReadInvoices && !mayReadContracts;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
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
                href="/operations?view=board"
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
                href="/operations?view=dashboard"
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

          <div className="grid gap-4 lg:grid-cols-2">
            {(mayReadJobs || mayReadProjects) && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Pipeline by stage</CardTitle>
                  <CardDescription>
                    Where every job currently sits in the lifecycle.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {loading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-6 w-full" />
                      <Skeleton className="h-6 w-4/5" />
                      <Skeleton className="h-6 w-2/3" />
                    </div>
                  ) : Object.keys(stageCounts).length === 0 ? (
                    <Empty>
                      <EmptyDescription>No jobs on the board.</EmptyDescription>
                    </Empty>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {Object.entries(stageCounts)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([status, count]) => (
                          <li key={status} className="flex items-center justify-between gap-3">
                            <Badge variant={statusVariant(status)}>{status}</Badge>
                            <span className="font-mono text-sm tabular-nums">{count}</span>
                          </li>
                        ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            )}

            {mayReadContracts && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Amendments expiring</CardTitle>
                  <CardDescription>
                    Lapsed and soon-to-lapse contract amendments. A lapsed amendment invalidates the
                    authority to bill the work beneath it.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {loading ? (
                    <Skeleton className="h-32 w-full" />
                  ) : expiring.length === 0 ? (
                    <Empty>
                      <EmptyDescription>No amendment expires within 90 days.</EmptyDescription>
                    </Empty>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        {/*
                          A caption is required, not decorative: this is a table
                          of contract instruments, and a screen-reader user needs
                          to know what the numbers mean before entering it.
                        */}
                        <TableCaption>
                          Contract amendments within 90 days of expiry, soonest first.
                        </TableCaption>
                        <TableHeader>
                          <TableRow>
                            {/*
                              Two columns, not three. This card sits in a two-up
                              grid and is ~440px wide at desktop; a reference, a
                              client name and a date plus badge measured 487px and
                              scrolled sideways, which clipped the one column the
                              row exists to show. The client moves under the
                              reference, where it is still readable and the expiry
                              date stays on screen without a scroll.
                            */}
                            <TableHead scope="col">Amendment</TableHead>
                            <TableHead scope="col" className="text-right">
                              Expires
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {expiring.map((row) => (
                            <TableRow key={row.amendment.id}>
                              {/*
                                Truncated with the full value on `title`. A
                                contract reference like
                                `SASOL-ECI-2026-TERM/AMD-00` has no break
                                opportunity, so without a width cap it forces the
                                whole table to scroll sideways.
                              */}
                              {/*
                                `max-w-0` is the load-bearing part. A table cell
                                sizes to its content and will not shrink, so
                                `truncate` on the inner span never engages and the
                                unbreakable reference pushes the expiry column out
                                of view. `max-w-0 w-full` collapses the cell to
                                zero intrinsic width and lets it take exactly the
                                space left over by the non-wrapping date column.
                              */}
                              <TableCell className="max-w-0 w-full">
                                <span
                                  className="block truncate font-medium"
                                  title={`${row.contractNumber}/${row.amendment.amendmentNumber}`}
                                >
                                  {row.contractNumber}/{row.amendment.amendmentNumber}
                                </span>
                                <span
                                  className="block truncate text-xs text-muted-foreground"
                                  title={row.clientName}
                                >
                                  {row.clientName}
                                </span>
                              </TableCell>
                              <NumericCell className="whitespace-nowrap align-top">
                                <span className="flex items-center justify-end gap-2">
                                  <span className="text-xs text-muted-foreground">
                                    {formatDate(row.amendment.expiryDate)}
                                  </span>
                                  <ExpiryBadge band={row.band} days={row.days} />
                                </span>
                              </NumericCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>

          {mayReadInvoices && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Invoices awaiting money</CardTitle>
                <CardDescription>
                  Draft, submitted, approved and part-paid invoices, newest first.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <Skeleton className="h-40 w-full" />
                ) : pendingInvoices.length === 0 ? (
                  <Empty>
                    <EmptyDescription>Nothing outstanding.</EmptyDescription>
                  </Empty>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableCaption>
                        Invoices not yet paid or cancelled, with total including VAT.
                      </TableCaption>
                      <TableHeader>
                        <TableRow>
                          <TableHead scope="col">Invoice</TableHead>
                          <TableHead scope="col">Client</TableHead>
                          <TableHead scope="col">Status</TableHead>
                          <TableHead scope="col" className="text-right">
                            Due
                          </TableHead>
                          <TableHead scope="col" className="text-right">
                            Total incl. VAT
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pendingInvoices.map((invoice) => (
                          <TableRow key={invoice.id}>
                            <TableCell className="font-medium">{invoice.invoiceNumber}</TableCell>
                            <TableCell className="text-muted-foreground">
                              {invoice.job.project.contract.client.name}
                            </TableCell>
                            <TableCell>
                              <Badge variant={invoiceVariant(invoice.status)}>
                                {invoice.status}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {formatDate(invoice.dueDate)}
                            </TableCell>
                            <NumericCell className="font-medium">
                              {formatZar(invoice.totalWithTax)}
                            </NumericCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
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
