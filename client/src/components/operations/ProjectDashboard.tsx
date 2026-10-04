'use client';

/**
 * Project overview dashboard.
 *
 * Shows active work, pipeline position and financial exposure so a PM can see
 * where money and risk sit without drilling into every job.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import { api, ApiError, type ProjectDetail, type ProjectRow } from '@/lib/api';
import { JOB_STATUSES } from '@/components/operations/statusOrder';
import { StatusPill, varianceTone } from '@/components/lifecycle/status-badge';
import { DataTable } from '@/components/data-table/data-table';
import { Button } from '@/components/ui/button';
import { formatDate, formatZar } from '@/lib/format';

function Metric({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${tone ?? ''}`}>{value}</p>
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Days between two dates, negative when overdue. Null-safe. */
function daysBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Math.round(ms / 86_400_000);
}

/** Statuses that stop a job counting as overdue - it is finished or abandoned. */
const SETTLED = ['10. Invoiced', '11. Partially Invoiced', '00. Cancelled'];

type ProjectJob = NonNullable<ProjectDetail['project']['jobs']>[number];

/**
 * A job is overdue when its planned end has passed and it has not settled.
 *
 * `now` is passed in rather than read from the clock: `Date.now()` inside a cell
 * renderer is an impure read that would change every time the table re-sorted,
 * and would make the overdue set drift while the page is open.
 */
function isOverdue(job: ProjectJob, now: number): boolean {
  if (!job.plannedEndDate) return false;
  if (SETTLED.includes(job.status)) return false;
  return new Date(job.plannedEndDate).getTime() < now;
}

export function ProjectDashboard({ onSelectJob }: { onSelectJob: (id: number) => void }) {
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: ProjectRow[] }>('/api/projects'),
  });

  const projectsData = projects.data?.projects ?? [];

  // Totals across every project, so the dashboard reads as one picture.
  const totals = projectsData.reduce(
    (acc, p) => {
      acc.jobs += p.jobs.length;
      for (const status of JOB_STATUSES)
        acc.byStatus[status] = (acc.byStatus[status] ?? 0) + (p.statusCounts[status] ?? 0);
      return acc;
    },
    { jobs: 0, byStatus: {} as Record<string, number> },
  );

  const activeStatuses = [
    '01. Scoping',
    '01A. Scoped',
    '02. Awaiting PO',
    '03. WNYS',
    '04. WIP',
    '05. Work Complete',
    '06. Actuals in Progress',
  ];

  return (
    <div className="space-y-6">
      {/* ---- Headline metrics ---- */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Projects" value={String(projectsData.length)} />
        <Metric label="Jobs" value={String(totals.jobs)} />
        <Metric
          label="Active in execution"
          value={String(activeStatuses.reduce((sum, s) => sum + (totals.byStatus[s] ?? 0), 0))}
          hint="Scoping through actuals"
        />
        <Metric
          label="Awaiting pack or signature"
          value={String(
            (totals.byStatus['07. Pack Ready'] ?? 0) +
              (totals.byStatus['08. Out for signature'] ?? 0),
          )}
          hint="With billing"
        />
      </div>

      {projects.isError && (
        <p className="text-sm text-destructive">
          {projects.error instanceof ApiError ? projects.error.message : 'Could not load projects.'}
        </p>
      )}

      {/* ---- Pipeline ---- */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Pipeline</h2>
        <div className="flex flex-wrap gap-2">
          {JOB_STATUSES.filter((s) => (totals.byStatus[s] ?? 0) > 0).map((status) => (
            <div key={status} className="rounded-md border px-3 py-2">
              <p className="text-[10px] text-muted-foreground">{status}</p>
              <p className="text-lg font-semibold tabular-nums">{totals.byStatus[status]}</p>
            </div>
          ))}
          {totals.jobs === 0 && <p className="text-sm text-muted-foreground">No jobs yet.</p>}
        </div>
      </section>

      {/* ---- Projects ---- */}
      {projectsData.map((project) => (
        <ProjectCard key={project.id} project={project} onSelectJob={onSelectJob} />
      ))}
    </div>
  );
}

function ProjectCard({
  project,
  onSelectJob,
}: {
  project: ProjectRow;
  onSelectJob: (id: number) => void;
}) {
  /**
   * "Now", captured once.
   *
   * Calling `Date.now()` inside render is an impure read, which React's compiler
   * flags and which would also recompute on every unrelated re-render. Freezing it
   * in state means the overdue highlighting is stable for the life of the card.
   */
  const [statusFilter, setStatusFilter] = useState('');
  const [overdueFilter, setOverdueFilter] = useState('');

  const [now] = useState(() => Date.now());

  const detail = useQuery({
    queryKey: ['project', project.id],
    queryFn: () => api.get<ProjectDetail>(`/api/projects/${project.id}`),
  });

  const exposure = detail.data?.project.exposure;

  // Built inside the component because the cells close over `now` and
  // `onSelectJob`. Memoised on those two identities, both stable.
  const jobColumns = useMemo<ColumnDef<ProjectJob, unknown>[]>(
    () => [
      {
        id: 'id',
        accessorKey: 'id',
        header: 'Job',
        cell: ({ row }) => (
          <span className="flex items-baseline gap-1">
            <button
              type="button"
              onClick={() => onSelectJob(row.original.id)}
              className="font-medium hover:underline"
            >
              #{row.original.id}
            </button>
            {row.original.workOrder && (
              <span className="font-mono text-[10px] text-muted-foreground">
                {row.original.workOrder}
              </span>
            )}
          </span>
        ),
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <span>
            <StatusPill status={row.original.status} />
            <span className="mt-0.5 block text-[10px] text-muted-foreground">
              {row.original.priority}
            </span>
          </span>
        ),
      },
      {
        id: 'plannedEndDate',
        accessorKey: 'plannedEndDate',
        header: 'Schedule',
        cell: ({ row }) => {
          const job = row.original;
          const plannedDays = daysBetween(job.plannedStartDate, job.plannedEndDate);
          return (
            <span className="text-xs whitespace-nowrap">
              <span className={isOverdue(job, now) ? 'font-medium text-negative' : ''}>
                {formatDate(job.plannedStartDate)} → {formatDate(job.plannedEndDate)}
              </span>
              {plannedDays !== null && (
                <span className="block text-[10px] text-muted-foreground">{plannedDays} days</span>
              )}
            </span>
          );
        },
      },
      {
        id: 'description',
        accessorKey: 'description',
        header: 'Description',
        cell: ({ row }) => (
          <span className="block max-w-[12rem] truncate" title={row.original.description ?? ''}>
            {row.original.description ?? '-'}
          </span>
        ),
      },
      {
        id: 'plannedSubtotal',
        accessorKey: 'plannedSubtotal',
        header: 'Planned',
        meta: { align: 'right' },
        cell: ({ row }) => formatZar(row.original.plannedSubtotal),
      },
      {
        id: 'actualSubtotal',
        accessorKey: 'actualSubtotal',
        header: 'Actual',
        meta: { align: 'right' },
        cell: ({ row }) => formatZar(row.original.actualSubtotal),
      },
      {
        id: 'valueVariance',
        accessorKey: 'valueVariance',
        header: 'Variance',
        meta: { align: 'right' },
        cell: ({ row }) => (
          <span className={varianceTone(row.original.valueVariance)}>
            {row.original.valueVariance > 0 ? '+' : ''}
            {formatZar(row.original.valueVariance)}
          </span>
        ),
      },
    ],
    [now, onSelectJob],
  );

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">
            <Link href={`/operations?project=${project.id}`} className="hover:underline">
              {project.code}
            </Link>
            <span className="ml-2 font-normal text-muted-foreground">{project.year}</span>
          </h2>
          <p className="text-xs text-muted-foreground">
            {project.contract.number} · {project.contract.client.name} ·{' '}
            {project.amendment.amendmentNumber} ({project.amendment.status})
          </p>
          {project.description && (
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{project.description}</p>
          )}
        </div>
        {exposure && (
          <div className="text-right text-xs">
            <p className="text-muted-foreground">Exposure</p>
            <p className="font-mono text-sm tabular-nums">{formatZar(exposure.actualSubtotal)}</p>
            <p className={`font-mono tabular-nums ${varianceTone(exposure.valueVariance)}`}>
              {exposure.valueVariance > 0 ? '+' : ''}
              {formatZar(exposure.valueVariance)}
            </p>
          </div>
        )}
      </div>

      {detail.isLoading && <p className="text-xs text-muted-foreground">Loading jobs…</p>}

      {/*
        A project with two dozen jobs is a register, not a summary, so this gets
        search, filters and sorting. The overdue flag is carried into a filter
        because "which of these are late?" is the question this table is opened
        to answer.
      */}
      <DataTable
        caption={`Jobs on project ${detail.data?.project.code ?? ''}`}
        fill
        data={detail.data?.project.jobs ?? []}
        columns={jobColumns}
        rowKey={(job) => job.id}
        searchKeys={['description', 'workOrder', 'status', 'priority']}
        searchPlaceholder="Search job, work order or description…"
        isLoading={detail.isLoading}
        initialSort={[{ id: 'id', desc: false }]}
        emptyMessage="No jobs on this project match the current search and filters."
        filters={[
          {
            id: 'status',
            label: 'Stage',
            value: statusFilter,
            options: [
              { value: '', label: 'All stages' },
              ...[...new Set((detail.data?.project.jobs ?? []).map((job) => job.status))].map(
                (status) => ({ value: status, label: status }),
              ),
            ],
            onChange: setStatusFilter,
            predicate: (job, selected) => job.status === selected,
          },
          {
            id: 'overdue',
            label: 'Schedule',
            value: overdueFilter,
            options: [
              { value: '', label: 'Any' },
              { value: 'overdue', label: 'Overdue' },
              { value: 'on-time', label: 'Not overdue' },
            ],
            onChange: setOverdueFilter,
            predicate: (job, selected) => isOverdue(job, now) === (selected === 'overdue'),
          },
        ]}
        renderRowActions={(job) => (
          <Button size="sm" variant="ghost" onClick={() => onSelectJob(job.id)}>
            Open
          </Button>
        )}
      />
    </section>
  );
}
