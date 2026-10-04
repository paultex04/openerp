'use client';

/**
 * Job deliverable grid.
 *
 * Columns are exactly the ones the specification calls for:
 *   Service Code | Description | UOM | Applied Rate | Planned Qty | Planned Subtotal
 *   | Actual Qty | Actual Subtotal | Variance (Qty & ZAR)
 *
 * Two behaviours worth calling out:
 *
 *  - The **applied rate column is read-only**. It is an immutable snapshot taken
 *    when the job was scoped. If a service code has since been re-priced the cell
 *    shows a drift marker, but the figure itself never changes — that is what
 *    keeps issued invoices reproducible.
 *  - Planned quantities are editable only while the scope is open; actuals only
 *    during execution. The server enforces both, and this grid mirrors the
 *    server's verdict rather than guessing, so a locked cell is always
 *    genuinely locked.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';
import { useState } from 'react';
import { api, ApiError, type DeliverableRow, type VarianceSummary } from '@/lib/api';
import { formatNumber, formatZar, formatZarRate } from '@/lib/format';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { NumericCell } from '@/components/data-table/NumericCell';
import { varianceTone } from '@/components/lifecycle/status-badge';

const helper = createColumnHelper<DeliverableRow>();

interface Props {
  deliverables: DeliverableRow[];
  summary: VarianceSummary;
  canEditPlanned: boolean;
  plannedLockReason: string | null;
  canEditActuals: boolean;
  actualsLockReason: string | null;
  onChanged?: () => void;
}

/** Small inline numeric editor used for planned and actual quantities. */
function QuantityCell({
  value,
  disabled,
  hint,
  onSave,
}: {
  value: number;
  disabled: boolean;
  hint?: string;
  onSave: (next: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const dirty = draft !== null && Number(draft) !== value;

  if (disabled) {
    return (
      <span className="font-mono tabular-nums" title={hint}>
        {formatNumber(value)}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        step="0.01"
        min="0"
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (dirty) onSave(Number(draft));
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (dirty) onSave(Number(draft));
            setDraft(null);
          }
          if (e.key === 'Escape') setDraft(null);
        }}
        className="w-20 rounded border border-input bg-background px-1.5 py-0.5 text-right font-mono text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={hint}
      />
      {dirty && <span className="text-[10px] text-warning">↵</span>}
    </span>
  );
}

export function DeliverableGrid({
  deliverables,
  summary,
  canEditPlanned,
  plannedLockReason,
  canEditActuals,
  actualsLockReason,
  onChanged,
}: Props) {
  const queryClient = useQueryClient();

  const savePlanned = useMutation({
    mutationFn: ({ id, quantity }: { id: number; quantity: number }) =>
      api.patch(`/api/job-deliverables/${id}/planned`, { plannedQuantity: quantity }),
    onSuccess: () => {
      toast.add({ title: 'Planned quantity updated', type: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      onChanged?.();
    },
    onError: (e: Error) =>
      toast.add({
        title: 'Could not update the plan',
        description: e instanceof ApiError ? e.message : e.message,
        type: 'error',
      }),
  });

  const saveActual = useMutation({
    mutationFn: ({ id, quantity }: { id: number; quantity: number }) =>
      api.patch(`/api/job-deliverables/${id}/actual`, { actualQuantity: quantity }),
    onSuccess: () => {
      toast.add({ title: 'Actual recorded', type: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      onChanged?.();
    },
    onError: (e: Error) =>
      toast.add({
        title: 'Could not record the actual',
        description: e instanceof ApiError ? e.message : e.message,
        type: 'error',
      }),
  });

  // The mutation hooks need the job id for cache invalidation; take it from the
  // first deliverable, which always shares the job.
  const jobId = deliverables[0]?.jobId ?? 0;

  const columns = [
    helper.accessor('code', {
      header: 'Service Code',
      cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
    }),
    helper.accessor('description', {
      header: 'Description',
      cell: (info) => (
        <span className="block max-w-xs truncate" title={info.getValue()}>
          {info.getValue()}
        </span>
      ),
    }),
    helper.accessor('uom', { header: 'UOM' }),
    helper.accessor('appliedRate', {
      header: 'Applied Rate',
      cell: (info) => {
        const row = info.row.original;
        return (
          <span className="inline-flex items-center gap-1">
            <span className="font-mono tabular-nums">{formatZarRate(row.appliedRate)}</span>
            {row.rateHasDrifted && (
              <span
                className="cursor-help text-[10px] text-warning"
                title={
                  `The service code has since been re-priced to ${formatZarRate(row.currentRate ?? 0)}.\n` +
                  'This job keeps the rate captured at scoping time.'
                }
              >
                ⚠
              </span>
            )}
          </span>
        );
      },
    }),
    helper.accessor('plannedQuantity', {
      header: 'Planned Qty',
      cell: (info) => (
        <QuantityCell
          value={info.getValue()}
          disabled={!canEditPlanned}
          hint={`Planned quantity for ${info.row.original.code}`}
          onSave={(quantity) => savePlanned.mutate({ id: info.row.original.id, quantity })}
        />
      ),
    }),
    helper.accessor('plannedSubtotal', {
      header: 'Planned Subtotal',
      cell: (info) => <span className="font-mono tabular-nums">{formatZar(info.getValue())}</span>,
    }),
    helper.accessor('actualQuantity', {
      header: 'Actual Qty',
      cell: (info) => (
        <QuantityCell
          value={info.getValue()}
          disabled={!canEditActuals}
          hint={`Actual quantity for ${info.row.original.code}`}
          onSave={(quantity) => saveActual.mutate({ id: info.row.original.id, quantity })}
        />
      ),
    }),
    helper.accessor('actualSubtotal', {
      header: 'Actual Subtotal',
      cell: (info) => <span className="font-mono tabular-nums">{formatZar(info.getValue())}</span>,
    }),
    helper.display({
      id: 'qtyVariance',
      header: 'Variance Qty',
      cell: (info) => (
        <span
          className={`font-mono tabular-nums ${varianceTone(info.row.original.quantityVariance)}`}
        >
          {info.row.original.quantityVariance > 0 ? '+' : ''}
          {formatNumber(info.row.original.quantityVariance)}
        </span>
      ),
    }),
    helper.display({
      id: 'valueVariance',
      header: 'Variance ZAR',
      cell: (info) => (
        <span className={`font-mono tabular-nums ${varianceTone(info.row.original.valueVariance)}`}>
          {info.row.original.valueVariance > 0 ? '+' : ''}
          {formatZar(info.row.original.valueVariance)}
        </span>
      ),
    }),
  ] as ColumnDef<DeliverableRow>[];

  const table = useReactTable({
    data: deliverables,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="space-y-3">
      {/* The grid has ten columns of financial detail, so it scrolls horizontally
          on narrow screens. Say so, rather than letting the variance columns look
          simply missing. */}
      <p className="text-[11px] text-muted-foreground xl:hidden">
        Scroll the table sideways to see actual quantities and variance.
      </p>
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead
                  key={header.id}
                  scope="col"
                  className={
                    header.id.includes('Subtotal') || header.id.includes('Variance')
                      ? 'text-right'
                      : ''
                  }
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <NumericCell
                  key={cell.id}
                  className={
                    cell.column.id.includes('Subtotal') || cell.column.id.includes('Variance')
                      ? undefined
                      : ''
                  }
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </NumericCell>
              ))}
            </TableRow>
          ))}
          {deliverables.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns.length} className="text-center text-muted-foreground">
                No deliverables scoped on this job yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {/* ---- Totals ---- */}
      <div className="flex flex-wrap items-center justify-end gap-6 border-t pt-3 text-sm">
        <span className="text-muted-foreground">
          Planned{' '}
          <span className="ml-1 font-mono tabular-nums">{formatZar(summary.plannedSubtotal)}</span>
        </span>
        <span className="text-muted-foreground">
          Actual{' '}
          <span className="ml-1 font-mono tabular-nums">{formatZar(summary.actualSubtotal)}</span>
        </span>
        <span className="text-muted-foreground">
          Variance{' '}
          <span className={`ml-1 font-mono tabular-nums ${varianceTone(summary.valueVariance)}`}>
            {summary.valueVariance > 0 ? '+' : ''}
            {formatZar(summary.valueVariance)}
          </span>
        </span>
      </div>

      {/* ---- Lock explanations, shown only when something is locked ---- */}
      {!canEditPlanned && plannedLockReason && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
          {plannedLockReason}
        </p>
      )}
      {!canEditActuals && actualsLockReason && (
        <p className="text-xs text-muted-foreground">{actualsLockReason}</p>
      )}
      {summary.linesOverrun > 0 && (
        <p className="text-xs text-muted-foreground">
          {summary.linesOverrun} of {summary.lineCount} deliverables came in above plan.
        </p>
      )}
      {!canEditPlanned && !canEditActuals && (
        <Button size="sm" variant="outline" disabled>
          Scope frozen
        </Button>
      )}
    </div>
  );
}
