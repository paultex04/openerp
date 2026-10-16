'use client';

/**
 * Approvals — the queue an approver works through, and the week they sign off.
 *
 * The queue comes from `GET /api/timesheets/approvals`, which returns every
 * submitted week to any holder of `timesheet.approve` — the project managers, the
 * commercial desk and administrators — whoever submitted it, including their own.
 * The service re-checks the permission, because the UI is not a boundary.
 *
 * Approving freezes the week's cost. That is the moment the numbers stop being a
 * preview and become the figure the margin is reported from, so the dialog shows
 * the live cost before the button is pressed.
 *
 * Reopening returns an approved week to draft. To correct an approved week
 * *without* reopening it, an approver edits its lines on the Enter time tab: that
 * re-freezes each corrected line and leaves the audit log with the before/after.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle } from 'lucide-react';
import { api, ApiError, type TimesheetSummary, type TimesheetView } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/data-table/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { formatNumber, formatZar } from '@/lib/format';
import { TimesheetStatusBadge } from './status-badge';
import { WeekGrid } from './week-grid';
import { formatWeek } from './weeks';

type Mode = 'submitted' | 'approved';

function cell<T extends object>(header: string, accessor: (row: T) => ReactNode) {
  return {
    header,
    cell: ({ row }: { row: { original: T } }) => accessor(row.original),
  } as unknown as ColumnDef<any, T, unknown>;
}

function numericCell<T extends object>(header: string, accessor: (row: T) => ReactNode) {
  return {
    header,
    meta: { align: 'right' },
    cell: ({ row }: { row: { original: T } }) => accessor(row.original),
  } as unknown as ColumnDef<any, T, unknown>;
}

export function ApprovalsPanel() {
  const [mode, setMode] = useState<Mode>('submitted');
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const query = useQuery({
    queryKey: ['timesheets', 'approvals', mode],
    queryFn: () =>
      mode === 'submitted'
        ? api.get<{ timesheets: TimesheetSummary[] }>('/api/timesheets/approvals')
        : api.get<{ timesheets: TimesheetSummary[] }>('/api/timesheets', {
            status: 'Approved',
            limit: 100,
          }),
  });

  const rows = query.data?.timesheets ?? [];

  const columns: ColumnDef<any, TimesheetSummary, unknown>[] = [
    cell<TimesheetSummary>('Employee', (row) => (
      <span className="font-medium">
        {row.employee.name} {row.employee.surname}
      </span>
    )),
    cell<TimesheetSummary>('Week', (row) => formatWeek(row.periodStart, row.periodEnd)),
    numericCell<TimesheetSummary>('Hours', (row) => formatNumber(row.totalHours)),
    numericCell<TimesheetSummary>('Lines', (row) => row.entryCount),
    ...(mode === 'approved'
      ? [numericCell<TimesheetSummary>('Frozen cost', (row) => formatZar(row.approvedCost))]
      : []),
    cell<TimesheetSummary>('Status', (row) => <TimesheetStatusBadge status={row.status} />),
  ];

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={mode === 'submitted' ? 'default' : 'ghost'}
          aria-pressed={mode === 'submitted'}
          onClick={() => setMode('submitted')}
        >
          Awaiting approval
        </Button>
        <Button
          size="sm"
          variant={mode === 'approved' ? 'default' : 'ghost'}
          aria-pressed={mode === 'approved'}
          onClick={() => setMode('approved')}
        >
          Recently approved
        </Button>
      </div>

      {query.isError ? (
        <Alert className="border-destructive/40 bg-destructive/5">
          <AlertTriangle aria-hidden="true" />
          <span>
            {query.error instanceof ApiError
              ? query.error.message
              : 'Could not load the approval queue.'}
          </span>
        </Alert>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          rowKey={(row) => row.id}
          searchKeys={['employee.name', 'employee.surname']}
          searchPlaceholder="Search by employee…"
          caption={
            mode === 'submitted' ? 'Timesheets awaiting approval' : 'Recently approved timesheets'
          }
          emptyMessage={
            mode === 'submitted'
              ? 'Nothing is waiting for your approval.'
              : 'No approved weeks yet.'
          }
          isLoading={query.isLoading}
          initialSort={[{ id: 'Week', desc: true }]}
          renderRowActions={(row) => (
            <Button size="sm" variant="outline" onClick={() => setSelectedId(row.id)}>
              Review
            </Button>
          )}
        />
      )}

      {selectedId !== null && (
        <ReviewDialog timesheetId={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </section>
  );
}

function ReviewDialog({ timesheetId, onClose }: { timesheetId: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['timesheet', timesheetId],
    queryFn: () => api.get<{ timesheet: TimesheetView }>(`/api/timesheets/${timesheetId}`),
  });
  const timesheet = detail.data?.timesheet ?? null;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['timesheets'] });
    void queryClient.invalidateQueries({ queryKey: ['timesheet'] });
    void queryClient.invalidateQueries({ queryKey: ['timesheet-week'] });
    void queryClient.invalidateQueries({ queryKey: ['costing'] });
  };

  const decide = useMutation({
    mutationFn: (action: 'approve' | 'reject' | 'reopen') =>
      api.post<{ timesheet: TimesheetView }>(
        `/api/timesheets/${timesheetId}/${action}`,
        action === 'approve' ? { note: note.trim() || undefined } : { note: note.trim() },
      ),
    onSuccess: (_data, action) => {
      toast.add({
        title:
          action === 'approve'
            ? 'Week approved — cost frozen'
            : action === 'reject'
              ? 'Week returned to the employee'
              : 'Week reopened for editing',
        type: 'success',
      });
      invalidate();
      onClose();
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not record the decision.'),
  });

  const status = timesheet?.status;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {timesheet
              ? `${timesheet.employee.name} ${timesheet.employee.surname} · ${formatWeek(
                  timesheet.periodStart,
                  timesheet.periodEnd,
                )}`
              : 'Review timesheet'}
          </DialogTitle>
          <DialogDescription>
            {status === 'Submitted'
              ? 'Approving freezes the cost of every line at today’s rates. Rejecting returns it to the employee with your note.'
              : status === 'Approved'
                ? 'Reopening returns the week to draft and unfreezes its cost, so a correction can be entered and re-approved. To fix a single line without reopening, amend it on the Enter time tab.'
                : 'This week is not awaiting a decision.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
          {detail.isLoading && <p className="text-sm text-muted-foreground">Loading week…</p>}

          {timesheet && (
            <>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <TimesheetStatusBadge status={timesheet.status} />
                <span className="text-muted-foreground">
                  {formatNumber(timesheet.totals.hours)} h · cost{' '}
                  <span className="font-medium text-foreground">
                    {formatZar(timesheet.totals.cost)}
                  </span>
                </span>
              </div>

              {timesheet.totals.unpricedLines > 0 && (
                <Alert className="border-warning/40 bg-warning/5">
                  <AlertTriangle aria-hidden="true" />
                  <span>
                    {timesheet.totals.unpricedLines} line
                    {timesheet.totals.unpricedLines === 1 ? '' : 's'} have no cost rate, so the week
                    cannot be approved until they are priced.
                  </span>
                </Alert>
              )}

              <WeekGrid periodStart={timesheet.periodStart} entries={timesheet.entries} />

              {timesheet.notes && (
                <p className="text-sm text-muted-foreground">
                  Employee's note: <span className="text-foreground">{timesheet.notes}</span>
                </p>
              )}

              {(status === 'Submitted' || status === 'Approved') && (
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="text-muted-foreground">
                    {status === 'Approved'
                      ? 'Reason for reopening (required)'
                      : 'Note to the employee (required to reject)'}
                  </span>
                  <Input
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    maxLength={500}
                  />
                </label>
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}
            </>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
          {status === 'Submitted' && (
            <>
              <Button
                type="button"
                variant="destructive"
                disabled={decide.isPending || note.trim() === ''}
                onClick={() => decide.mutate('reject')}
              >
                Reject
              </Button>
              <Button
                type="button"
                disabled={decide.isPending || (timesheet?.totals.unpricedLines ?? 0) > 0}
                onClick={() => decide.mutate('approve')}
              >
                Approve and freeze cost
              </Button>
            </>
          )}
          {status === 'Approved' && (
            <Button
              type="button"
              disabled={decide.isPending || note.trim() === ''}
              onClick={() => decide.mutate('reopen')}
            >
              Reopen for editing
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
