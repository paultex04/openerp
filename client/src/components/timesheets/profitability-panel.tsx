'use client';

/**
 * Labour profitability — the register that makes the timesheets worth taking.
 *
 * Every row is one job and the four numbers that decide whether it made money:
 * revenue (work done at charge-out rates), what the approved hours cost, what the
 * materials cost, and the margin between them. It is computed on read from
 * `GET /api/costing/jobs`, so there is no nightly rollup to be stale and no
 * invalidation to forget — the figure is whatever the base rows say right now.
 *
 * "Jobs with hours only" is the default because a register of every scoped job
 * with no time recorded against it is mostly zeros; the toggle is there for the
 * other question, "which jobs have no labour against them at all".
 */
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { api, ApiError, type JobCosting } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/data-table/data-table';
import { formatNumber, formatPercent, formatZar } from '@/lib/format';
import { jobLabel } from './weeks';

function cell<T extends object>(header: string, accessor: (row: T) => ReactNode) {
  return {
    header,
    cell: ({ row }: { row: { original: T } }) => accessor(row.original),
  } as unknown as ColumnDef<any, T, unknown>;
}

function numericCell<T extends object>(header: string, accessor: (row: T) => ReactNode) {
  return {
    header,
    meta: { align: 'right' },
    cell: ({ row }: { row: { original: T } }) => accessor(row.original),
  } as unknown as ColumnDef<any, T, unknown>;
}

/** Margin is the one figure where red and green mean what a reader expects. */
function marginTone(value: number): string {
  if (Math.abs(value) < 0.005) return 'text-muted-foreground';
  return value < 0 ? 'text-negative font-medium' : 'text-positive';
}

export function ProfitabilityPanel() {
  const [withHoursOnly, setWithHoursOnly] = useState(true);

  const query = useQuery({
    queryKey: ['costing', 'jobs', withHoursOnly],
    queryFn: () =>
      api.get<{ jobs: JobCosting[] }>('/api/costing/jobs', {
        withHoursOnly: withHoursOnly || undefined,
        limit: 500,
      }),
  });

  const rows = query.data?.jobs ?? [];
  const totals = rows.reduce(
    (acc, row) => ({
      revenue: acc.revenue + row.revenueActual,
      cost: acc.cost + row.costActual,
      margin: acc.margin + row.grossMargin,
      hours: acc.hours + row.hoursActual,
    }),
    { revenue: 0, cost: 0, margin: 0, hours: 0 },
  );

  const columns: ColumnDef<any, JobCosting, unknown>[] = [
    cell<JobCosting>('Job', (row) => (
      <Link href={`/operations/${row.jobId}`} className="font-medium hover:underline">
        {jobLabel(row.job)}
      </Link>
    )),
    cell<JobCosting>('Project', (row) => (
      <span className="text-muted-foreground">
        {row.job.projectCode} · {row.job.clientName}
      </span>
    )),
    numericCell<JobCosting>('Hours', (row) => formatNumber(row.hoursActual)),
    numericCell<JobCosting>('Revenue', (row) => formatZar(row.revenueActual)),
    numericCell<JobCosting>('Labour', (row) => formatZar(row.labourCostActual)),
    numericCell<JobCosting>('Materials', (row) => formatZar(row.materialCostActual)),
    numericCell<JobCosting>('Cost', (row) => formatZar(row.costActual)),
    numericCell<JobCosting>('Margin', (row) => (
      <span className={marginTone(row.grossMargin)}>{formatZar(row.grossMargin)}</span>
    )),
    numericCell<JobCosting>('Margin %', (row) => (
      <span className={marginTone(row.grossMargin)}>
        {row.revenueActual === 0 ? '—' : formatPercent(row.grossMarginPct)}
      </span>
    )),
  ];

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4">
      {query.isError ? (
        <Alert className="border-destructive/40 bg-destructive/5">
          <AlertTriangle aria-hidden="true" />
          <span>
            {query.error instanceof ApiError
              ? query.error.message
              : 'Could not load the profitability register.'}
          </span>
        </Alert>
      ) : (
        <>
          {rows.length > 0 && (
            <div className="flex flex-wrap gap-x-8 gap-y-2 rounded-lg border bg-card px-4 py-3 text-sm">
              <Summary label="Jobs" value={formatNumber(rows.length)} />
              <Summary label="Approved hours" value={formatNumber(totals.hours)} />
              <Summary label="Revenue" value={formatZar(totals.revenue)} />
              <Summary label="Cost" value={formatZar(totals.cost)} />
              <Summary
                label="Margin"
                value={formatZar(totals.margin)}
                tone={marginTone(totals.margin)}
              />
            </div>
          )}

          <DataTable
            data={rows}
            columns={columns}
            rowKey={(row) => row.jobId}
            searchKeys={[
              'job.workOrder',
              'job.area',
              'job.description',
              'job.projectCode',
              'job.clientName',
            ]}
            searchPlaceholder="Search by work order, area, project or client…"
            caption="Job labour profitability"
            emptyMessage={
              withHoursOnly
                ? 'No jobs have approved hours yet. Approve a timesheet week to see its cost here.'
                : 'No jobs match the current search.'
            }
            isLoading={query.isLoading}
            actions={
              <Button
                size="sm"
                variant={withHoursOnly ? 'default' : 'outline'}
                aria-pressed={withHoursOnly}
                onClick={() => setWithHoursOnly((current) => !current)}
              >
                Jobs with hours only
              </Button>
            }
          />
        </>
      )}
    </section>
  );
}

function Summary({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span className="flex flex-col">
      <span className="text-xs tracking-wide text-muted-foreground uppercase">{label}</span>
      <span className={tone ?? 'font-medium tabular-nums'}>{value}</span>
    </span>
  );
}
