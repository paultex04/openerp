'use client';

/**
 * The selected job's header: identity, status, and inline-editable detail fields.
 *
 * ## Status is a dropdown, and that is deliberate
 *
 * The brief for this screen was a live system where jobs move through stages
 * constantly, so status had to be one control rather than a stepper walked through
 * several clicks. A dropdown with every legal target is the right shape for that.
 *
 * It is still the *state machine*, not a free text field. The list is built from
 * `GET /api/jobs/:id/transitions`, which returns each legal target with `allowed`
 * and a `reason`. Illegal targets are rendered but disabled, and the reason is the
 * tooltip - so a user who does not understand why a move is unavailable can find
 * out without a 409. Everything routes through `POST /api/jobs/:id/transition`,
 * which re-authorises per step. The dropdown is a convenience over that endpoint,
 * never a replacement for it.
 *
 * Changing status may also move `actualStartDate` / `actualEndDate` (the machine
 * sets them on entry to the WIP and Actuals stages), so the panel refetches the job
 * rather than assuming only the status changed.
 *
 * ## Inline editing
 *
 * Detail fields edit in place. Each control is a text input or select that PATCHes
 * `PATCH /api/jobs/:id` on blur or change. Status is excluded because it has its own
 * endpoint and its own rules - see above.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { X } from 'lucide-react';
import { jobPriorityValues } from '@openerp/shared';
import { api, ApiError, type JobDetail, type TransitionOption } from '@/lib/api';
import { JOB_STATUSES } from '@/components/operations/statusOrder';
import { StatusPill } from '@/components/lifecycle/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { formatPercent } from '@/lib/format';

type Job = JobDetail['job'];
type Permissions = JobDetail['permissions'];

export function JobSummaryPanel({
  job,
  permissions,
  onChanged,
  onClose,
}: {
  job: Job;
  permissions: Permissions;
  onChanged: () => void;
  onClose: () => void;
}) {
  // One mutation for every inline editor below, so the toast wording, the error
  // handling and the cache invalidation are decided once. A per-field component
  // that forgot to invalidate would leave the panel showing a value the server had
  // already rejected, which is worse than not editing inline at all.
  const save = useJobPatch(job.id, onChanged);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold">Job #{job.id}</h2>
            <StatusPill status={job.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {job.project.code} · {job.project.contract.number} · {job.project.contract.client.name}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close job details">
          <X aria-hidden="true" className="size-4" />
          Close
        </Button>
      </div>

      <CommercialBasis job={job} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Job references</CardTitle>
            <CardDescription>Orders and location — the identifiers on the job.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2">
              <EditableText
                label="Work order"
                value={job.workOrder}
                save={save}
                body={(next) => ({ workOrder: next || null })}
              />
              <EditableText
                label="Purchase order"
                value={job.purchaseOrder}
                save={save}
                body={(next) => ({ purchaseOrder: next || null })}
              />
              <EditableText
                label="Area"
                value={job.area}
                save={save}
                body={(next) => ({ area: next || null })}
              />
              <PrioritySelect job={job} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Schedule</CardTitle>
            <CardDescription>Planned windows and actual dates from the field.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2">
              <EditableDate
                label="Planned start"
                value={job.plannedStartDate}
                save={save}
                body={(next) => ({ plannedStartDate: next || null })}
              />
              <EditableDate
                label="Planned end"
                value={job.plannedEndDate}
                save={save}
                body={(next) => ({ plannedEndDate: next || null })}
              />
              <EditableDate
                label="Actual start"
                value={job.actualStartDate}
                save={save}
                body={(next) => ({ actualStartDate: next || null })}
              />
              <EditableDate
                label="Actual end"
                value={job.actualEndDate}
                save={save}
                body={(next) => ({ actualEndDate: next || null })}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      <StatusControl
        job={job}
        availableTransitions={permissions.availableTransitions}
        onChanged={onChanged}
      />

      <JobFacts job={job} />
    </section>
  );
}

/** ------------------------------------------------------------------------- */

function CommercialBasis({ job }: { job: Job }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 py-3 text-xs">
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
      </CardContent>
    </Card>
  );
}

/**
 * Status as a single dropdown of the state machine's legal targets.
 *
 * Every one of the thirteen statuses is listed. The four that are not reachable
 * from the current one are shown disabled with the server's reason as their tooltip,
 * rather than hidden: a status list that silently omits four entries reads as a bug,
 * and hiding them makes the machine's shape undiscoverable.
 */
function StatusControl({
  job,
  availableTransitions,
  onChanged,
}: {
  job: Job;
  availableTransitions: string[];
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();

  const transitions = useQuery({
    queryKey: ['job-transitions', job.id],
    queryFn: () =>
      api.get<{ from: string; transitions: TransitionOption[] }>(`/api/jobs/${job.id}/transitions`),
  });

  const move = useMutation({
    mutationFn: (to: string) => api.post(`/api/jobs/${job.id}/transition`, { status: to }),
    onSuccess: (_result, to) => {
      toast.add({ title: `Moved to ${to}`, type: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['job-transitions', job.id] });
      onChanged();
    },
    onError: (error: Error) =>
      toast.add({
        title: 'Could not change status',
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      }),
  });

  const options = transitions.data?.transitions ?? [];
  // While loading, or if the endpoint returns nothing, disable the control rather
  // than offering one that silently does nothing. `availableTransitions` is the
  // cheaper signal: it arrives with the job, so a terminal job is disabled
  // immediately instead of after a second round trip.
  const ready = options.length > 0 || availableTransitions.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lifecycle</CardTitle>
        <CardDescription>Move the job through its workflow stages.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <label htmlFor={`status-${job.id}`} className="text-sm font-medium">
          Status
        </label>
        <select
          id={`status-${job.id}`}
          value={job.status}
          disabled={!ready || move.isPending || availableTransitions.length === 0}
          onChange={(event) => {
            const next = event.target.value;
            if (next !== job.status) move.mutate(next);
          }}
          aria-describedby={`status-help-${job.id}`}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
        >
          {JOB_STATUSES.map((status) => {
            const isCurrent = status === job.status;
            // The endpoint returns the machine's *legal neighbours* from the current
            // stage — not all thirteen statuses annotated. So absence is the
            // meaningful case: a status not in the response is not reachable at all.
            //
            // Getting this backwards would mark all twelve unreachable statuses
            // enabled, which is how the first version of this control rendered: a
            // dropdown that offered every stage and let the server 409 on nine of
            // them. Absence must mean disabled.
            const option = options.find((t) => t.to === status);
            const allowed = isCurrent || (option ? option.allowed : false);
            return (
              <option key={status} value={status} disabled={!allowed} title={option?.reason}>
                {status}
                {option && !option.allowed ? ` — ${option.reason}` : ''}
              </option>
            );
          })}
        </select>
        <span id={`status-help-${job.id}`} className="text-xs text-muted-foreground">
          {transitions.isError
            ? 'Could not load the allowed transitions; the control is disabled.'
            : availableTransitions.length === 0
              ? // A terminal stage. Saying so is more useful than a permanently
                // greyed-out box, which reads as a bug.
                `${job.status} is a terminal stage — there is nowhere to move it to.`
              : ready
                ? 'Only stages the workflow allows from here are selectable.'
                : 'Loading transitions…'}
        </span>
      </CardContent>
    </Card>
  );
}

/** ------------------------------------------------------------------------- */

function JobFacts({ job }: { job: Job }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Team &amp; scope</CardTitle>
        <CardDescription>Who is doing the work and what it covers.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Fact
            label="Supervisor"
            value={
              job.supervisor ? `${job.supervisor.name} ${job.supervisor.surname}` : 'Unassigned'
            }
          />
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
          <Fact label="Description" value={job.description ?? '—'} />
        </dl>
      </CardContent>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words" title={value}>
        {value}
      </dd>
    </div>
  );
}

/** ------------------------------------------------------------------------- */

/**
 * The shared PATCH behind every inline editor.
 *
 * Returns a mutation whose variables are `{ body, label }`, so each editor supplies
 * only its own payload and the human name used in a failure toast.
 */
function useJobPatch(jobId: number, onChanged: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ body }: { body: Record<string, unknown>; label: string }) =>
      api.patch(`/api/jobs/${jobId}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      onChanged();
    },
    onError: (error: Error, variables) =>
      toast.add({
        title: `Could not save ${variables.label.toLowerCase()}`,
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      }),
  });
}

type JobPatch = ReturnType<typeof useJobPatch>;

/** A text field that PATCHes on blur or Enter, and reverts on Escape. */
function EditableText({
  label,
  value,
  save,
  body,
}: {
  label: string;
  value: string | null;
  save: JobPatch;
  body: (next: string) => Record<string, unknown>;
}) {
  // The draft carries the server value it was seeded from, so a refetch can be
  // detected by comparison during render rather than with an effect.
  //
  // This is React's "adjusting state when a prop changes" pattern, and it is used
  // instead of `useEffect` deliberately: an effect that syncs state runs *after* the
  // render that showed the stale value, so the field visibly flickers from the old
  // value to the new one. Here the first frame is already correct.
  //
  // An in-progress edit wins: someone typing must not have the text pulled out from
  // under them by an unrelated refetch, which is what the `dirty` flag is for.
  const [draft, setDraft] = useState({ server: value ?? '', text: value ?? '', dirty: false });
  if (draft.server !== (value ?? '') && !draft.dirty) {
    setDraft({ server: value ?? '', text: value ?? '', dirty: false });
  }
  const commit = (next: string) => setDraft({ server: next, text: next, dirty: false });

  return (
    <div className="space-y-1.5">
      <label htmlFor={`f-${label}`} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Input
        id={`f-${label}`}
        value={draft.text}
        onChange={(event) => setDraft({ ...draft, text: event.target.value, dirty: true })}
        onBlur={() => {
          // Escape already reverted, so a blur after it must not re-save.
          if (draft.dirty) {
            save.mutate({ body: body(draft.text), label });
            commit(draft.text);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            // Revert rather than save: Escape means "leave this alone".
            setDraft({ server: value ?? '', text: value ?? '', dirty: false });
            event.currentTarget.blur();
          }
        }}
        className="h-8 font-mono text-xs"
      />
    </div>
  );
}

function EditableDate({
  label,
  value,
  save,
  body,
}: {
  label: string;
  value: string | null;
  save: JobPatch;
  body: (next: string) => Record<string, unknown>;
}) {
  // Same render-time adjustment as `EditableText`; see the comment there.
  const [draft, setDraft] = useState({ server: value ?? '', text: value ?? '', dirty: false });
  if (draft.server !== (value ?? '') && !draft.dirty) {
    setDraft({ server: value ?? '', text: value ?? '', dirty: false });
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={`d-${label}`} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Input
        id={`d-${label}`}
        type="date"
        value={draft.text}
        onChange={(event) => setDraft({ ...draft, text: event.target.value, dirty: true })}
        onBlur={() => {
          if (draft.dirty) {
            save.mutate({ body: body(draft.text), label });
            setDraft({ server: draft.text, text: draft.text, dirty: false });
          }
        }}
        className="h-8 text-xs"
      />
    </div>
  );
}

function PrioritySelect({ job }: { job: Job }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  const save = useMutation({
    mutationFn: (priority: string) => api.patch(`/api/jobs/${job.id}`, { priority }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['job', job.id] });
      toast.add({ title: 'Priority updated', type: 'success' });
    },
    onError: (error: Error) =>
      toast.add({
        title: 'Could not update priority',
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      }),
    onSettled: () => setPending(false),
  });

  // From the shared schema, not re-typed here: the labels carry the exact
  // punctuation the API validates against ('P1 - Emergency / Breakdown', not
  // 'P1 Emergency'). A hand-written list drifted once already and every priority
  // save failed validation. Widened to `string` because the server may know a
  // value this build does not — handled by the fallback option below.
  const priorities: readonly string[] = jobPriorityValues;

  return (
    <div className="space-y-1.5">
      <label htmlFor={`prio-${job.id}`} className="text-xs font-medium text-muted-foreground">
        Priority
      </label>
      <select
        id={`prio-${job.id}`}
        value={job.priority}
        disabled={pending}
        onChange={(event) => {
          setPending(true);
          save.mutate(event.target.value);
        }}
        className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
      >
        {/* Keep a value the server knows about but this list omits, rather than
            silently coercing it to the first option on render. */}
        {!priorities.includes(job.priority) && <option value={job.priority}>{job.priority}</option>}
        {priorities.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
    </div>
  );
}
