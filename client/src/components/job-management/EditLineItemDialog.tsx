'use client';

/**
 * "Edit line item": planned quantity, actual quantity and applied rate for one line.
 *
 * ## Why the three fields are edited separately, and separately locked
 *
 * Planned quantity and actual quantity are different things written by different
 * people at different times — one is the estimate at scoping, the other is what the
 * site measured. The server already enforces when each is writable (scope freezes at
 * `07. Pack Ready`, actuals are recorded during WIP and Actuals) and returns the
 * reason with the 409. Those reasons are passed in and shown here rather than the
 * inputs merely being disabled: a greyed-out field with no explanation is the single
 * most common support question in a system like this.
 *
 * Applied rate is the price snapshot taken when the line was created, and it is
 * deliberately **not** editable here. It is the figure the job is invoiced at, and
 * changing it after scoping would silently rewrite what was agreed with the client.
 * `rateHasDrifted` is surfaced as a read-only warning instead — that is the situation
 * a commercial QS needs to see, and the fix for it is a re-scope, not an edit here.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, TriangleAlert } from 'lucide-react';
import { api, ApiError, type DeliverableRow } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { formatZar, formatZarRate } from '@/lib/format';
import { varianceTone } from '@/components/lifecycle/status-badge';

export function EditLineItemDialog({
  row,
  canEditPlanned,
  canEditActuals,
  plannedLockReason,
  actualsLockReason,
  onClose,
  onSaved,
}: {
  row: DeliverableRow;
  canEditPlanned: boolean;
  canEditActuals: boolean;
  plannedLockReason: string | null;
  actualsLockReason: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [planned, setPlanned] = useState(String(row.plannedQuantity));
  const [actual, setActual] = useState(String(row.actualQuantity));

  const save = useMutation({
    mutationFn: async () => {
      // Two endpoints, because they have two permissions and two different lock
      // rules. Issuing both when only one changed would surface an error for the
      // field the user did not touch.
      if (Number(planned) !== row.plannedQuantity) {
        await api.patch(`/api/job-deliverables/${row.id}/planned`, {
          plannedQuantity: Number(planned),
        });
      }
      if (Number(actual) !== row.actualQuantity) {
        await api.patch(`/api/job-deliverables/${row.id}/actual`, {
          actualQuantity: Number(actual),
        });
      }
    },
    onSuccess: () => {
      toast.add({ title: 'Line item updated', type: 'success' });
      onSaved();
    },
    onError: (error: Error) =>
      toast.add({
        title: 'Could not update the line item',
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      }),
  });

  const plannedChanged = Number(planned) !== row.plannedQuantity;
  const actualChanged = Number(actual) !== row.actualQuantity;
  const nothingChanged = !plannedChanged && !actualChanged;

  // A changed field the viewer may not write is disabled outright, so the form
  // cannot be submitted into a guaranteed 409.
  const plannedWritable =
    canEditPlanned && (plannedChanged || Number(planned) === row.plannedQuantity);
  const actualWritable = canEditActuals && (actualChanged || Number(actual) === row.actualQuantity);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Edit line item — <span className="font-mono">{row.code}</span>
          </DialogTitle>
          <DialogDescription>{row.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {row.rateHasDrifted && (
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>
                This service code has been re-priced since this line was scoped. The applied rate is
                frozen at {formatZarRate(row.appliedRate)} and this job continues to bill at it; the
                code now prices at {row.currentRate === null ? '—' : formatZarRate(row.currentRate)}
                . Re-scope the line if the new rate should apply.
              </span>
            </p>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Quantities</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <QuantityField
                  id="planned-qty"
                  label={`Planned quantity (${row.uom})`}
                  value={planned}
                  onChange={setPlanned}
                  writable={plannedWritable}
                  lockReason={plannedLockReason}
                  unchanged={!plannedChanged}
                />
                <QuantityField
                  id="actual-qty"
                  label={`Actual quantity (${row.uom})`}
                  value={actual}
                  onChange={setActual}
                  writable={actualWritable}
                  lockReason={actualsLockReason}
                  unchanged={!actualChanged}
                />
              </div>
            </CardContent>
          </Card>

          {/* Read-only by design. See the file header. */}
          <Card>
            <CardHeader>
              <CardTitle>Pricing snapshot</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">
                  Applied rate (snapshot, not editable)
                </p>
                <p className="font-mono text-sm tabular-nums">
                  {formatZarRate(row.appliedRate)} per {row.uom}
                </p>
              </div>

              <dl className="grid grid-cols-3 gap-4 text-sm">
                <div className="space-y-1">
                  <dt className="text-[11px] text-muted-foreground">Planned value</dt>
                  <dd className="font-mono tabular-nums">{formatZar(row.plannedSubtotal)}</dd>
                </div>
                <div className="space-y-1">
                  <dt className="text-[11px] text-muted-foreground">Actual value</dt>
                  <dd className="font-mono tabular-nums">{formatZar(row.actualSubtotal)}</dd>
                </div>
                <div className="space-y-1">
                  <dt className="text-[11px] text-muted-foreground">Variance</dt>
                  <dd className={`font-mono tabular-nums ${varianceTone(row.valueVariance)}`}>
                    {formatZar(row.valueVariance)}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={
              nothingChanged ||
              save.isPending ||
              (!plannedWritable && plannedChanged) ||
              (!actualWritable && actualChanged)
            }
          >
            {save.isPending && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QuantityField({
  id,
  label,
  value,
  onChange,
  writable,
  lockReason,
  unchanged,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  writable: boolean;
  lockReason: string | null;
  unchanged: boolean;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        type="number"
        min="0"
        step="0.01"
        value={value}
        disabled={!writable}
        onChange={(event) => onChange(event.target.value)}
      />
      {!unchanged && !writable && lockReason && (
        <p className="text-[11px] text-warning">{lockReason}</p>
      )}
    </div>
  );
}
