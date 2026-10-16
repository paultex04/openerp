'use client';

/**
 * The hours booked to one job, on the job screen's Timesheets tab.
 *
 * A read-only companion to Labour & margin: that panel aggregates the job's cost
 * by labour type, this lists the individual lines behind the total — who, which
 * day, how long, and whether their week has been approved. It reads
 * `GET /api/timesheets/job-entries` and writes nothing, which is the one-way arrow
 * the whole module is built on: job management owns revenue, timesheets own hours,
 * costing reads both.
 *
 * An approved line shows the cost frozen when its week was approved; a draft or
 * pending one shows today's preview, flagged when there is no rate to price it at,
 * so the cost column never silently reads zero. Rendered only for a viewer holding
 * `timesheet.read`, because every column here is cost.
 */
import { useQuery } from '@tanstack/react-query';
import { api, type JobTimeEntries } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TimesheetStatusBadge } from '@/components/timesheets/status-badge';
import { formatDate, formatNumber, formatZar } from '@/lib/format';

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm tabular-nums">{value}</dd>
    </div>
  );
}

export function JobTimesheetsPanel({ jobId }: { jobId: number }) {
  const query = useQuery({
    queryKey: ['job', jobId, 'time-entries'],
    queryFn: () => api.get<JobTimeEntries>('/api/timesheets/job-entries', { jobId }),
  });

  if (query.isLoading) {
    return <Skeleton className="h-40 w-full" />;
  }

  if (query.isError || !query.data) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          The hours booked to this job could not be loaded.
        </CardContent>
      </Card>
    );
  }

  const { entries, totals } = query.data;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Totals above the table, not in a footer: a footer scrolls out of view,
          and the job's total labour cost is the reason to read this list. */}
      <dl className="grid gap-3 sm:grid-cols-4">
        <Figure label="Hours" value={formatNumber(totals.hours)} />
        <Figure label="Billable hours" value={formatNumber(totals.billableHours)} />
        <Figure label="Labour cost" value={formatZar(totals.cost)} />
        <Figure
          label="Lines"
          value={`${entries.length}${totals.unpricedLines > 0 ? ` (${totals.unpricedLines} unpriced)` : ''}`}
        />
      </dl>

      {totals.unpricedLines > 0 && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
          {totals.unpricedLines} {totals.unpricedLines === 1 ? 'line has' : 'lines have'} no
          employee rate, so {totals.unpricedLines === 1 ? 'it cannot' : 'they cannot'} be priced and
          the labour cost above excludes {totals.unpricedLines === 1 ? 'it' : 'them'}.
        </p>
      )}

      {/* The body scrolls rather than the page, so the totals row stays put on a
          job with months of hours booked against it. */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border">
        <Table>
          <TableCaption className="sr-only">
            Hours booked to job {jobId}, with employee, week and cost
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Date</TableHead>
              <TableHead scope="col">Employee</TableHead>
              <TableHead scope="col">Week</TableHead>
              <TableHead scope="col">Labour type</TableHead>
              <TableHead scope="col">Shift</TableHead>
              <TableHead scope="col" className="text-right">
                Hours
              </TableHead>
              <TableHead scope="col" className="text-right">
                Cost
              </TableHead>
              <TableHead scope="col">Week status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center text-sm text-muted-foreground">
                  No hours have been booked to this job yet.
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-nowrap">{formatDate(entry.workDate)}</TableCell>
                  <TableCell className="font-medium">
                    {entry.employee.name} {entry.employee.surname}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDate(entry.periodStart)} – {formatDate(entry.periodEnd)}
                  </TableCell>
                  <TableCell>{entry.labourType}</TableCell>
                  <TableCell>{entry.shiftType}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(entry.hours)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {entry.priced ? (
                      formatZar(entry.costAmount)
                    ) : (
                      <span className="text-warning">unpriced</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <TimesheetStatusBadge status={entry.timesheetStatus} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        The cost above previews every listed line at the employee's current rate. Only an approved
        week's cost is frozen, and only approved hours count toward the Financials tab's margin.
      </p>
    </section>
  );
}
