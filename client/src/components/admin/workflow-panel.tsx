'use client';

/**
 * Job workflow editor: the status catalogue and the transitions between them.
 *
 * This screen edits what the API enforces. Every change here is visible to the
 * register, the job detail dropdown and the dashboard on the next request - there
 * is no publish step, because the server reads the same rows it validates
 * against.
 *
 * ## What can and cannot be changed
 *
 * Labels, order, per-status editability flags and the transitions themselves are
 * all editable. A status *key* is not: it is the value `job.status` stores and
 * what history refers to, so renaming it would orphan every job and audit entry
 * that names it. The key is also what a transition's `from`/`to` point at, which
 * is why the transition editor picks statuses by their current labels but stores
 * their keys.
 *
 * ## Refusals come from the server
 *
 * Deleting a status that jobs stand on, removing the last terminal status,
 * giving a terminal status an outgoing edge, pointing a transition at a
 * capability that is not a `job.transition.*` permission, or duplicating a pair -
 * all of these are refused by the API with a message that says what to do. The
 * UI mirrors the two most obvious ones (deleting an occupied status is disabled,
 * the permission list and status lists are closed sets) but it does not attempt
 * to re-implement the rules: a second implementation is a second place for them
 * to be wrong.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
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
import { SectionHeading } from '@/components/lifecycle/status-badge';
import { DataTable } from '@/components/data-table/data-table';
import { toast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { JOB_WORKFLOW_QUERY_KEY } from '@/hooks/use-job-workflow';

interface WorkflowStatusRow {
  key: string;
  label: string;
  sortOrder: number;
  isTerminal: boolean;
  editablePlanned: boolean;
  editableActuals: boolean;
  /** Jobs currently standing on this status; the delete guardrail's input. */
  jobCount: number;
}

interface WorkflowTransitionRow {
  id: number;
  from: string;
  to: string;
  permission: string;
  reason: string;
}

interface WorkflowResponse {
  statuses: WorkflowStatusRow[];
  transitions: WorkflowTransitionRow[];
  transitionPermissions: Array<{ key: string; description: string }>;
}

const WORKFLOW_QUERY_KEY = ['admin-workflow'] as const;

/**
 * The one error handler every write shares.
 *
 * `ApiError` already carries the server's own wording - "3 job(s) are still in
 * this status" beats any client guess - so this only falls back for the truly
 * unexpected.
 */
function failure(title: string) {
  return (error: Error) =>
    toast.add({
      title,
      description: error.message,
      type: 'error',
    });
}

export function WorkflowPanel() {
  const queryClient = useQueryClient();
  const [statusDialog, setStatusDialog] = useState<{
    mode: 'create' | 'edit';
    row?: WorkflowStatusRow;
  } | null>(null);
  const [transitionDialog, setTransitionDialog] = useState<{
    mode: 'create' | 'edit';
    row?: WorkflowTransitionRow;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<
    | { kind: 'status'; key: string; label: string; jobCount: number }
    | { kind: 'transition'; id: number; description: string }
    | null
  >(null);
  const [fromFilter, setFromFilter] = useState('');

  const workflow = useQuery({
    queryKey: WORKFLOW_QUERY_KEY,
    queryFn: () => api.get<WorkflowResponse>('/api/admin/workflow'),
  });

  const statuses = useMemo(() => workflow.data?.statuses ?? [], [workflow.data]);
  const transitions = useMemo(() => workflow.data?.transitions ?? [], [workflow.data]);
  const labelOf = (key: string) => statuses.find((status) => status.key === key)?.label ?? key;

  /**
   * Every successful write does two things: refetch this screen, and drop the
   * shared workflow cache the rest of the app renders from. Without the second,
   * the register would keep showing the previous label until its own staleness
   * window elapsed.
   */
  const afterWrite = async (title: string, description: string) => {
    await queryClient.invalidateQueries({ queryKey: WORKFLOW_QUERY_KEY });
    await queryClient.invalidateQueries({ queryKey: JOB_WORKFLOW_QUERY_KEY });
    toast.add({ title, description, type: 'success' });
  };

  const createStatus = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/api/admin/workflow/statuses', body),
    onSuccess: () => afterWrite('Status created', 'The new stage is live immediately.'),
    onError: failure('Could not create status'),
  });

  const updateStatus = useMutation({
    mutationFn: ({ key, body }: { key: string; body: Record<string, unknown> }) =>
      api.patch(`/api/admin/workflow/statuses/${encodeURIComponent(key)}`, body),
    onSuccess: () => afterWrite('Status updated', 'The pipeline now uses the new details.'),
    onError: failure('Could not update status'),
  });

  const deleteStatus = useMutation({
    mutationFn: (key: string) =>
      api.delete(`/api/admin/workflow/statuses/${encodeURIComponent(key)}`),
    onSuccess: () => afterWrite('Status deleted', 'Its transitions were removed with it.'),
    onError: failure('Could not delete status'),
  });

  const createTransition = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post('/api/admin/workflow/transitions', body),
    onSuccess: () => afterWrite('Transition created', 'The move is allowed from now on.'),
    onError: failure('Could not create transition'),
  });

  const updateTransition = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api.patch(`/api/admin/workflow/transitions/${id}`, body),
    onSuccess: () => afterWrite('Transition updated', 'The new capability applies immediately.'),
    onError: failure('Could not update transition'),
  });

  const deleteTransition = useMutation({
    mutationFn: (id: number) => api.delete(`/api/admin/workflow/transitions/${id}`),
    onSuccess: () => afterWrite('Transition deleted', 'The move is no longer allowed.'),
    onError: failure('Could not delete transition'),
  });

  const statusColumns = useMemo<ColumnDef<any, WorkflowStatusRow, unknown>[]>(
    () => [
      {
        id: 'status',
        accessorKey: 'label',
        header: 'Status',
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{row.original.label}</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {row.original.key}
            </div>
          </div>
        ),
      },
      {
        id: 'sortOrder',
        accessorKey: 'sortOrder',
        header: 'Order',
        meta: { align: 'right' },
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.sortOrder}</span>,
      },
      {
        id: 'jobCount',
        accessorKey: 'jobCount',
        header: 'Jobs',
        meta: { align: 'right' },
        cell: ({ row }) => (
          <span className="font-mono text-xs tabular-nums">{row.original.jobCount}</span>
        ),
      },
      {
        id: 'flags',
        header: 'Behaviour',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.isTerminal && <Badge variant="destructive">Terminal</Badge>}
            {row.original.editablePlanned && <Badge variant="outline">Planned edits</Badge>}
            {row.original.editableActuals && <Badge variant="outline">Actuals edits</Badge>}
            {!row.original.isTerminal &&
              !row.original.editablePlanned &&
              !row.original.editableActuals && (
                <span className="text-xs text-muted-foreground">Read-only</span>
              )}
          </div>
        ),
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setStatusDialog({ mode: 'edit', row: row.original })}
            >
              Edit
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              // Disabled with a tooltip rather than hidden: a delete button that
              // vanished on an occupied status would leave the rule invisible.
              disabled={row.original.jobCount > 0}
              title={
                row.original.jobCount > 0
                  ? `${row.original.jobCount} job(s) are in this status; it cannot be deleted.`
                  : 'Delete this status'
              }
              onClick={() =>
                setConfirmDelete({
                  kind: 'status',
                  key: row.original.key,
                  label: row.original.label,
                  jobCount: row.original.jobCount,
                })
              }
            >
              Delete
            </Button>
          </div>
        ),
      },
    ],
    [],
  );

  const transitionColumns = useMemo<ColumnDef<any, WorkflowTransitionRow, unknown>[]>(
    () => [
      {
        id: 'from',
        accessorFn: (row) => labelOf(row.from),
        header: 'From',
        cell: ({ row }) => <span className="text-sm">{labelOf(row.original.from)}</span>,
      },
      {
        id: 'to',
        accessorFn: (row) => labelOf(row.to),
        header: 'To',
        cell: ({ row }) => <span className="text-sm">{labelOf(row.original.to)}</span>,
      },
      {
        id: 'permission',
        accessorKey: 'permission',
        header: 'Requires',
        cell: ({ row }) => <span className="font-mono text-[11px]">{row.original.permission}</span>,
      },
      {
        id: 'reason',
        accessorKey: 'reason',
        header: 'Reason shown to users',
        cell: ({ row }) => (
          <span
            className="block max-w-96 truncate text-xs text-muted-foreground"
            title={row.original.reason}
          >
            {row.original.reason}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setTransitionDialog({ mode: 'edit', row: row.original })}
            >
              Edit
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                setConfirmDelete({
                  kind: 'transition',
                  id: row.original.id,
                  description: `${labelOf(row.original.from)} → ${labelOf(row.original.to)}`,
                })
              }
            >
              Delete
            </Button>
          </div>
        ),
      },
    ],
    // `labelOf` closes over `statuses`, so the columns must rebuild when the
    // catalogue changes or a renamed status would keep its old name in this table.
    [statuses],
  );

  if (workflow.isError) {
    return (
      <p className="text-sm text-negative">
        {workflow.error instanceof ApiError
          ? workflow.error.message
          : 'Could not load the workflow.'}
      </p>
    );
  }

  const busy =
    createStatus.isPending ||
    updateStatus.isPending ||
    deleteStatus.isPending ||
    createTransition.isPending ||
    updateTransition.isPending ||
    deleteTransition.isPending;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        The pipeline every job moves through. Labels and order shape the UI and the register&apos;s
        filters; the behaviour flags decide which stages may edit planned quantities or record
        actuals; the transitions decide who may move a job where. Changes apply immediately, and the
        server enforces exactly what is configured here. A status key is permanent - it is what job
        history stores - so rename the label instead.
      </p>

      <section className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <SectionHeading>Statuses</SectionHeading>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => setStatusDialog({ mode: 'create' })}
          >
            Add status
          </Button>
        </div>
        <DataTable<WorkflowStatusRow>
          caption="Job workflow statuses"
          data={statuses}
          columns={statusColumns}
          rowKey={(row) => row.key}
          searchKeys={['label', 'key']}
          searchPlaceholder="Search status…"
          isLoading={workflow.isLoading}
          initialSort={[{ id: 'sortOrder', desc: false }]}
          pageSize={25}
          emptyMessage="The workflow has no statuses."
        />
      </section>

      <section className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <SectionHeading>Transitions</SectionHeading>
          <Button
            type="button"
            size="sm"
            disabled={busy || statuses.length === 0}
            onClick={() => setTransitionDialog({ mode: 'create' })}
          >
            Add transition
          </Button>
        </div>
        <DataTable<WorkflowTransitionRow>
          caption="Job workflow transitions"
          data={transitions}
          columns={transitionColumns}
          rowKey={(row) => row.id}
          searchKeys={['permission', 'reason']}
          searchPlaceholder="Search capability or reason…"
          isLoading={workflow.isLoading}
          initialSort={[{ id: 'from', desc: false }]}
          pageSize={25}
          emptyMessage="No transitions: jobs cannot move between stages."
          filters={[
            {
              id: 'from',
              label: 'From',
              value: fromFilter,
              options: [
                { value: '', label: 'Any stage' },
                ...statuses.map((status) => ({ value: status.key, label: status.label })),
              ],
              onChange: setFromFilter,
              predicate: (row, selected) => row.from === selected,
            },
          ]}
        />
      </section>

      {statusDialog && (
        <StatusDialog
          key={statusDialog.row?.key ?? 'create'}
          open
          mode={statusDialog.mode}
          row={statusDialog.row}
          saving={createStatus.isPending || updateStatus.isPending}
          onClose={() => setStatusDialog(null)}
          onSubmit={(body) => {
            if (statusDialog.mode === 'create') {
              createStatus.mutate(body, { onSuccess: () => setStatusDialog(null) });
            } else if (statusDialog.row) {
              updateStatus.mutate(
                { key: statusDialog.row.key, body },
                { onSuccess: () => setStatusDialog(null) },
              );
            }
          }}
        />
      )}

      {transitionDialog && (
        <TransitionDialog
          key={transitionDialog.row?.id ?? 'create'}
          open
          mode={transitionDialog.mode}
          row={transitionDialog.row}
          statuses={statuses}
          permissions={workflow.data?.transitionPermissions ?? []}
          saving={createTransition.isPending || updateTransition.isPending}
          onClose={() => setTransitionDialog(null)}
          onSubmit={(body) => {
            if (transitionDialog.mode === 'create') {
              createTransition.mutate(body, { onSuccess: () => setTransitionDialog(null) });
            } else if (transitionDialog.row) {
              updateTransition.mutate(
                { id: transitionDialog.row.id, body },
                { onSuccess: () => setTransitionDialog(null) },
              );
            }
          }}
        />
      )}

      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmDelete?.kind === 'status'
                ? `Delete “${confirmDelete.label}”?`
                : 'Delete this transition?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete?.kind === 'status' ? (
                <>
                  The status is removed from the workflow, together with every transition into and
                  out of it. This cannot be undone.
                </>
              ) : (
                <>
                  {confirmDelete?.kind === 'transition'
                    ? `“${confirmDelete.description}” will no longer be offered or allowed.`
                    : ''}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDelete?.kind === 'status') deleteStatus.mutate(confirmDelete.key);
                else if (confirmDelete?.kind === 'transition')
                  deleteTransition.mutate(confirmDelete.id);
                setConfirmDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** ------------------------------------------------------------------------- */

function StatusDialog({
  open,
  mode,
  row,
  saving,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  row?: WorkflowStatusRow;
  saving: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const isCreate = mode === 'create';
  const [key, setKey] = useState('');
  const [label, setLabel] = useState(row?.label ?? '');
  const [sortOrder, setSortOrder] = useState(row ? String(row.sortOrder) : '');
  const [isTerminal, setIsTerminal] = useState(row?.isTerminal ?? false);
  const [editablePlanned, setEditablePlanned] = useState(row?.editablePlanned ?? false);
  const [editableActuals, setEditableActuals] = useState(row?.editableActuals ?? false);

  const canSubmit = key.trim().length > 0 && label.trim().length > 0 && !saving;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isCreate ? 'New status' : `Edit ${row?.label}`}</DialogTitle>
          <DialogDescription>
            {isCreate
              ? 'A new stage in the pipeline. Leave the order blank to append it at the end.'
              : 'The key is permanent; every other field can be changed at any time.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="status-key">Key</FieldLabel>
            <Input
              id="status-key"
              value={key}
              disabled={!isCreate}
              placeholder="12. Ready to invoice"
              onChange={(event) => {
                setKey(event.target.value);
                // A new status is nearly always keyed and labelled the same to
                // begin with; the label stays editable afterwards.
                if (isCreate) setLabel(event.target.value);
              }}
            />
            <FieldDescription>
              Stored on every job in this status and shown in audit history. Letters, digits, spaces
              and punctuation, up to 40 characters. Cannot be changed later.
            </FieldDescription>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="status-label">Label</FieldLabel>
              <Input
                id="status-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="status-order">Sort order</FieldLabel>
              <Input
                id="status-order"
                type="number"
                inputMode="numeric"
                value={sortOrder}
                placeholder="Append"
                onChange={(event) => setSortOrder(event.target.value)}
              />
              <FieldDescription>Position in the pipeline. Must be unique.</FieldDescription>
            </Field>
          </div>

          <div className="flex flex-col gap-3 rounded-md border p-3">
            <FlagToggle
              id="status-terminal"
              checked={isTerminal}
              onChange={setIsTerminal}
              label="Terminal"
              hint="The workflow ends here: no further transitions are allowed from this status. It needs no outgoing edges, and at least one status must remain terminal."
            />
            <FlagToggle
              id="status-planned"
              checked={editablePlanned}
              onChange={setEditablePlanned}
              label="Planned quantities editable"
              hint="Scope quantities can be changed while a job is in this status."
            />
            <FlagToggle
              id="status-actuals"
              checked={editableActuals}
              onChange={setEditableActuals}
              label="Actuals editable"
              hint="Field actuals can be recorded while a job is in this status."
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() =>
              onSubmit({
                ...(isCreate && { key: key.trim() }),
                label: label.trim(),
                ...(sortOrder.trim() !== '' && { sortOrder: Number(sortOrder) }),
                isTerminal,
                editablePlanned,
                editableActuals,
              })
            }
          >
            {saving ? 'Saving…' : isCreate ? 'Create status' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** ------------------------------------------------------------------------- */

function TransitionDialog({
  open,
  mode,
  row,
  statuses,
  permissions,
  saving,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  row?: WorkflowTransitionRow;
  statuses: readonly WorkflowStatusRow[];
  permissions: ReadonlyArray<{ key: string; description: string }>;
  saving: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const isCreate = mode === 'create';
  const [from, setFrom] = useState(row?.from ?? statuses[0]?.key ?? '');
  const [to, setTo] = useState(row?.to ?? '');
  const [permission, setPermission] = useState(row?.permission ?? permissions[0]?.key ?? '');
  const [reason, setReason] = useState(row?.reason ?? '');

  // The one rule the editor pre-empts: a terminal status has no exits. Making
  // the source select say so beats letting the server refuse the save.
  const sources = statuses.filter((status) => !status.isTerminal);
  const canSubmit =
    (from && to && from !== to && permission && reason.trim().length >= 3 && !saving) || false;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isCreate ? 'New transition' : 'Edit transition'}</DialogTitle>
          <DialogDescription>
            {isCreate
              ? 'Allow a move between two stages, and name the capability it takes.'
              : 'The two stages are fixed; the capability and the reason can change.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="transition-from">From</FieldLabel>
              <select
                id="transition-from"
                className="border-input bg-background h-9 rounded-md border px-3 text-sm disabled:opacity-60"
                value={from}
                disabled={!isCreate}
                onChange={(event) => setFrom(event.target.value)}
              >
                {sources.map((status) => (
                  <option key={status.key} value={status.key}>
                    {status.label}
                  </option>
                ))}
                {!isCreate && row && <option value={row.from}>{row.from}</option>}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="transition-to">To</FieldLabel>
              <select
                id="transition-to"
                className="border-input bg-background h-9 rounded-md border px-3 text-sm disabled:opacity-60"
                value={to}
                disabled={!isCreate}
                onChange={(event) => setTo(event.target.value)}
              >
                <option value="">Choose a stage…</option>
                {statuses
                  .filter((status) => status.key !== from)
                  .map((status) => (
                    <option key={status.key} value={status.key}>
                      {status.label}
                    </option>
                  ))}
              </select>
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="transition-permission">Required capability</FieldLabel>
            <select
              id="transition-permission"
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
              value={permission}
              onChange={(event) => setPermission(event.target.value)}
            >
              {permissions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.key}
                </option>
              ))}
            </select>
            <FieldDescription>
              {permissions.find((option) => option.key === permission)?.description ??
                'Whoever performs this move needs this permission.'}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="transition-reason">Reason</FieldLabel>
            <Input
              id="transition-reason"
              value={reason}
              placeholder="Why this move happens, e.g. “Physical work finished.”"
              onChange={(event) => setReason(event.target.value)}
            />
            <FieldDescription>
              Shown to users when the move is unavailable, so it should read as an explanation.
            </FieldDescription>
          </Field>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() =>
              onSubmit(
                isCreate
                  ? { from, to, permission, reason: reason.trim() }
                  : { permission, reason: reason.trim() },
              )
            }
          >
            {saving ? 'Saving…' : isCreate ? 'Create transition' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** ------------------------------------------------------------------------- */

/** A labelled checkbox with an explanatory line, used for the status flags. */
function FlagToggle({
  id,
  checked,
  onChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}
