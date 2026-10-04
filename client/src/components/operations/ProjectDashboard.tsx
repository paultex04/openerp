'use client';

/**
 * Project overview dashboard.
 *
 * Shows active work, pipeline position and financial exposure so a PM can see
 * where money and risk sit without drilling into every job.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type ProjectDetail, type ProjectRow } from '@/lib/api';
import { JOB_STATUSES } from '@/components/operations/statusOrder';
import { StatusPill, varianceTone } from '@/components/lifecycle/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { NumericCell } from '@/components/data-table/NumericCell';
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
  const [now] = useState(() => Date.now());

  const detail = useQuery({
    queryKey: ['project', project.id],
    queryFn: () => api.get<ProjectDetail>(`/api/projects/${project.id}`),
  });

  const exposure = detail.data?.project.exposure;

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

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Job</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Schedule</TableHead>
            <TableHead scope="col" className="hidden xl:table-cell">
              Description
            </TableHead>
            <TableHead scope="col" className="text-right">
              Planned
            </TableHead>
            <TableHead scope="col" className="text-right">
              Actual
            </TableHead>
            <TableHead scope="col" className="text-right">
              Variance
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(detail.data?.project.jobs ?? []).map((job) => {
            const plannedDays = daysBetween(job.plannedStartDate, job.plannedEndDate);
            const overdue =
              job.plannedEndDate !== null &&
              new Date(job.plannedEndDate).getTime() < now &&
              !['10. Invoiced', '11. Partially Invoiced', '00. Cancelled'].includes(job.status);

            return (
              <TableRow key={job.id}>
                <TableCell>
                  <button
                    type="button"
                    onClick={() => onSelectJob(job.id)}
                    className="font-medium hover:underline"
                  >
                    #{job.id}
                  </button>
                  {job.workOrder && (
                    <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                      {job.workOrder}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <StatusPill status={job.status} />
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">
                    {job.priority}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  <span className={overdue ? 'font-medium text-negative' : ''}>
                    {formatDate(job.plannedStartDate)} → {formatDate(job.plannedEndDate)}
                  </span>
                  {plannedDays !== null && (
                    <span className="block text-[10px] text-muted-foreground">
                      {plannedDays} days
                    </span>
                  )}
                </TableCell>
                <TableCell className="hidden xl:table-cell">
                  <span className="block max-w-[12rem] truncate" title={job.description ?? ''}>
                    {job.description ?? '—'}
                  </span>
                </TableCell>
                <NumericCell>{formatZar(job.plannedSubtotal)}</NumericCell>
                <NumericCell>{formatZar(job.actualSubtotal)}</NumericCell>
                <NumericCell className={varianceTone(job.valueVariance)}>
                  {job.valueVariance > 0 ? '+' : ''}
                  {formatZar(job.valueVariance)}
                </NumericCell>
              </TableRow>
            );
          })}
          {(detail.data?.project.jobs ?? []).length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground">
                No jobs on this project.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </section>
  );
}
