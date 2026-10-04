'use client';

/**
 * Field supervisor view.
 *
 * Built for a phone on site: one job per card, large touch targets for the two
 * actions a supervisor actually performs — recording a measured quantity and
 * advancing the job — and nothing else. Deliberately omits planning controls,
 * pricing detail and financial summaries, none of which are the supervisor's
 * concern and all of which would be noise at arm's length in the field.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, type FieldJob } from '@/lib/api';
import { StatusPill, varianceTone } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { formatDate, formatNumber, formatZar, formatZarRate } from '@/lib/format';

export default function FieldPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const work = useQuery({
    queryKey: ['field-work'],
    queryFn: () => api.get<{ jobs: FieldJob[] }>('/api/field/my-work'),
  });

  const recordActual = useMutation({
    mutationFn: ({ id, quantity }: { id: number; quantity: number }) =>
      api.patch(`/api/job-deliverables/${id}/actual`, { actualQuantity: quantity }),
    onSuccess: () => {
      toast({ title: 'Actual recorded', variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['field-work'] });
    },
    onError: (e: Error) =>
      toast({
        title: 'Could not record',
        description: e instanceof ApiError ? e.message : e.message,
        variant: 'destructive',
      }),
  });

  const advance = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api.post(`/api/jobs/${id}/transition`, { status }),
    onSuccess: () => {
      toast({ title: 'Job advanced', variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['field-work'] });
    },
    onError: (e: Error) =>
      toast({
        title: 'Could not advance the job',
        description: e instanceof ApiError ? e.message : e.message,
        variant: 'destructive',
      }),
  });

  if (work.isLoading) {
    return <p className="p-6 text-center text-sm text-muted-foreground">Loading your work…</p>;
  }

  if (work.isError) {
    return (
      <p className="p-6 text-center text-sm text-destructive">
        {work.error instanceof ApiError ? work.error.message : 'Could not load your work.'}
      </p>
    );
  }

  const jobs = work.data?.jobs ?? [];

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-4">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">My work</h1>
        <p className="text-sm text-muted-foreground">
          {jobs.length} job{jobs.length === 1 ? '' : 's'} assigned to you.
        </p>
      </header>

      {jobs.length === 0 && (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Nothing is assigned to you yet.
        </p>
      )}

      {jobs.map((job) => (
        <JobCard
          key={job.id}
          job={job}
          onRecord={(id, quantity) => recordActual.mutate({ id, quantity })}
          onAdvance={(status) => advance.mutate({ id: job.id, status })}
          busy={recordActual.isPending || advance.isPending}
        />
      ))}
    </main>
  );
}

function JobCard({
  job,
  onRecord,
  onAdvance,
  busy,
}: {
  job: FieldJob;
  onRecord: (id: number, quantity: number) => void;
  onAdvance: (status: string) => void;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(job.deliverables.length > 0);

  return (
    <article className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">Job #{job.id}</h2>
            <StatusPill status={job.status} />
          </div>
          <p className="truncate text-sm text-muted-foreground">
            {job.project.code} · {job.description ?? job.project.contract.number}
          </p>
          {job.workOrder && (
            <p className="font-mono text-xs text-muted-foreground">WO {job.workOrder}</p>
          )}
          {job.area && <p className="text-xs text-muted-foreground">{job.area}</p>}
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded-md border px-3 py-2 text-sm"
          aria-expanded={expanded}
        >
          {expanded ? 'Hide' : 'Show'} ({job.deliverables.length})
        </button>
      </div>

      {/* ---- Advance the job ---- */}
      {job.permissions.availableTransitions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {job.permissions.availableTransitions
            .filter((t) => t !== '00. Cancelled')
            .map((t) => (
              <Button
                key={t}
                size="sm"
                onClick={() => onAdvance(t)}
                disabled={busy}
                className="min-h-11"
              >
                {t}
              </Button>
            ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Nothing for you to action at this stage.</p>
      )}

      {/* ---- Actuals ---- */}
      {expanded && (
        <div className="space-y-2">
          {job.deliverables.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing scoped on this job.</p>
          )}

          {job.deliverables.map((line) => (
            <div key={line.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="min-w-0">
                  <span className="block font-mono text-xs">{line.code}</span>
                  <span className="block truncate text-sm">{line.description}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatZarRate(line.appliedRate)}/{line.uom}
                </span>
              </div>

              <div className="mt-2 flex items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">
                  Planned{' '}
                  <span className="font-mono tabular-nums">
                    {formatNumber(line.plannedQuantity)}
                  </span>
                </span>
                <span className={varianceTone(line.quantityVariance)}>
                  {line.quantityVariance > 0 ? '+' : ''}
                  {formatNumber(line.quantityVariance)}
                </span>
              </div>

              <ActualInput
                disabled={!job.permissions.canEditActuals || busy}
                hint={job.permissions.actualsLockReason}
                value={line.actualQuantity}
                onSave={(quantity) => onRecord(line.id, quantity)}
              />

              <p className="mt-1 text-right text-sm">
                <span className="text-muted-foreground">Actual </span>
                <span className="font-mono tabular-nums">{formatZar(line.actualSubtotal)}</span>
                <span className={`ml-2 font-mono tabular-nums ${varianceTone(line.valueVariance)}`}>
                  ({line.valueVariance > 0 ? '+' : ''}
                  {formatZar(line.valueVariance)})
                </span>
              </p>
            </div>
          ))}

          <p className="text-right text-sm text-muted-foreground">
            Job total{' '}
            <span className="font-mono tabular-nums">{formatZar(job.summary.actualSubtotal)}</span>
          </p>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Started {formatDate(job.actualStartDate)} · ended {formatDate(job.actualEndDate)}
      </p>
    </article>
  );
}

/** Large, forgiving quantity input sized for gloved hands. */
function ActualInput({
  value,
  disabled,
  hint,
  onSave,
}: {
  value: number;
  disabled: boolean;
  hint: string | null;
  onSave: (quantity: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const dirty = draft !== null && Number(draft) !== value;

  if (disabled) {
    return (
      <p className="mt-2 text-xs text-muted-foreground" title={hint ?? undefined}>
        Actuals locked at this stage.
      </p>
    );
  }

  return (
    <div className="mt-2 flex items-center gap-2">
      <input
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Actual quantity"
        className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-right font-mono text-lg tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {dirty && (
        <Button
          size="sm"
          className="min-h-11"
          onClick={() => {
            onSave(Number(draft));
            setDraft(null);
          }}
        >
          Save
        </Button>
      )}
    </div>
  );
}
