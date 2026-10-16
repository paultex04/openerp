'use client';

/**
 * The job's Details tab: inline-editable metadata and the status control.
 *
 * The job's identity (its number, status pill and commercial basis) is rendered by
 * the tab host in `job-detail.tsx`, above the tab bar, so it stays on screen while
 * a user is on the Timesheets or Financials tab. This panel is the Details tab's
 * body: the fields you edit.
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
 *
 * ## Shape
 *
 * The panel is three cards - job & area, orders & people, timeline & workflow -
 * over a status bar and a facts strip: what this job is, who and what it is
 * attached to, when it runs, and where it stands. Same controls, same save
 * mechanics. The commercial-basis pill above the tabs is a read-out, not a second
 * editor.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api, ApiError, type JobDetail, type TransitionOption } from '@/lib/api';
import { SectionHeading } from '@/components/lifecycle/status-badge';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { usePermissions } from '@/components/auth/usePermissions';
import { useJobWorkflow } from '@/hooks/use-job-workflow';

type Job = JobDetail['job'];
type Permissions = JobDetail['permissions'];

export function JobSummaryPanel({
  job,
  permissions,
  onChanged,
}: {
  job: Job;
  permissions: Permissions;
  onChanged: () => void;
}) {
  // One mutation for every inline editor below, so the toast wording, the error
  // handling and the cache invalidation are decided once. A per-field component
  // that forgot to invalidate would leave the panel showing a value the server had
  // already rejected, which is worse than not editing inline at all.
  const { can } = usePermissions();
  const save = useJobPatch(job.id, onChanged);
  const contacts = useQuery({
    queryKey: ['job-contact-options', job.project.contract.client.id],
    queryFn: () =>
      api.get<{
        contacts: Array<{ id: number; name: string; email: string | null; mobile: string | null }>;
      }>('/api/contacts', { clientId: job.project.contract.client.id, includeArchived: true }),
    enabled: Boolean(job.project.contract.client.id) && can('contact.read'),
  });
  const amendments = useQuery({
    queryKey: ['job-amendment-options', job.project.contract.id],
    queryFn: () =>
      api.get<{ amendments: Array<{ id: number; amendmentNumber: string }> }>('/api/amendments', {
        contractId: job.project.contract.id,
      }),
    enabled: can('amendment.read'),
  });
  const employees = useQuery({
    queryKey: ['job-supervisor-options'],
    queryFn: () =>
      api.get<{ employees: Array<{ id: number; name: string; surname: string }> }>(
        '/api/employees',
      ),
    enabled: can('employee.read'),
  });

  return (
    <section className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-3">
        <FieldCard title="Job & area">
          <EditableText
            label="Description"
            value={job.description}
            save={save}
            body={(next) => ({ description: next || null })}
            disabled={!permissions.canEditJob}
          />
          <EditableText
            label="Area"
            value={job.area}
            save={save}
            body={(next) => ({ area: next || null })}
            disabled={!permissions.canEditJob}
          />
          <PrioritySelect job={job} canEdit={permissions.canEditJob} />
        </FieldCard>

        <FieldCard title="Orders & people">
          <EditableText
            label="Work order"
            value={job.workOrder}
            save={save}
            body={(next) => ({ workOrder: next || null })}
            disabled={!permissions.canEditJob}
            mono
          />
          <EditableDate
            label="WO received"
            value={job.workOrderReceivedDate}
            save={save}
            body={(next) => ({ workOrderReceivedDate: next || null })}
            disabled={!permissions.canEditJob}
          />
          <EditableText
            label="Purchase order"
            value={job.purchaseOrder}
            save={save}
            body={(next) => ({ purchaseOrder: next || null })}
            disabled={!permissions.canEditJob}
            mono
          />
          <EditableDate
            label="PO received"
            value={job.purchaseOrderReceivedDate}
            save={save}
            body={(next) => ({ purchaseOrderReceivedDate: next || null })}
            disabled={!permissions.canEditJob}
          />
          {can('employee.read') ? (
            <SupervisorSelect
              job={job}
              canEdit={permissions.canEditJob}
              employees={employees.data?.employees ?? []}
              save={save}
            />
          ) : (
            <ReadOnlyField
              label="Supervisor"
              value={
                job.supervisor ? `${job.supervisor.name} ${job.supervisor.surname}` : 'Unassigned'
              }
            />
          )}
          {can('contact.read') ? (
            <ContactSelect
              job={job}
              canEdit={permissions.canEditJob}
              contacts={contacts.data?.contacts ?? []}
              save={save}
            />
          ) : (
            <ReadOnlyField label="Client contact" value={job.clientContact?.name ?? 'Unassigned'} />
          )}
        </FieldCard>

        <FieldCard title="Timeline & workflow">
          <EditableDate
            label="Planned start"
            value={job.plannedStartDate}
            save={save}
            body={(next) => ({ plannedStartDate: next || null })}
            disabled={!permissions.canEditJob}
          />
          <EditableDate
            label="Planned end"
            value={job.plannedEndDate}
            save={save}
            body={(next) => ({ plannedEndDate: next || null })}
            disabled={!permissions.canEditJob}
          />
          <EditableDate
            label="Actual start"
            value={job.actualStartDate}
            save={save}
            body={(next) => ({ actualStartDate: next || null })}
            disabled={!permissions.canEditJob}
          />
          <EditableDate
            label="Actual end"
            value={job.actualEndDate}
            save={save}
            body={(next) => ({ actualEndDate: next || null })}
            disabled={!permissions.canEditJob}
          />
          {can('amendment.read') && (
            <SelectField
              label="Amendment"
              value={
                job.amendmentInherited ? '' : job.amendmentId == null ? '' : String(job.amendmentId)
              }
              emptyLabel={job.amendmentInherited ? 'Inherited from project' : 'No amendment'}
              disabled={!permissions.canEditJob || amendments.isLoading || save.isPending}
              options={
                amendments.data?.amendments.map((a) => ({
                  value: String(a.id),
                  label: a.amendmentNumber,
                })) ?? []
              }
              onChange={(value) =>
                save.mutate({
                  body: { amendmentId: value ? Number(value) : null },
                  label: 'Amendment',
                })
              }
            />
          )}
        </FieldCard>
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

/**
 * One of the three summary cards: a heading and a stack of labelled controls.
 *
 * Deliberately dumb - every save mechanic lives in the field components, so a
 * card can be rearranged without touching how anything persists.
 */
function FieldCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border p-3">
      <SectionHeading>{title}</SectionHeading>
      <div className="mt-2.5 grid gap-2.5">{children}</div>
    </div>
  );
}

/** ------------------------------------------------------------------------- */

function SupervisorSelect({
  job,
  canEdit,
  employees,
  save,
}: {
  job: Job;
  canEdit: boolean;
  employees: Array<{ id: number; name: string; surname: string }>;
  save: JobPatch;
}) {
  return (
    <SelectField
      label="Supervisor"
      value={job.supervisorId ? String(job.supervisorId) : ''}
      disabled={!canEdit || save.isPending}
      options={employees.map((employee) => ({
        value: String(employee.id),
        label: `${employee.name} ${employee.surname}`,
      }))}
      emptyLabel={
        job.supervisor ? `${job.supervisor.name} ${job.supervisor.surname}` : 'Unassigned'
      }
      onChange={(value) =>
        save.mutate({ body: { supervisorId: value ? Number(value) : null }, label: 'Supervisor' })
      }
    />
  );
}

function ContactSelect({
  job,
  canEdit,
  contacts,
  save,
}: {
  job: Job;
  canEdit: boolean;
  contacts: Array<{ id: number; name: string; email: string | null; mobile: string | null }>;
  save: JobPatch;
}) {
  return (
    <SelectField
      label="Client contact"
      value={job.clientContactId ? String(job.clientContactId) : ''}
      disabled={!canEdit || contacts.length === 0 || save.isPending}
      options={contacts.map((contact) => ({ value: String(contact.id), label: contact.name }))}
      emptyLabel={job.clientContact?.name ?? 'Unassigned'}
      onChange={(value) =>
        save.mutate({
          body: { clientContactId: value ? Number(value) : null },
          label: 'Client contact',
        })
      }
    />
  );
}

function SelectField({
  label,
  value,
  options,
  disabled,
  emptyLabel = 'Inherit / none',
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled: boolean;
  emptyLabel?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`select-${label}`} className="text-[11px] font-medium text-muted-foreground">
        {label}
      </label>
      <select
        id={`select-${label}`}
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs disabled:opacity-60"
      >
        <option value="">{emptyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
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
  const { statuses, label } = useJobWorkflow();

  const transitions = useQuery({
    queryKey: ['job-transitions', job.id],
    queryFn: () =>
      api.get<{ from: string; transitions: TransitionOption[] }>(`/api/jobs/${job.id}/transitions`),
  });

  const move = useMutation({
    // `status` is the field the endpoint reads (`jobTransitionSchema`). Posting
    // `{ to }` here was a long-standing bug — every move 400'd, so the dropdown
    // looked dead. Fixed in Phase 15 alongside the detail-page re-skin.
    mutationFn: (to: string) => api.post(`/api/jobs/${job.id}/transition`, { status: to }),
    onSuccess: (_result, to) => {
      toast.add({ title: `Moved to ${label(to)}`, type: 'success' });
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
    <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
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
        {statuses.map((status) => {
          const isCurrent = status.key === job.status;
          // The endpoint returns the machine's *legal neighbours* from the current
          // stage — not all thirteen statuses annotated. So absence is the
          // meaningful case: a status not in the response is not reachable at all.
          //
          // Getting this backwards would mark all twelve unreachable statuses
          // enabled, which is how the first version of this control rendered: a
          // dropdown that offered every stage and let the server 409 on nine of
          // them. Absence must mean disabled.
          const option = options.find((t) => t.to === status.key);
          const allowed = isCurrent || (option ? option.allowed : false);
          return (
            <option key={status.key} value={status.key} disabled={!allowed} title={option?.reason}>
              {status.label}
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
              `${label(job.status)} is a terminal stage — there is nowhere to move it to.`
            : ready
              ? 'Only stages the workflow allows from here are selectable.'
              : 'Loading transitions…'}
      </span>
    </div>
  );
}

/** ------------------------------------------------------------------------- */

function JobFacts({ job }: { job: Job }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      Planned {formatDate(job.plannedStartDate)} → {formatDate(job.plannedEndDate)} · Actual{' '}
      {formatDate(job.actualStartDate)} → {formatDate(job.actualEndDate)} · Crew:{' '}
      {job.assignments.length === 0
        ? 'None assigned'
        : job.assignments
            .map((a) => `${a.employee.name} ${a.employee.surname}${a.role ? ` (${a.role})` : ''}`)
            .join(', ')}
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
    onError: (error: Error, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      onChanged();
      toast.add({
        title: `Could not save ${variables.label.toLowerCase()}`,
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      });
    },
  });
}

type JobPatch = ReturnType<typeof useJobPatch>;

/** A text field that PATCHes on blur or Enter, and reverts on Escape. */
function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {/* Dashed while its editable twin is solid: a read-only field should look
          like the same control, parked. */}
      <span
        className="flex h-8 items-center truncate rounded-md border border-dashed px-2 text-xs"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function EditableText({
  label,
  value,
  save,
  body,
  disabled = false,
  mono = false,
}: {
  label: string;
  value: string | null;
  save: JobPatch;
  body: (next: string) => Record<string, unknown>;
  disabled?: boolean;
  /** Identifiers (work order, purchase order) read as code; prose does not. */
  mono?: boolean;
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
    <div className="flex flex-col gap-1">
      <label htmlFor={`f-${label}`} className="text-[11px] font-medium text-muted-foreground">
        {label}
      </label>
      <Input
        id={`f-${label}`}
        disabled={disabled}
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
        className={cn('h-8 text-xs', mono && 'font-mono')}
      />
    </div>
  );
}

function EditableDate({
  label,
  value,
  save,
  body,
  disabled = false,
}: {
  label: string;
  value: string | null;
  save: JobPatch;
  body: (next: string) => Record<string, unknown>;
  disabled?: boolean;
}) {
  // Same render-time adjustment as `EditableText`; see the comment there.
  const [draft, setDraft] = useState({ server: value ?? '', text: value ?? '', dirty: false });
  if (draft.server !== (value ?? '') && !draft.dirty) {
    setDraft({ server: value ?? '', text: value ?? '', dirty: false });
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`d-${label}`} className="text-[11px] font-medium text-muted-foreground">
        {label}
      </label>
      <Input
        id={`d-${label}`}
        disabled={disabled}
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

function PrioritySelect({ job, canEdit }: { job: Job; canEdit: boolean }) {
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

  const priorities = ['P1 Emergency', 'P2 Urgent', 'P3 Routine Normal', 'P4 Low'];

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`prio-${job.id}`} className="text-[11px] font-medium text-muted-foreground">
        Priority
      </label>
      <select
        id={`prio-${job.id}`}
        value={job.priority}
        disabled={pending || !canEdit}
        onChange={(event) => {
          setPending(true);
          save.mutate(event.target.value);
        }}
        className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
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
