'use client';

/**
 * Create, edit or delete one timesheet line.
 *
 * A line is hours on one job, on one day, of one labour type and shift — the same
 * shape the API validates. The dialog is opened from a grid cell (creating, or
 * editing the single line already in that cell) or from the week's "Add line"
 * button.
 *
 * Two things it deliberately does not do:
 *
 *  - It does not offer a date outside the week. The seven days are the only
 *    options, so the `DATE_OUTSIDE_WEEK` the server would raise is unreachable
 *    from here.
 *  - It does not silently omit a rate problem. A line with no resolvable rate is
 *    still saved (the grid marks it unpriced and approval will refuse it), but the
 *    override controls are only shown to someone who may actually use them.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type JobDetail,
  type LoggableJob,
  type RateCardResponse,
  type ShiftType,
  type TimesheetEntryView,
  type TimesheetView,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { usePermissions } from '@/components/auth/usePermissions';
import { useDebounced } from '@/hooks/use-debounced';
import { formatZar } from '@/lib/format';
import { SHIFT_TYPES, formatDay, jobLabel, weekDays } from './weeks';

const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none';

export interface EntryCell {
  jobId: number;
  labourType: string;
  shiftType: ShiftType;
  workDate: string;
}

export function EntryDialog({
  open,
  onOpenChange,
  timesheet,
  employeeRate = null,
  cell,
  entry,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  timesheet: TimesheetView;
  /** The selected employee's hourly cost rate; null when they have none. */
  employeeRate?: number | null;
  /** The cell that was clicked, when creating. */
  cell?: EntryCell | null;
  /** The line being edited, when one already exists. */
  entry?: TimesheetEntryView | null;
  onSaved: () => void;
}) {
  const { can } = usePermissions();
  const days = weekDays(timesheet.periodStart);

  const [jobSearch, setJobSearch] = useState('');
  const debouncedSearch = useDebounced(jobSearch.trim(), 250);
  const [jobId, setJobId] = useState<number | null>(null);
  const [labourType, setLabourType] = useState('');
  const [shiftType, setShiftType] = useState<ShiftType>('NT');
  const [workDate, setWorkDate] = useState(timesheet.periodStart);
  const [hours, setHours] = useState('');
  const [isBillable, setIsBillable] = useState(true);
  const [notes, setNotes] = useState('');
  const [jobServiceCodeId, setJobServiceCodeId] = useState<number | null>(null);
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [overrideRate, setOverrideRate] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form whenever the dialog opens on a different target. Doing this
  // in an effect rather than at first render is what lets one dialog instance
  // serve every cell without the parent remounting it.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setJobSearch('');
    if (entry) {
      setJobId(entry.jobId);
      setLabourType(entry.labourType);
      setShiftType(entry.shiftType);
      setWorkDate(entry.workDate);
      setHours(String(entry.hours));
      setIsBillable(entry.isBillable);
      setNotes(entry.notes ?? '');
      setJobServiceCodeId(entry.jobServiceCodeId);
      setOverrideEnabled(entry.costRateOverride !== null);
      setOverrideRate(entry.costRateOverride !== null ? String(entry.costRateOverride) : '');
      setOverrideReason(entry.overrideReason ?? '');
    } else {
      setJobId(cell?.jobId ?? null);
      setLabourType(cell?.labourType ?? '');
      setShiftType(cell?.shiftType ?? 'NT');
      setWorkDate(cell?.workDate ?? timesheet.periodStart);
      setHours('');
      setIsBillable(true);
      setNotes('');
      setJobServiceCodeId(null);
      setOverrideEnabled(false);
      setOverrideRate('');
      setOverrideReason('');
    }
  }, [open, entry, cell, timesheet.periodStart]);

  const jobs = useQuery({
    queryKey: ['timesheet-jobs', debouncedSearch],
    queryFn: () =>
      api.get<{ jobs: LoggableJob[] }>('/api/timesheets/jobs', {
        search: debouncedSearch || undefined,
        limit: 50,
      }),
    enabled: open,
  });

  // The entry's own job is merged in below so editing a line whose job fell
  // outside the 50-row page still shows its name rather than an empty select.
  const jobOptions: LoggableJob[] = jobs.data?.jobs ?? [];
  const effectiveJobId = jobId ?? entry?.jobId ?? null;
  const rateCard = useQuery({
    queryKey: ['timesheet-rate-card', effectiveJobId],
    queryFn: () => api.get<RateCardResponse>('/api/costing/rates', { jobId: effectiveJobId }),
    enabled: open && effectiveJobId !== null,
  });

  const jobDetail = useQuery({
    queryKey: ['job', effectiveJobId],
    queryFn: () => api.get<JobDetail>(`/api/jobs/${effectiveJobId}`),
    enabled: open && effectiveJobId !== null && can('job.read'),
  });

  const labourTypes = [
    ...new Set((rateCard.data?.rates ?? []).map((rate) => rate.labourType)),
  ].sort();
  const deliverables = jobDetail.data?.deliverables ?? [];

  const save = useMutation({
    mutationFn: async () => {
      if (effectiveJobId === null) throw new ApiError(400, 'JOB_REQUIRED', 'Choose a job.');
      const body: Record<string, unknown> = {
        jobId: effectiveJobId,
        jobServiceCodeId,
        workDate,
        labourType: labourType.trim(),
        shiftType,
        hours: Number(hours),
        isBillable,
        notes: notes.trim() === '' ? null : notes.trim(),
      };
      // Only sent by someone who may override; omitting them leaves an existing
      // override untouched rather than tripping the permission check on a plain
      // hours edit.
      if (can('timesheet.override')) {
        body.costRateOverride = overrideEnabled ? Number(overrideRate) : null;
        body.overrideReason = overrideEnabled ? overrideReason.trim() : null;
      }
      return entry
        ? api.patch<TimesheetView>(`/api/timesheet-entries/${entry.id}`, body)
        : api.post<TimesheetView>(`/api/timesheets/${timesheet.id}/entries`, body);
    },
    onSuccess: () => {
      toast.add({ title: entry ? 'Line updated' : 'Line added', type: 'success' });
      onSaved();
      onOpenChange(false);
    },
    onError: (caught) => {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the line.');
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete<TimesheetView>(`/api/timesheet-entries/${entry!.id}`),
    onSuccess: () => {
      toast.add({ title: 'Line removed', type: 'success' });
      onSaved();
      onOpenChange(false);
    },
    onError: (caught) => {
      setError(caught instanceof ApiError ? caught.message : 'Could not remove the line.');
    },
  });

  // A quarter-hour at minimum, and never more than a day: the same rules the
  // schema enforces, applied here so the button is disabled rather than failing.
  const hoursNumber = Number(hours);
  const hoursValid =
    hours.trim() !== '' &&
    Number.isFinite(hoursNumber) &&
    hoursNumber >= 0.25 &&
    hoursNumber <= 24 &&
    Math.abs(hoursNumber / 0.25 - Math.round(hoursNumber / 0.25)) < 1e-9;
  const canSave =
    effectiveJobId !== null &&
    labourType.trim() !== '' &&
    hoursValid &&
    (!overrideEnabled || (overrideRate.trim() !== '' && overrideReason.trim() !== '')) &&
    !save.isPending;

  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{entry ? 'Edit line' : 'Add line'}</DialogTitle>
          <DialogDescription>
            Hours on one job, for one day. Each hour is costed at this employee's own rate
            {employeeRate !== null ? ` (${formatZar(employeeRate)}/h)` : ''}. If no rate is set the
            line is saved but shown as unpriced, and the week cannot be approved.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto pr-1">
          <Field>
            <FieldLabel htmlFor="entry-job-search">Job</FieldLabel>
            <Input
              id="entry-job-search"
              type="search"
              value={jobSearch}
              onChange={(event) => setJobSearch(event.target.value)}
              placeholder="Filter jobs by work order, area or project…"
              autoComplete="off"
            />
            <select
              aria-label="Job"
              value={effectiveJobId ?? ''}
              onChange={(event) => {
                setJobId(event.target.value === '' ? null : Number(event.target.value));
                setJobServiceCodeId(null);
              }}
              className={selectClass}
            >
              <option value="">Select a job…</option>
              {jobOptions.map((job) => (
                <option key={job.id} value={job.id}>
                  {jobLabel(job)} · {job.projectCode}
                </option>
              ))}
              {entry?.job &&
              effectiveJobId !== null &&
              !jobOptions.some((job) => job.id === effectiveJobId) ? (
                <option value={effectiveJobId}>{jobLabel(entry.job)}</option>
              ) : null}
            </select>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="entry-labour">Labour type</FieldLabel>
              <Input
                id="entry-labour"
                list="entry-labour-options"
                value={labourType}
                onChange={(event) => setLabourType(event.target.value)}
                placeholder="e.g. Fitter"
                autoComplete="off"
              />
              <datalist id="entry-labour-options">
                {labourTypes.map((type) => (
                  <option key={type} value={type} />
                ))}
              </datalist>
              <FieldDescription>
                {labourTypes.length > 0
                  ? 'Suggested from this job’s rate card. The employee’s hourly rate sets the cost.'
                  : 'Free text. The employee’s hourly rate sets the cost.'}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="entry-shift">Shift</FieldLabel>
              <select
                id="entry-shift"
                value={shiftType}
                onChange={(event) => setShiftType(event.target.value as ShiftType)}
                className={selectClass}
              >
                {SHIFT_TYPES.map((shift) => (
                  <option key={shift} value={shift}>
                    {shift}
                  </option>
                ))}
              </select>
            </Field>

            <Field>
              <FieldLabel htmlFor="entry-date">Day</FieldLabel>
              <select
                id="entry-date"
                value={workDate}
                onChange={(event) => setWorkDate(event.target.value)}
                className={selectClass}
              >
                {days.map((day) => (
                  <option key={day.date} value={day.date}>
                    {formatDay(day.date)}
                  </option>
                ))}
              </select>
            </Field>

            <Field>
              <FieldLabel htmlFor="entry-hours">Hours</FieldLabel>
              <Input
                id="entry-hours"
                type="number"
                inputMode="decimal"
                step="0.25"
                min="0.25"
                max="24"
                value={hours}
                onChange={(event) => setHours(event.target.value)}
              />
              <FieldDescription>
                Quarter-hour steps, up to 24.
                {employeeRate !== null && hoursValid
                  ? ` Costs ${formatZar(employeeRate * hoursNumber)} at the employee’s rate.`
                  : ''}
              </FieldDescription>
            </Field>
          </div>

          {deliverables.length > 0 && (
            <Field>
              <FieldLabel htmlFor="entry-deliverable">Deliverable (optional)</FieldLabel>
              <select
                id="entry-deliverable"
                value={jobServiceCodeId ?? ''}
                onChange={(event) =>
                  setJobServiceCodeId(event.target.value === '' ? null : Number(event.target.value))
                }
                className={selectClass}
              >
                <option value="">Not linked to a deliverable</option>
                {deliverables.map((line) => (
                  <option key={line.id} value={line.id}>
                    {line.code} — {line.description}
                  </option>
                ))}
              </select>
              <FieldDescription>
                Linking a line to a deliverable attributes the hours to that line of work. Job-level
                margin is reported either way.
              </FieldDescription>
            </Field>
          )}

          <Field>
            <FieldLabel htmlFor="entry-notes">Notes (optional)</FieldLabel>
            <Input
              id="entry-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={500}
            />
          </Field>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isBillable}
              onChange={(event) => setIsBillable(event.target.checked)}
              className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
            Billable to the client
          </label>

          {can('timesheet.override') && (
            <Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={overrideEnabled}
                  onChange={(event) => setOverrideEnabled(event.target.checked)}
                  className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                />
                Override the cost rate for this line
              </label>
              {overrideEnabled && (
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="entry-override-rate">Cost rate (ZAR/hour)</FieldLabel>
                    <Input
                      id="entry-override-rate"
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0"
                      value={overrideRate}
                      onChange={(event) => setOverrideRate(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="entry-override-reason">Reason</FieldLabel>
                    <Input
                      id="entry-override-reason"
                      value={overrideReason}
                      onChange={(event) => setOverrideReason(event.target.value)}
                      maxLength={500}
                      placeholder="Why this line is priced differently"
                    />
                  </Field>
                </div>
              )}
              <FieldDescription>
                Overriding is audited: the rate, the reason and who set it are recorded.
              </FieldDescription>
            </Field>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="gap-2">
          {entry && (
            <Button
              type="button"
              variant="destructive"
              onClick={() => remove.mutate()}
              disabled={remove.isPending || save.isPending}
              className="sm:mr-auto"
            >
              Delete
            </Button>
          )}
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button type="button" onClick={() => save.mutate()} disabled={!canSave}>
            {entry ? 'Save line' : 'Add line'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
