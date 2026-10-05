'use client';

/**
 * Crew assignments on a job card.
 *
 * Closes ADR-006 D4, which omitted Crew Assignments because there was no screen.
 * The endpoint and the `job.assign` guard both already existed at `v0.3.0`; what
 * was missing was a list of employees to assign, which Phase 7 added.
 *
 * Deliberately not a `DataTable`. A crew is a handful of people, not a register,
 * and a table toolbar above three rows is more chrome than the content. A list
 * with a picker reads better at this size.
 *
 * Two constraints are respected rather than worked around:
 *
 *  - **No self-management.** An employee cannot be their own manager, enforced
 *    server-side; the picker therefore lists active employees only.
 *  - **Terminated employees cannot be assigned.** The picker filters on
 *    `isActive`, because attaching someone who has left to a new job is a data
 *    error rather than a historical fact.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
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
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/format';

export interface Assignment {
  id: number;
  role: string | null;
  assignedDate: string | null;
  employee: { id: number; name: string; surname: string };
}

interface EmployeeOption {
  id: number;
  fullName: string;
  isActive: boolean;
  brokerName?: string | null;
}

export function CrewPanel({
  jobId,
  assignments,
  canAssign,
  onChanged,
}: {
  jobId: number;
  assignments: readonly Assignment[];
  canAssign: boolean;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Assignment | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<Assignment | null>(null);

  const employees = useQuery({
    queryKey: ['employees', 'picker'],
    queryFn: () => api.get<{ employees: EmployeeOption[] }>('/api/employees'),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['job', jobId] });
    onChanged();
  };

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/job-assignments/${id}`),
    onSuccess: () => {
      toast.add({ title: 'Removed from crew', type: 'success' });
      setConfirmRemove(null);
      refresh();
    },
    onError: (error: Error) =>
      toast.add({
        title: 'Could not remove from crew',
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      }),
  });

  // Only active employees can be added. A terminated employee is history, and
  // attaching them to a new job would be a data error.
  const available = (employees.data?.employees ?? []).filter(
    (e) => e.isActive && !assignments.some((a) => a.employee.id === e.id),
  );

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Crew</h3>
        {canAssign && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <UserPlus aria-hidden="true" className="size-4" />
            Add to crew
          </Button>
        )}
      </div>

      {assignments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {canAssign ? 'No one is assigned to this job yet.' : 'No crew assigned.'}
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {assignments.map((assignment) => (
            <li key={assignment.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {assignment.employee.name} {assignment.employee.surname}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {assignment.role ?? 'No operational role'}
                  {assignment.assignedDate
                    ? ` · assigned ${formatDate(assignment.assignedDate)}`
                    : ''}
                </p>
              </div>
              {canAssign && (
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(assignment)}
                    aria-label={`Edit crew role for ${assignment.employee.name} ${assignment.employee.surname}`}
                  >
                    <Pencil aria-hidden="true" className="size-4" />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmRemove(assignment)}
                    aria-label={`Remove ${assignment.employee.name} ${assignment.employee.surname} from crew`}
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                    Remove
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <AssignmentDialog
        key={adding ? 'add' : editing ? `edit-${editing.id}` : 'closed'}
        open={adding || editing !== null}
        jobId={jobId}
        assignment={editing}
        options={available}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
        onSaved={() => {
          setAdding(false);
          setEditing(null);
          refresh();
        }}
      />

      <AlertDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => !open && setConfirmRemove(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {confirmRemove?.employee.name} {confirmRemove?.employee.surname} from the crew?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The person stays on the employee directory and on any job they actually worked. This
              only removes them from this job’s crew list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmRemove && remove.mutate(confirmRemove.id)}>
              Remove from crew
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function AssignmentDialog({
  open,
  jobId,
  assignment,
  options,
  onClose,
  onSaved,
}: {
  open: boolean;
  jobId: number;
  assignment: Assignment | null;
  options: readonly EmployeeOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isCreate = assignment === null;
  const [employeeId, setEmployeeId] = useState('');
  const [role, setRole] = useState('');
  const [assignedDate, setAssignedDate] = useState('');

  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...(role.trim() ? { role: role.trim() } : {}),
        ...(assignedDate ? { assignedDate } : {}),
      };
      return isCreate
        ? api.post(`/api/jobs/${jobId}/assignments`, {
            ...body,
            employeeId: Number(employeeId),
          })
        : api.patch(`/api/job-assignments/${assignment!.id}`, body);
    },
    onSuccess: () => {
      toast.add({
        title: isCreate ? 'Added to crew' : 'Crew role updated',
        type: 'success',
      });
      onSaved();
    },
    onError: (error: Error) =>
      toast.add({
        title: isCreate ? 'Could not add to crew' : 'Could not update crew',
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      }),
  });

  const canSubmit = isCreate ? employeeId !== '' : true;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isCreate ? 'Add to crew' : 'Edit crew assignment'}</DialogTitle>
          <DialogDescription>
            {isCreate
              ? 'Attaches an employee to this job with an operational role, such as Foreman or Operator.'
              : 'The operational role this person holds on the job.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {isCreate && (
            <Field>
              <FieldLabel htmlFor="crew-employee">Employee</FieldLabel>
              <select
                id="crew-employee"
                value={employeeId}
                onChange={(event) => setEmployeeId(event.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">Choose an active employee…</option>
                {options.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.fullName}
                    {employee.brokerName ? ` (${employee.brokerName})` : ''}
                  </option>
                ))}
              </select>
              {options.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Every active employee is already on this crew.
                </p>
              )}
            </Field>
          )}

          <Field>
            <FieldLabel htmlFor="crew-role">Operational role</FieldLabel>
            <Input
              id="crew-role"
              defaultValue={assignment?.role ?? ''}
              onChange={(event) => setRole(event.target.value)}
              placeholder="e.g. Foreman"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="crew-date">Assigned date</FieldLabel>
            <Input
              id="crew-date"
              type="date"
              defaultValue={assignment?.assignedDate ?? ''}
              onChange={(event) => setAssignedDate(event.target.value)}
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => canSubmit && save.mutate()}
            disabled={!canSubmit || save.isPending}
          >
            {save.isPending ? 'Saving…' : isCreate ? 'Add to crew' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
