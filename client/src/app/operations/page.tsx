'use client';

/**
 * Operations workspace: project dashboard, job board and job detail.
 *
 * Accessible to any role with `job.read`; field supervisors additionally get
 * their own dedicated view at /field, which is far simpler than this screen and
 * works on a phone.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, type JobDetail, type JobRow, type TransitionOption } from '@/lib/api';
import { JobKanban, JobStepper } from '@/components/operations/JobStepper';
import { DeliverableGrid } from '@/components/operations/DeliverableGrid';
import { ProjectDashboard } from '@/components/operations/ProjectDashboard';
import { JOB_STATUSES } from '@/components/operations/statusOrder';
import { StatusPill } from '@/components/ui/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDate, formatPercent } from '@/lib/format';

type View = 'dashboard' | 'board' | 'job';

export default function OperationsPage() {
  const [view, setView] = useState<View>('dashboard');
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);

  const selectJob = (id: number) => {
    setSelectedJobId(id);
    setView('job');
  };

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
          <p className="text-sm text-muted-foreground">
            Projects, job lifecycle, scoping and field actuals.
          </p>
        </div>
        <nav className="flex gap-1 rounded-md border p-1">
          {(
            [
              ['dashboard', 'Dashboard'],
              ['board', 'Job Board'],
            ] as Array<[View, string]>
          ).map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant={view === key ? 'default' : 'ghost'}
              onClick={() => setView(key)}
            >
              {label}
            </Button>
          ))}
          {selectedJobId && (
            <Button
              size="sm"
              variant={view === 'job' ? 'default' : 'ghost'}
              onClick={() => setView('job')}
            >
              Job #{selectedJobId}
            </Button>
          )}
        </nav>
      </header>

      {view === 'dashboard' && <ProjectDashboard onSelectJob={selectJob} />}
      {view === 'board' && <BoardView onSelectJob={selectJob} />}
      {view === 'job' &&
        (selectedJobId ? (
          <JobDetailView jobId={selectedJobId} onBack={() => setView('board')} />
        ) : (
          <p className="text-sm text-muted-foreground">Select a job to see its detail.</p>
        ))}
    </main>
  );
}

/** ------------------------------------------------------------------------- */

function BoardView({ onSelectJob }: { onSelectJob: (id: number) => void }) {
  const [statusFilter, setStatusFilter] = useState('');

  const jobs = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.get<{ jobs: JobRow[] }>('/api/jobs'),
  });

  const all = jobs.data?.jobs ?? [];
  const filtered = statusFilter ? all.filter((j) => j.status === statusFilter) : all;

  if (jobs.isError) {
    return (
      <p className="text-sm text-destructive">
        {jobs.error instanceof ApiError ? jobs.error.message : 'Could not load jobs.'}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="status" className="text-sm text-muted-foreground">
          Status
        </label>
        <select
          id="status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        >
          <option value="">All statuses</option>
          {JOB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          {filtered.length} job{filtered.length === 1 ? '' : 's'}
        </span>
      </div>

      <JobKanban
        jobs={filtered.map((j) => ({
          id: j.id,
          status: j.status,
          description: j.description,
          workOrder: j.workOrder,
        }))}
        onSelect={onSelectJob}
      />
    </div>
  );
}

/** ------------------------------------------------------------------------- */

function JobDetailView({ jobId, onBack }: { jobId: number; onBack: () => void }) {
  const detail = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.get<JobDetail>(`/api/jobs/${jobId}`),
  });

  const transitions = useQuery({
    queryKey: ['job-transitions', jobId],
    queryFn: () =>
      api.get<{ from: string; transitions: TransitionOption[] }>(`/api/jobs/${jobId}/transitions`),
    enabled: detail.isSuccess,
  });

  if (detail.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading job…</p>;
  }

  if (detail.isError) {
    return (
      <p className="text-sm text-destructive">
        {detail.error instanceof ApiError ? detail.error.message : 'Could not load the job.'}
      </p>
    );
  }

  if (!detail.data) {
    return <p className="text-sm text-muted-foreground">Job not found.</p>;
  }

  const { job, permissions, deliverables, summary } = detail.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold">Job #{job.id}</h2>
            <StatusPill status={job.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {job.project.code} · {job.project.contract.number} · {job.project.contract.client.name}
          </p>
          {job.description && <p className="mt-1 max-w-2xl text-sm">{job.description}</p>}
        </div>
        <Button size="sm" variant="outline" onClick={onBack}>
          Back to board
        </Button>
      </div>

      {/* ---- Amendment basis ---- */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-xs">
        <span className="text-muted-foreground">Commercial basis</span>
        <span className="font-medium">
          {job.amendment?.amendmentNumber ?? '—'} ({job.amendment?.status ?? '—'})
        </span>
        <span className="text-muted-foreground">
          VAT {formatPercent(job.amendment?.vatRate ?? 0)}
        </span>
        {job.amendmentInherited && (
          <Badge
            variant="outline"
            title="This job has no amendment of its own and inherits the project's."
          >
            inherited from project
          </Badge>
        )}
      </div>

      {/* ---- Lifecycle ---- */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Lifecycle</h3>
        <JobStepper
          jobId={job.id}
          currentStatus={job.status}
          transitions={transitions.data?.transitions ?? []}
          onTransitioned={() => {
            void detail.refetch();
            void transitions.refetch();
          }}
        />
      </section>

      {/* ---- Dates and crew ---- */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Work order" value={job.workOrder ?? '—'} />
        <Fact label="Purchase order" value={job.purchaseOrder ?? '—'} />
        <Fact
          label="Planned"
          value={`${formatDate(job.plannedStartDate)} → ${formatDate(job.plannedEndDate)}`}
        />
        <Fact
          label="Actual"
          value={`${formatDate(job.actualStartDate)} → ${formatDate(job.actualEndDate)}`}
        />
        <Fact
          label="Supervisor"
          value={job.supervisor ? `${job.supervisor.name} ${job.supervisor.surname}` : 'Unassigned'}
        />
        <Fact label="Area" value={job.area ?? '—'} />
        <Fact label="Priority" value={job.priority} />
        <Fact
          label="Crew"
          value={
            job.assignments.length === 0
              ? 'None assigned'
              : job.assignments
                  .map(
                    (a) =>
                      `${a.employee.name} ${a.employee.surname}${a.role ? ` (${a.role})` : ''}`,
                  )
                  .join(', ')
          }
        />
      </section>

      {/* ---- Deliverables ---- */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Deliverables</h3>
        <DeliverableGrid
          deliverables={deliverables}
          summary={summary}
          canEditPlanned={permissions.canEditPlanned}
          plannedLockReason={permissions.plannedLockReason}
          canEditActuals={permissions.canEditActuals}
          actualsLockReason={permissions.actualsLockReason}
          onChanged={() => void detail.refetch()}
        />
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-sm" title={value}>
        {value}
      </p>
    </div>
  );
}
