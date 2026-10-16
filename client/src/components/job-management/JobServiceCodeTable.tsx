'use client';

/**
 * The job's service-code lines, reused on the Operations detail route.
 *
 * ## Why a table and not the old grid
 *
 * `DeliverableGrid` edited planned and actual quantities in place, which was right
 * for a supervisor on a phone recording one measured figure. On a register where
 * quantities, applied rate, variance and lock state all matter together, inline
 * editing put an editable number in a column of read-only figures with no visual
 * distinction, and no way to see a line's whole state at once. Each line now opens a
 * dialog, and the table is read-only apart from that.
 *
 * `DeliverableGrid` is deleted rather than kept. `/field` never used it — it has its
 * own inline actual-quantity input, sized for a phone — so it had no remaining caller.
 * Its two endpoints are untouched and still used here and by `/field`.
 *
 * ## Adding a line
 *
 * "Add line item" searches `GET /api/service-codes`, scoped to the job's own
 * amendment. That scoping is the point: rates and service codes are amendment-scoped,
 * and the server refuses a line whose service code belongs to a different amendment
 * with `AMENDMENT_MISMATCH`. Filtering in the picker means the user is never offered
 * something the server will reject.
 */

import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import {
  api,
  ApiError,
  type DeliverableRow,
  type JobDetail,
  type VarianceSummary,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { NumericCell } from '@/components/data-table/NumericCell';
import { varianceTone } from '@/components/lifecycle/status-badge';
import { formatNumber, formatZar, formatZarRate } from '@/lib/format';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AddLineItemDialog } from '@/components/job-management/AddLineItemDialog';
import { EditLineItemDialog } from '@/components/job-management/EditLineItemDialog';

type Job = JobDetail['job'];
type Permissions = JobDetail['permissions'];

export function JobServiceCodeTable({
  jobId,
  job,
  deliverables,
  summary,
  permissions,
  onChanged,
}: {
  jobId: number;
  job: Job;
  deliverables: DeliverableRow[];
  summary: VarianceSummary;
  permissions: Permissions;
  onChanged: () => void;
}) {
  const [term, setTerm] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<DeliverableRow | null>(null);

  const visible = useMemo(() => {
    const terms = term.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return deliverables;
    return deliverables.filter((row) => {
      const haystack = `${row.code ?? ''} ${row.description ?? ''}`.toLowerCase();
      return terms.every((part) => haystack.includes(part));
    });
  }, [deliverables, term]);

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/job-deliverables/${id}`),
    onSuccess: () => {
      toast.add({ title: 'Line item removed', type: 'success' });
      onChanged();
    },
    onError: (error: Error) =>
      toast.add({
        title: 'Could not remove the line item',
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      }),
  });

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Service code line items</h3>
        <Button
          size="sm"
          onClick={() => setAddOpen(true)}
          disabled={!permissions.canAddDeliverable}
        >
          <Plus aria-hidden="true" className="size-4" />
          Add line item
        </Button>
      </div>

      {!permissions.canAddDeliverable && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
          You do not hold <code className="font-mono">deliverable.write.planned</code>, so line
          items cannot be added to this job.
        </p>
      )}

      {/* Totals above the table, not in a footer: a footer scrolls out of view, and
          the planned/actual comparison is the reason to read this table at all. */}
      <dl className="grid gap-3 sm:grid-cols-4">
        <Total label="Planned value" value={formatZar(summary.plannedSubtotal)} />
        <Total label="Actual value" value={formatZar(summary.actualSubtotal)} />
        <Total
          label="Variance"
          value={formatZar(summary.valueVariance)}
          tone={varianceTone(summary.valueVariance)}
        />
        <Total
          label="Lines measured"
          value={`${summary.linesWithActuals} of ${summary.lineCount}`}
        />
      </dl>

      <div
        role="search"
        className="flex flex-wrap items-center gap-2"
        aria-label="Line item search"
      >
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Search code or description."
            aria-label="Search line items"
            className="pl-8"
          />
        </div>
        <span aria-live="polite" className="text-xs text-muted-foreground">
          {visible.length === deliverables.length
            ? `${deliverables.length} ${deliverables.length === 1 ? 'line' : 'lines'}`
            : `${visible.length} of ${deliverables.length} lines`}
        </span>
      </div>

      {/*
        The body scrolls rather than the page: on a job with a hundred lines the
        totals, the search box and the row above never leave the screen. The
        wrapper is the scroll region; `min-h-0` is what lets it shrink instead of
        pushing the page taller.
      */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border">
        <Table>
          <TableCaption className="sr-only">
            Service code line items for job {jobId}, with planned and actual values
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Code</TableHead>
              <TableHead scope="col">Description</TableHead>
              <TableHead scope="col" className="text-right">
                Planned qty
              </TableHead>
              <TableHead scope="col" className="text-right">
                Actual qty
              </TableHead>
              <TableHead scope="col" className="text-right">
                Applied rate
              </TableHead>
              <TableHead scope="col" className="text-right">
                Planned value
              </TableHead>
              <TableHead scope="col" className="text-right">
                Actual value
              </TableHead>
              <TableHead scope="col" className="text-right">
                Variance
              </TableHead>
              <TableHead scope="col">
                <span className="sr-only">Row actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center text-sm text-muted-foreground">
                  {deliverables.length === 0
                    ? 'This job has no line items yet. Use "Add line item" to scope the work.'
                    : 'No line items match the search.'}
                </TableCell>
              </TableRow>
            ) : (
              visible.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.code}</TableCell>
                  <TableCell>
                    <span className="block max-w-72 truncate" title={row.description}>
                      {row.description}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {row.category} · {row.uom}
                      {row.rateHasDrifted && ' · rate has drifted since scoping'}
                    </span>
                  </TableCell>
                  <NumericCell className="whitespace-nowrap">
                    {formatNumber(row.plannedQuantity)}
                  </NumericCell>
                  <NumericCell className="whitespace-nowrap">
                    {row.actualQuantity === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      formatNumber(row.actualQuantity)
                    )}
                  </NumericCell>
                  <NumericCell className="whitespace-nowrap">
                    {formatZarRate(row.appliedRate)}
                  </NumericCell>
                  <NumericCell className="whitespace-nowrap">
                    {formatZar(row.plannedSubtotal)}
                  </NumericCell>
                  <NumericCell className="whitespace-nowrap">
                    {formatZar(row.actualSubtotal)}
                  </NumericCell>
                  <NumericCell className="whitespace-nowrap">
                    <span className={varianceTone(row.valueVariance)}>
                      {formatZar(row.valueVariance)}
                    </span>
                  </NumericCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(row)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => remove.mutate(row.id)}
                        disabled={remove.isPending}
                      >
                        Remove
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {(permissions.plannedLockReason || permissions.actualsLockReason) && (
        <p className="text-xs text-muted-foreground">
          {permissions.plannedLockReason ?? permissions.actualsLockReason}
        </p>
      )}

      {addOpen && (
        <AddLineItemDialog
          job={job}
          onClose={() => setAddOpen(false)}
          onAdded={() => {
            setAddOpen(false);
            onChanged();
          }}
        />
      )}

      {editing && (
        <EditLineItemDialog
          row={editing}
          canEditPlanned={permissions.canEditPlanned}
          canEditActuals={permissions.canEditActuals}
          plannedLockReason={permissions.plannedLockReason}
          actualsLockReason={permissions.actualsLockReason}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function Total({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border p-3">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 font-mono text-sm tabular-nums ${tone ?? ''}`}>{value}</dd>
    </div>
  );
}
