'use client';

/**
 * Job lifecycle stepper / board.
 *
 * Renders the 13 statuses in pipeline order and offers only the transitions the
 * server says are permitted. The UI never decides legality itself — it renders
 * what `/api/jobs/:id/transitions` returns, which is the same state machine the
 * API enforces. That keeps a rule from ever being "true in the UI, false on the
 * server".
 */
import { useMutation } from '@tanstack/react-query';
import { JOB_STATUSES } from '@/components/operations/statusOrder';
import { statusVariant } from '@/lib/lifecycle-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { api, ApiError, type TransitionOption } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * The forward path, excluding the terminal `00. Cancelled`.
 *
 * Kept as an explicit list rather than filtering inline so the reason a status
 * is absent is documented where the omission happens.
 */
const PIPELINE = JOB_STATUSES.filter(
  (s): s is Exclude<(typeof JOB_STATUSES)[number], '00. Cancelled'> => s !== '00. Cancelled',
);

interface Props {
  jobId: number;
  currentStatus: string;
  transitions: TransitionOption[];
  onTransitioned?: () => void;
}

export function JobStepper({ jobId, currentStatus, transitions, onTransitioned }: Props) {
  const move = useMutation({
    mutationFn: (to: string) => api.post(`/api/jobs/${jobId}/transition`, { status: to }),
    onSuccess: () => {
      toast.add({ title: 'Job status updated', type: 'success' });
      onTransitioned?.();
    },
    onError: (e: Error) =>
      toast.add({
        title: 'Transition refused',
        description: e instanceof ApiError ? e.message : e.message,
        type: 'error',
      }),
  });

  // The API may hand back a status this build does not know about if the server
  // is newer, so guard the index lookup rather than trusting it.
  const currentIndex = PIPELINE.indexOf(currentStatus as (typeof PIPELINE)[number]);
  const permitted = transitions.filter((t) => t.allowed);
  const cancelled = currentStatus === '00. Cancelled';

  return (
    <div className="space-y-4">
      {/* ---- Pipeline ----
       * `00. Cancelled` is deliberately excluded. It is a terminal exit rather
       * than a step on the forward path, and because it sorts first in the label
       * list it would otherwise render as a *completed* bar on every job. */}
      <ol className="flex flex-wrap gap-1" aria-label="Job lifecycle">
        {PIPELINE.map((status, index) => {
          const reached = currentIndex >= 0 && index <= currentIndex;
          const isCurrent = status === currentStatus;
          // 09 loops back to 04, so treat the change-order step as a branch
          // rather than pretending the bar is strictly monotonic.
          const isBranch = status === '09. Awaiting change order';

          return (
            <li key={status} className="min-w-[7.5rem] flex-1">
              <div
                className={cn(
                  'h-1.5 rounded-full',
                  isCurrent
                    ? 'bg-primary'
                    : reached
                      ? 'bg-primary/40'
                      : isBranch
                        ? 'bg-amber-400/50'
                        : 'bg-muted',
                )}
              />
              <p
                className={cn(
                  'mt-1 truncate text-[10px] leading-tight',
                  isCurrent ? 'font-semibold text-foreground' : 'text-muted-foreground',
                )}
                title={status}
              >
                {status}
              </p>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={statusVariant(currentStatus)}>{currentStatus}</Badge>
        {cancelled ? (
          <span className="text-sm text-muted-foreground">
            This job is cancelled. Cancelled is a terminal status, so it has no further transitions.
          </span>
        ) : permitted.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            No further transitions are available to you from this stage.
          </span>
        ) : (
          permitted.map((t) => (
            <Button
              key={t.to}
              size="sm"
              variant={t.to === '00. Cancelled' ? 'destructive' : 'outline'}
              onClick={() => move.mutate(t.to)}
              disabled={move.isPending}
              title={t.reason}
            >
              {t.to === '00. Cancelled' ? 'Cancel job' : `Move to ${t.to}`}
            </Button>
          ))
        )}
      </div>

      {/* ---- Refused transitions, explained rather than hidden ---- */}
      {transitions.some((t) => !t.allowed) && (
        <details className="rounded-md border p-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Why can I not do some of these?
          </summary>
          <ul className="mt-2 space-y-1">
            {transitions
              .filter((t) => !t.allowed)
              .map((t) => (
                <li key={t.to} className="text-muted-foreground">
                  <span className="font-medium">{t.to}</span> — {t.reason}
                  {t.requiredPermission && (
                    <span className="ml-1 opacity-70">({t.requiredPermission})</span>
                  )}
                </li>
              ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * Kanban board: jobs grouped by status.
 *
 * Only statuses that actually contain jobs are shown, otherwise the board would
 * be 13 mostly-empty columns for a handful of active jobs.
 */
export function JobKanban({
  jobs,
  onSelect,
}: {
  jobs: Array<{ id: number; status: string; description: string | null; workOrder: string | null }>;
  onSelect?: (id: number) => void;
}) {
  const groups = JOB_STATUSES.map((status) => ({
    status,
    jobs: jobs.filter((j) => j.status === status),
  })).filter((g) => g.jobs.length > 0);

  if (groups.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        No jobs match the current filter.
      </p>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {groups.map(({ status, jobs: column }) => (
        <div key={status} className="w-56 shrink-0">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="truncate text-xs font-medium" title={status}>
              {status}
            </span>
            <Badge variant="secondary">{column.length}</Badge>
          </div>
          <div className="space-y-2">
            {column.map((job) => (
              <button
                key={job.id}
                type="button"
                onClick={() => onSelect?.(job.id)}
                className="w-full rounded-md border bg-card p-2 text-left text-xs transition-colors hover:bg-accent"
              >
                <span className="block font-medium">#{job.id}</span>
                <span className="block truncate text-muted-foreground">
                  {job.description ?? 'No description'}
                </span>
                {job.workOrder && (
                  <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
                    {job.workOrder}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
