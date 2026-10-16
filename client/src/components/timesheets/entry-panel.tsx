'use client';

/**
 * Enter time — pick the employee, pick the week, fill the grid.
 *
 * This replaced a self-service "My time" screen when the workflow changed: hours
 * are now always recorded *for a selected employee*, and the cost is that
 * employee's own hourly rate. The person doing the recording is the supervisor,
 * the PM or the administrator, not necessarily the person whose week it is.
 *
 * The picker is populated from `GET /api/timesheets/employees`, which the server
 * scopes: a holder of `timesheet.write` sees the whole crew, a `write.own` holder
 * sees only themselves. Nothing here decides that — the list is simply whatever
 * the caller is allowed to record against.
 *
 * A week that has not been started is not created by looking at it. The empty
 * state offers an explicit "Open this week", because a GET that writes a row is a
 * surprise and a POST that a viewer with no write permission cannot make should
 * fail at the click, not on page load.
 *
 * An **approved** week is editable here too, by an approver: that is the
 * amend-in-place path. Each corrected line is re-frozen as it is saved, and the
 * audit log keeps the before/after. Reopening (also here, for an approver) is the
 * other path — it returns the week to draft so the whole thing is re-approved.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Plus, Send, Undo2 } from 'lucide-react';
import {
  api,
  ApiError,
  type TimesheetEmployee,
  type TimesheetEntryView,
  type TimesheetSummary,
  type TimesheetView,
} from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { useDebounced } from '@/hooks/use-debounced';
import { EntryDialog, type EntryCell } from './entry-dialog';
import { TimesheetStatusBadge } from './status-badge';
import { WeekGrid } from './week-grid';
import { addDays, currentMonday, formatWeek } from './weeks';
import { formatNumber, formatZar } from '@/lib/format';

const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none';

export function TimesheetEntryPanel() {
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<string | null>(null);
  const activePeriod = period ?? currentMonday();

  const [employeeSearch, setEmployeeSearch] = useState('');
  const debouncedSearch = useDebounced(employeeSearch.trim(), 250);
  const [employeeId, setEmployeeId] = useState<number | null>(null);

  const employees = useQuery({
    queryKey: ['timesheet-employees', debouncedSearch],
    queryFn: () =>
      api.get<{ employees: TimesheetEmployee[] }>('/api/timesheets/employees', {
        search: debouncedSearch || undefined,
        limit: 200,
      }),
  });

  const employeeOptions = employees.data?.employees ?? [];
  const selected = employeeOptions.find((employee) => employee.id === employeeId) ?? null;

  // Default to the signed-in user's own record once the list arrives, unless a
  // search has filtered it out.
  useEffect(() => {
    if (employeeId !== null) return;
    const self = employeeOptions.find((employee) => employee.isSelf);
    if (self) setEmployeeId(self.id);
  }, [employeeId, employeeOptions]);

  const existing = useQuery({
    queryKey: ['timesheet-week', employeeId, activePeriod],
    queryFn: () =>
      api.get<{ timesheets: TimesheetSummary[] }>('/api/timesheets', {
        employeeId: employeeId ?? undefined,
        from: activePeriod,
        to: activePeriod,
        limit: 5,
      }),
    enabled: employeeId !== null,
    select: (data) => data.timesheets[0] ?? null,
  });

  const timesheetId = existing.data?.id ?? null;
  const detail = useQuery({
    queryKey: ['timesheet', timesheetId],
    queryFn: () => api.get<{ timesheet: TimesheetView }>(`/api/timesheets/${timesheetId}`),
    enabled: timesheetId !== null,
  });
  const timesheet = detail.data?.timesheet ?? null;

  const [notes, setNotes] = useState('');
  useEffect(() => {
    setNotes(timesheet?.notes ?? '');
  }, [timesheet?.id, timesheet?.notes]);

  const [dialog, setDialog] = useState<{
    cell: EntryCell | null;
    entry: TimesheetEntryView | null;
  } | null>(null);
  const [reopenOpen, setReopenOpen] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['timesheet'] });
    void queryClient.invalidateQueries({ queryKey: ['timesheets'] });
    void queryClient.invalidateQueries({ queryKey: ['timesheet-week'] });
    void queryClient.invalidateQueries({ queryKey: ['costing'] });
  };

  const openWeek = useMutation({
    mutationFn: () =>
      api.post<{ timesheet: TimesheetView }>('/api/timesheets', {
        employeeId: employeeId ?? undefined,
        periodStart: activePeriod,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['timesheet', data.timesheet.id], data);
      toast.add({ title: 'Week opened', type: 'success' });
      refresh();
    },
    onError: (caught) =>
      toast.add({
        title: 'Could not open the week',
        description: caught instanceof ApiError ? caught.message : undefined,
        type: 'error',
      }),
  });

  const saveNotes = useMutation({
    mutationFn: () =>
      api.patch<{ timesheet: TimesheetView }>(`/api/timesheets/${timesheet!.id}`, {
        notes: notes.trim() === '' ? null : notes.trim(),
      }),
    onSuccess: () => {
      toast.add({ title: 'Notes saved', type: 'success' });
      refresh();
    },
    onError: (caught) =>
      toast.add({
        title: 'Could not save notes',
        description: caught instanceof ApiError ? caught.message : undefined,
        type: 'error',
      }),
  });

  const submit = useMutation({
    mutationFn: () =>
      api.post<{ timesheet: TimesheetView }>(`/api/timesheets/${timesheet!.id}/submit`),
    onSuccess: () => {
      toast.add({ title: 'Week submitted for approval', type: 'success' });
      refresh();
    },
    onError: (caught) =>
      toast.add({
        title: 'Could not submit the week',
        description: caught instanceof ApiError ? caught.message : undefined,
        type: 'error',
      }),
  });

  const shiftWeek = (days: number) => setPeriod(addDays(activePeriod, days));

  const editable = Boolean(timesheet?.canEdit);
  const amending = Boolean(timesheet?.canAmend);
  const draft = timesheet?.status === 'Draft' || timesheet?.status === 'Rejected';

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field className="min-w-64 flex-1">
          <FieldLabel htmlFor="timesheet-employee-search">Employee</FieldLabel>
          <Input
            id="timesheet-employee-search"
            type="search"
            value={employeeSearch}
            onChange={(event) => setEmployeeSearch(event.target.value)}
            placeholder="Filter by name…"
            autoComplete="off"
          />
        </Field>
        <Field className="min-w-64 flex-1">
          <FieldLabel htmlFor="timesheet-employee">Recording time for</FieldLabel>
          <select
            id="timesheet-employee"
            value={employeeId ?? ''}
            onChange={(event) =>
              setEmployeeId(event.target.value === '' ? null : Number(event.target.value))
            }
            className={selectClass}
          >
            <option value="">Select an employee…</option>
            {employeeOptions.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name} {employee.surname}
                {employee.isSelf ? ' (you)' : ''}
                {employee.hasRate ? '' : ' — no rate set'}
              </option>
            ))}
          </select>
        </Field>
        {selected && (
          <p className="pb-2 text-sm text-muted-foreground">
            Cost rate{' '}
            <span className="font-medium text-foreground">
              {selected.hasRate ? `${formatZar(selected.rate ?? 0)}/h` : 'not set'}
            </span>
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous week"
            onClick={() => shiftWeek(-7)}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPeriod(currentMonday())}>
            This week
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next week"
            onClick={() => shiftWeek(7)}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          <span className="ml-1 text-sm font-medium">
            {formatWeek(activePeriod, addDays(activePeriod, 6))}
          </span>
        </div>

        {timesheet && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <TimesheetStatusBadge status={timesheet.status} />
            <span className="text-muted-foreground">
              {formatNumber(timesheet.totals.hours)} h ·{' '}
              <span className="font-medium text-foreground">
                {formatZar(timesheet.totals.cost)}
              </span>
            </span>
          </div>
        )}
      </div>

      {timesheet?.status === 'Rejected' && (
        <Alert className="border-destructive/40 bg-destructive/5">
          <AlertTriangle aria-hidden="true" />
          <span>
            This week was returned
            {timesheet.decidedBy ? ` by ${timesheet.decidedBy.email}` : ''}
            {timesheet.decisionNote ? `: ${timesheet.decisionNote}` : '.'} Edit the lines and submit
            it again.
          </span>
        </Alert>
      )}

      {amending && (
        <Alert>
          <Undo2 aria-hidden="true" />
          <span>
            This week is approved. Correcting a line re-prices and re-freezes it immediately, and
            the change is recorded in the audit log. To edit the whole week instead, reopen it.
          </span>
        </Alert>
      )}

      {timesheet && timesheet.totals.unpricedLines > 0 && (
        <Alert className="border-warning/40 bg-warning/5">
          <AlertTriangle aria-hidden="true" />
          <span>
            {timesheet.totals.unpricedLines} line
            {timesheet.totals.unpricedLines === 1 ? '' : 's'} cannot be priced — this employee has
            no hourly cost rate set. The week cannot be approved until{' '}
            {timesheet.totals.unpricedLines === 1 ? 'it is' : 'they are'} priced.
          </span>
        </Alert>
      )}

      {employeeId === null ? (
        <div className="rounded-lg border bg-card p-8">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Select an employee</EmptyTitle>
              <EmptyDescription>
                Choose whose hours you are recording before opening a week.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : existing.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : !timesheet ? (
        <div className="rounded-lg border bg-card p-8">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No timesheet for this week</EmptyTitle>
              <EmptyDescription>
                Open the week to start recording hours against jobs.
              </EmptyDescription>
            </EmptyHeader>
            <Button
              onClick={() => openWeek.mutate()}
              disabled={openWeek.isPending || (selected !== null && !selected.hasRate)}
            >
              Open this week
            </Button>
          </Empty>
        </div>
      ) : detail.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {editable
                ? 'Click a cell to add or edit the hours for that job and day.'
                : 'This week is locked. An approver can reopen it if a change is needed.'}
            </p>
            {editable && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDialog({ cell: null, entry: null })}
                >
                  <Plus aria-hidden="true" className="size-4" />
                  Add line
                </Button>
                {draft && (
                  <Button
                    size="sm"
                    onClick={() => submit.mutate()}
                    disabled={submit.isPending || timesheet.entries.length === 0}
                  >
                    <Send aria-hidden="true" className="size-4" />
                    Submit for approval
                  </Button>
                )}
                {timesheet.status === 'Approved' && (
                  <Button variant="outline" size="sm" onClick={() => setReopenOpen(true)}>
                    <Undo2 aria-hidden="true" className="size-4" />
                    Reopen for editing
                  </Button>
                )}
              </div>
            )}
          </div>

          <WeekGrid
            periodStart={timesheet.periodStart}
            entries={timesheet.entries}
            {...(editable
              ? {
                  onCellClick: (cell, cellEntries) =>
                    setDialog({ cell, entry: cellEntries[0] ?? null }),
                }
              : {})}
          />

          {draft && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-64 flex-1 flex-col gap-1.5 text-sm">
                <span className="text-muted-foreground">Notes for the approver</span>
                <Input
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  maxLength={2000}
                  placeholder="Anything the approver should know about this week"
                />
              </label>
              <Button
                variant="outline"
                size="sm"
                onClick={() => saveNotes.mutate()}
                disabled={saveNotes.isPending || notes === (timesheet.notes ?? '')}
              >
                Save notes
              </Button>
            </div>
          )}

          {!editable && timesheet.decisionNote && (
            <p className="text-sm text-muted-foreground">
              Approver's note: <span className="text-foreground">{timesheet.decisionNote}</span>
            </p>
          )}
        </>
      )}

      {timesheet && (
        <EntryDialog
          open={dialog !== null}
          onOpenChange={(next) => !next && setDialog(null)}
          timesheet={timesheet}
          employeeRate={selected?.rate ?? null}
          cell={dialog?.cell ?? null}
          entry={dialog?.entry ?? null}
          onSaved={refresh}
        />
      )}

      {timesheet && (
        <ReopenDialog
          open={reopenOpen}
          onOpenChange={setReopenOpen}
          timesheetId={timesheet.id}
          onDone={refresh}
        />
      )}
    </section>
  );
}

/** Reopening needs a reason — it is the audited way back from an approved week. */
function ReopenDialog({
  open,
  onOpenChange,
  timesheetId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  timesheetId: number;
  onDone: () => void;
}) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setNote('');
      setError(null);
    }
  }, [open]);

  const reopen = useMutation({
    mutationFn: () =>
      api.post<{ timesheet: TimesheetView }>(`/api/timesheets/${timesheetId}/reopen`, {
        note: note.trim(),
      }),
    onSuccess: () => {
      toast.add({ title: 'Week reopened for editing', type: 'success' });
      onDone();
      onOpenChange(false);
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not reopen the week.'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reopen this week</DialogTitle>
          <DialogDescription>
            The week returns to draft and its frozen cost is lifted, so it can be corrected and
            re-approved. The reason is recorded in the audit log.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="reopen-reason">Reason (required)</FieldLabel>
          <Input
            id="reopen-reason"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={500}
          />
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={reopen.isPending || note.trim() === ''}
            onClick={() => reopen.mutate()}
          >
            Reopen for editing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
