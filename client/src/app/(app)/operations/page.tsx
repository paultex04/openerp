'use client';

/**
 * Operations workspace: project dashboard, job board and job detail.
 *
 * Accessible to any role with `job.read`; field supervisors additionally get
 * their own dedicated view at /field, which is far simpler than this screen and
 * works on a phone.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  ApiError,
  type JobDetail,
  type JobRow,
  type TransitionOption,
  type VarianceSummary,
} from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { JobKanban, JobStepper } from '@/components/operations/JobStepper';
import { DeliverableGrid } from '@/components/operations/DeliverableGrid';
import { CrewPanel } from '@/components/operations/CrewPanel';
import { ProjectDashboard } from '@/components/operations/ProjectDashboard';
import { JOB_STATUSES } from '@/components/operations/statusOrder';
import { StatusPill } from '@/components/lifecycle/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useUrlParam } from '@/hooks/use-url-param';
import { formatDate, formatPercent, formatZar } from '@/lib/format';

type View = 'dashboard' | 'board' | 'job';

/** The board's status filter: a job status, or empty for "all". */
type StatusFilter = '' | (typeof JOB_STATUSES)[number];

/** Whitelist for the `view` query parameter. `job` is reachable only by selecting. */
const VIEW_KEYS: readonly View[] = ['dashboard', 'board'];

export default function OperationsPage() {
  // URL-backed so the sidebar can link straight to a view, and so "Valuation
  // Packs" can deep-link into a pre-filtered board.
  const [view, setView] = useUrlParam<View>('view', VIEW_KEYS, 'dashboard');
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);

  // Selecting a job is not a URL state: it is a drill-down that always resolves
  // back to the board, so it stays local rather than becoming a shareable link.
  const selectJob = (id: number) => {
    setSelectedJobId(id);
    setView('job');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
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
    </div>
  );
}

/** ------------------------------------------------------------------------- */

function BoardView({ onSelectJob }: { onSelectJob: (id: number) => void }) {
  // '' means "no filter", which is not one of JOB_STATUSES, so the empty string is
  // admitted as an explicit member of the whitelist rather than special-cased.
  const [statusFilter, setStatusFilter] = useUrlParam<StatusFilter>(
    'status',
    ['', ...JOB_STATUSES],
    '',
  );

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
        {/*
          A native <select> rather than the shadcn wrapper. `ui/select.tsx` as
          generated exports SelectGroup/SelectValue/SelectTrigger/SelectContent/
          SelectItem but no root `Select`, so adopting it would mean importing
          Base UI's root directly and hand-assembling the parts. That is a larger
          change than this filter justifies, and a native select is fully
          keyboard- and screen-reader-accessible on its own.
          See ADR-006, finding F3.
        */}
        <select
          id="status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
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

      {/* ---- Crew assignments (Phase 7, closes ADR-006 D4) ---- */}
      <CrewPanel
        jobId={job.id}
        assignments={job.assignments}
        canAssign={permissions.canAssign}
        onChanged={() => void detail.refetch()}
      />

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

      {/* ---- Billing ---- */}
      <JobBilling job={job} summary={summary} onChanged={() => void detail.refetch()} />
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

/** Job statuses from which billing will accept an invoice. Mirrors the API. */
const BILLABLE_STATUSES = new Set([
  '07. Pack Ready',
  '08. Out for signature',
  '09. Awaiting change order',
  '10. Invoiced',
  '11. Partially Invoiced',
]);

/**
 * The billing hand-off on a job: what has been invoiced, and the button that
 * raises a draft from the measured actuals.
 *
 * The button is offered only from `07. Pack Ready` onward and the reason is
 * always visible — the API enforces the same rule and returns 409 with this
 * explanation, so hiding it without explanation would leave a billing clerk
 * guessing. Generation takes no financial input: every figure is derived from
 * this job's actuals and the amendment.
 */
function JobBilling({
  job,
  summary,
  onChanged,
}: {
  job: JobDetail['job'];
  summary: VarianceSummary;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();

  const generate = useMutation({
    mutationFn: () => api.post(`/api/jobs/${job.id}/invoices`, {}),
    onSuccess: (result) => {
      const outcome = result as {
        invoice: { invoiceNumber: string };
        compliance: { ok: boolean; warnings: string[] };
      };
      toast.add({
        title: `Draft ${outcome.invoice.invoiceNumber} raised`,
        description: outcome.compliance.ok
          ? undefined
          : `Compliance: ${outcome.compliance.warnings.join(' ')}`,
        type: outcome.compliance.ok ? 'success' : 'info',
      });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      onChanged();
    },
    onError: (e: Error) =>
      toast.add({
        title: 'Could not raise an invoice',
        description: e instanceof ApiError ? e.message : e.message,
        type: 'error',
      }),
  });

  const billable = BILLABLE_STATUSES.has(job.status);
  const hasMeasured = summary.linesWithActuals > 0;

  return (
    <section className="space-y-3 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Billing</h3>
        <Button
          size="sm"
          onClick={() => generate.mutate()}
          disabled={!billable || !hasMeasured || generate.isPending}
        >
          Raise draft invoice
        </Button>
      </div>

      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span>
          Measured actuals{' '}
          <span className="font-mono tabular-nums text-foreground">
            {formatZar(summary.actualSubtotal)}
          </span>
        </span>
        <span>
          {summary.linesWithActuals} of {summary.lineCount} deliverables measured
        </span>
      </div>

      {!billable && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
          Billing takes ownership at 07. Pack Ready. This job is at {job.status}, so an invoice
          cannot be raised yet — revenue is not recognised against work whose scope is still being
          planned or executed.
        </p>
      )}

      {billable && !hasMeasured && (
        <p className="text-xs text-muted-foreground">
          Nothing to bill yet: no deliverable on this job has a measured actual. Actuals are
          recorded during 04. WIP to 06. Actuals in Progress.
        </p>
      )}

      {billable && hasMeasured && (
        <p className="text-xs text-muted-foreground">
          The draft bills every measured deliverable at its applied-rate snapshot and adds VAT from{' '}
          {job.amendment?.amendmentNumber ?? 'the contract'} amendment. Review it in Billing before
          submitting.
        </p>
      )}
    </section>
  );
}
