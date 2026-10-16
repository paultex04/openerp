'use client';

/**
 * Raise a draft invoice from a job's measured actuals, from the billing
 * register.
 *
 * One dialog, three steps: search the eligible jobs, look at the lines that
 * will be billed, confirm. The picker is fed by the server's `billable` filter
 * on `GET /api/jobs` — a billable status (07. Pack Ready onward) and no open
 * invoice — which is exactly what the create endpoint will enforce, so the
 * list cannot offer a job that would 409 or hide one that would succeed.
 *
 * The preview is read-only by decision: the engine can invoice a subset of
 * lines, but the everyday case is "bill the measured work", and line-trimming
 * at this step invents a workflow nobody asked for. The created draft opens in
 * the register's detail popup so due dates and submission are one click away.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError, type JobDetail, type JobListResponse } from '@/lib/api';
import { StatusPill } from '@/components/lifecycle/status-badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NumericCell } from '@/components/data-table/NumericCell';
import { toast } from '@/components/ui/toast';
import { useDebounced } from '@/hooks/use-debounced';
import { formatNumber, formatZar, formatZarRate } from '@/lib/format';

/** Jobs offered per picker request. The search box narrows; paging does not. */
const PICKER_PAGE_SIZE = 25;

const PICKER_SEARCH_DEBOUNCE = 300;

/**
 * Sticky header cell for the lines preview.
 *
 * The classes sit on the cells, not on a wrapping `TableHeader`: a sticky row
 * keeps its box where it was and loses its border from view the moment it pins,
 * and `ui/table.tsx`'s `Table` would wrap the table in a scroll container of
 * its own, detaching the header from the region that actually scrolls. Same
 * reasoning - and the same classes - as `DataTable`.
 */
const stickyHead = 'sticky top-0 z-10 border-b bg-card';

export function NewInvoiceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new draft's id once it exists; opens the detail popup. */
  onCreated: (invoiceId: number) => void;
}) {
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounced(searchInput, PICKER_SEARCH_DEBOUNCE);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Reset on open: a stale search or a selection from the last invoice would
  // be worse than starting from empty.
  useEffect(() => {
    if (open) {
      setSearchInput('');
      setSelectedId(null);
    }
  }, [open]);

  const jobs = useQuery({
    queryKey: ['jobs', 'billable-picker', { search }],
    queryFn: () => {
      const params = new URLSearchParams({
        billable: 'true',
        page: '1',
        pageSize: String(PICKER_PAGE_SIZE),
      });
      if (search) params.set('search', search);
      return api.get<JobListResponse>(`/api/jobs?${params.toString()}`);
    },
    enabled: open,
    // Keep the previous list while the next search loads, so the picker does
    // not collapse to a skeleton on every keystroke.
    placeholderData: (previous) => previous,
  });

  const detail = useQuery({
    queryKey: ['job', selectedId],
    queryFn: () => api.get<JobDetail>(`/api/jobs/${selectedId}`),
    enabled: open && selectedId !== null,
  });

  const billableLines = (detail.data?.deliverables ?? []).filter((line) => line.actualQuantity > 0);
  const previewTotal = billableLines.reduce((sum, line) => sum + line.actualSubtotal, 0);

  const create = useMutation({
    mutationFn: (jobId: number) =>
      api.post<{ invoice: { id: number; invoiceNumber: string } }>(
        `/api/jobs/${jobId}/invoices`,
        {},
      ),
    onSuccess: (result) => {
      toast.add({ title: `Draft ${result.invoice.invoiceNumber} created`, type: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      // The job now has an open invoice, so it must drop out of the picker.
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      onOpenChange(false);
      onCreated(result.invoice.id);
    },
    onError: (error: Error) =>
      toast.add({
        title: 'Could not create the invoice',
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      }),
  });

  const rows = jobs.data?.jobs ?? [];
  const total = jobs.data?.total ?? rows.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] w-[min(96vw,64rem)] max-w-none flex-col overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>New invoice</DialogTitle>
          <DialogDescription>
            Pick a job billing can invoice — 07. Pack Ready onward, with no open invoice — then
            confirm the measured lines. The draft opens once it is created.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-4 overflow-hidden px-6 py-4 lg:grid-cols-[1fr_1.2fr]">
          {/* ---- Job picker ---- */}
          <div className="flex min-h-0 flex-col gap-2">
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search job, work order, PO, area, project or supervisor…"
              aria-label="Search eligible jobs"
              className="h-9"
            />
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
              {jobs.isLoading && <p className="p-3 text-sm text-muted-foreground">Loading jobs…</p>}
              {jobs.isError && (
                <p className="p-3 text-sm text-destructive">
                  {jobs.error instanceof ApiError
                    ? jobs.error.message
                    : 'Could not load the eligible jobs.'}
                </p>
              )}
              {!jobs.isLoading && !jobs.isError && rows.length === 0 && (
                <p className="p-3 text-sm text-muted-foreground">
                  No eligible jobs{search ? ' match that search' : ''}. A job becomes billable at
                  07. Pack Ready, once it has no open invoice.
                </p>
              )}
              {rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setSelectedId(row.id)}
                  aria-pressed={row.id === selectedId}
                  className={`flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none ${
                    row.id === selectedId ? 'bg-accent' : ''
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="font-mono font-medium">#{row.id}</span>
                    <StatusPill status={row.status} />
                  </span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {row.project.code} · {row.project.contract.number}
                    {row.project.contract.client?.name
                      ? ` · ${row.project.contract.client.name}`
                      : ''}
                  </span>
                  {row.description && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {row.description}
                    </span>
                  )}
                </button>
              ))}
            </div>
            {total > rows.length && (
              <p className="text-xs text-muted-foreground">
                Showing {rows.length} of {total} — refine the search to narrow the list.
              </p>
            )}
          </div>

          {/* ---- Lines preview ---- */}
          <div className="flex min-h-0 flex-col gap-2">
            {selectedId === null ? (
              <p className="text-sm text-muted-foreground">
                Pick a job to see the measured lines that will be billed.
              </p>
            ) : detail.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading the job’s measured lines…</p>
            ) : detail.isError ? (
              <p className="text-sm text-destructive">
                {detail.error instanceof ApiError
                  ? detail.error.message
                  : 'Could not load the job.'}
              </p>
            ) : (
              <>
                <div className="bg-card min-h-0 flex-1 overflow-y-auto rounded-md border">
                  <table className="w-full caption-bottom text-sm">
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col" className={stickyHead}>
                          Code
                        </TableHead>
                        <TableHead scope="col" className={stickyHead}>
                          Description
                        </TableHead>
                        <TableHead scope="col" className={`${stickyHead} text-right`}>
                          Qty
                        </TableHead>
                        <TableHead scope="col" className={stickyHead}>
                          UOM
                        </TableHead>
                        <TableHead scope="col" className={`${stickyHead} text-right`}>
                          Unit price
                        </TableHead>
                        <TableHead scope="col" className={`${stickyHead} text-right`}>
                          Subtotal
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {billableLines.map((line) => (
                        <TableRow key={line.id}>
                          <TableCell className="font-mono text-xs">{line.code}</TableCell>
                          <TableCell>
                            <span className="block max-w-56 truncate" title={line.description}>
                              {line.description}
                            </span>
                          </TableCell>
                          <NumericCell>{formatNumber(line.actualQuantity)}</NumericCell>
                          <TableCell className="text-xs">{line.uom}</TableCell>
                          <NumericCell>{formatZarRate(line.appliedRate)}</NumericCell>
                          <NumericCell>{formatZar(line.actualSubtotal)}</NumericCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </table>
                  {billableLines.length === 0 && (
                    <p className="p-3 text-sm text-muted-foreground">
                      This job has no measured actuals — there is nothing to bill yet. Actuals are
                      recorded against the job’s line items during the work stages.
                    </p>
                  )}
                </div>

                <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  <span className="text-muted-foreground">
                    {billableLines.length} line{billableLines.length === 1 ? '' : 's'} · VAT from
                    the job’s amendment is applied on creation
                  </span>
                  <span className="font-mono font-medium tabular-nums">
                    {formatZar(previewTotal)}
                  </span>
                </div>

                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() => selectedId !== null && create.mutate(selectedId)}
                    disabled={create.isPending || billableLines.length === 0}
                  >
                    {create.isPending ? 'Creating…' : 'Create draft invoice'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
