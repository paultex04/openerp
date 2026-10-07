'use client';

/**
 * "Add invoice": pick a job and raise a draft from its measured actuals.
 *
 * ## Selecting the job populates everything
 *
 * An invoice has no independent fields worth typing: the client, the lines, the
 * rates and the VAT basis all come from the job. So choosing the job *is* the
 * form — the dialog then shows exactly what the server will store, computed with
 * the same `computeVat` engine, before anything is created.
 *
 * The preview is indicative, not authoritative. The draft stores the
 * server-computed figures; if the data changed between preview and submit, the
 * stored invoice reflects the submit-time values. That is why the confirm button
 * says "Raise draft" rather than "Save these figures".
 *
 * ## Only measured lines can be billed
 *
 * Lines with no recorded actual are shown but disabled: the server skips them
 * silently, and a checked box the server ignores would be a lie about what the
 * invoice contains. Unchecking a measured line is partial invoicing, which the
 * server supports via `deliverableIds`.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2, Search } from 'lucide-react';
import { computeVat, isOpenInvoiceStatus, type InvoiceStatus } from '@openerp/shared';
import {
  api,
  ApiError,
  type ContractRow,
  type JobDetail,
  type JobListResponse,
} from '@/lib/api';
import { useDebounced } from '@/hooks/use-debounced';
import { StatusPill } from '@/components/lifecycle/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { formatZar, formatZarRate } from '@/lib/format';

/**
 * Job stages billing will accept an invoice from. Mirrors the API — see the note
 * on `BILLABLE_STATUSES` in `JobBillingCard` for why the duplication exists.
 */
const BILLABLE_STATUSES = new Set([
  '07. Pack Ready',
  '08. Out for signature',
  '09. Awaiting change order',
  '10. Invoiced',
  '11. Partially Invoiced',
]);

const SEARCH_DEBOUNCE = 250;

export function AddInvoiceDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (invoiceId: number) => void;
}) {
  const [term, setTerm] = useState('');
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);

  const search = useDebounced(term, SEARCH_DEBOUNCE);

  const jobs = useQuery({
    queryKey: ['jobs', 'invoice-picker', search],
    queryFn: () =>
      api.get<JobListResponse>('/api/jobs', { search: search || undefined, pageSize: 20 }),
  });

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add invoice</DialogTitle>
          <DialogDescription>
            Select a job. The client, lines, rates and VAT are populated from it —
            an invoice bills measured work, so there is nothing else to type.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={term}
              onChange={(event) => {
                setTerm(event.target.value);
                setSelectedJobId(null);
              }}
              placeholder="Search job, work order, PO or project."
              aria-label="Search jobs"
              autoFocus
              className="pl-8"
            />
          </div>

          <div
            role="listbox"
            aria-label="Jobs"
            className="max-h-56 overflow-y-auto rounded-md border"
          >
            {jobs.isLoading ? (
              <p className="p-3 text-sm text-muted-foreground">Loading jobs…</p>
            ) : (jobs.data?.jobs ?? []).length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">No jobs match.</p>
            ) : (
              (jobs.data?.jobs ?? []).map((job) => {
                const billable = BILLABLE_STATUSES.has(job.status);
                return (
                  <button
                    key={job.id}
                    type="button"
                    role="option"
                    aria-selected={selectedJobId === job.id}
                    disabled={!billable}
                    title={
                      billable
                        ? undefined
                        : `Cannot invoice: job is at ${job.status}; billing takes ownership at 07. Pack Ready.`
                    }
                    onClick={() => setSelectedJobId(job.id)}
                    className={`flex w-full items-baseline justify-between gap-3 border-b px-3 py-2 text-left last:border-b-0 hover:bg-accent disabled:opacity-60 disabled:hover:bg-transparent ${
                      selectedJobId === job.id ? 'bg-accent' : ''
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block font-mono text-xs">
                        #{job.id} · {job.project.code}
                      </span>
                      <span className="block truncate text-sm">
                        {job.description ?? 'No description'}
                      </span>
                    </span>
                    <StatusPill status={job.status} />
                  </button>
                );
              })
            )}
          </div>

          {selectedJobId !== null && (
            <InvoicePreview
              key={selectedJobId}
              jobId={selectedJobId}
              onClose={onClose}
              onCreated={onCreated}
            />
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** ------------------------------------------------------------------------- */

function InvoicePreview({
  jobId,
  onClose,
  onCreated,
}: {
  jobId: number;
  onClose: () => void;
  onCreated: (invoiceId: number) => void;
}) {
  // `null` means "every measured line": the server's default when
  // `deliverableIds` is omitted. An explicit array is only sent once the user
  // unchecks something, which is partial invoicing.
  const [checked, setChecked] = useState<number[] | null>(null);
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');

  const detail = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.get<JobDetail>(`/api/jobs/${jobId}`),
  });

  const contracts = useQuery({
    queryKey: ['contracts'],
    queryFn: () => api.get<{ contracts: ContractRow[] }>('/api/contracts'),
    enabled: detail.isSuccess,
  });

  const create = useMutation({
    mutationFn: (body: { deliverableIds?: number[]; dueDate?: string; notes?: string | null }) =>
      api.post<{ invoice: { id: number; invoiceNumber: string } }>(
        `/api/jobs/${jobId}/invoices`,
        body,
      ),
    onSuccess: (result) => {
      toast.add({
        title: `Draft ${result.invoice.invoiceNumber} raised`,
        description: 'Review it in the register before submitting.',
        type: 'success',
      });
      onCreated(result.invoice.id);
    },
    onError: (error: Error) =>
      toast.add({
        title: 'Could not raise the invoice',
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      }),
  });

  const job = detail.data?.job;
  const deliverables = useMemo(() => detail.data?.deliverables ?? [], [detail.data]);
  const billableLines = useMemo(
    () => deliverables.filter((d) => d.actualQuantity > 0),
    [deliverables],
  );

  const selectedIds = checked ?? billableLines.map((d) => d.id);
  const selectedLines = useMemo(
    () => billableLines.filter((d) => selectedIds.includes(d.id)),
    [billableLines, selectedIds],
  );

  const client = useMemo(() => {
    const contractId = job?.project.contract.id;
    if (contractId === undefined) return null;
    return (
      (contracts.data?.contracts ?? []).find((c) => c.id === contractId)?.client ?? null
    );
  }, [contracts.data, job]);

  const vat = useMemo(() => {
    if (!job) return null;
    return computeVat({
      lines: selectedLines.map((d) => ({ quantity: d.actualQuantity, unitPrice: d.appliedRate })),
      taxRate: job.amendment?.vatRate ?? 0,
      // The preview needs *a* boolean; the server loads the real client row. If
      // the contracts list has not answered yet, assume registered so the
      // preview shows VAT rather than hiding it.
      isVatRegistered: client?.isVatRegistered ?? true,
    });
  }, [selectedLines, job, client]);

  const openInvoice = useMemo(
    () => (job?.invoices ?? []).find((inv) => isOpenInvoiceStatus(inv.status as InvoiceStatus)),
    [job],
  );

  if (detail.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading job…</p>;
  }

  if (detail.isError || !job || !vat) {
    return (
      <p className="text-sm text-destructive">
        {detail.error instanceof ApiError
          ? detail.error.message
          : 'Could not load the job.'}
      </p>
    );
  }

  const toggle = (id: number) => {
    const current = checked ?? billableLines.map((d) => d.id);
    setChecked(
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );
  };

  const canSubmit =
    selectedLines.length > 0 && !openInvoice && !create.isPending;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>
            Job #{job.id} · {job.project.code}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p className="text-muted-foreground">
            {job.project.contract.number} · {client?.name ?? job.project.contract.client.name}
            {client && !client.isVatRegistered && ' · not VAT registered'}
          </p>
          <p className="text-muted-foreground">
            Amendment {job.amendment?.amendmentNumber ?? '—'}
            {job.amendmentInherited && ' (inherited from project)'}
          </p>
        </CardContent>
      </Card>

      {openInvoice && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
          Job #{job.id} already has open invoice {openInvoice.invoiceNumber} (
          {openInvoice.status}). Submit, cancel or void it before raising another — two
          concurrent documents billing the same actuals would double-bill.
        </p>
      )}

      {billableLines.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
          This job has no measured actuals yet. Actuals are recorded in the field view
          during 04. WIP to 06. Actuals in Progress — an invoice with no lines would be
          a document billing nothing.
        </p>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Lines to bill</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {deliverables.map((d) => {
              const measurable = d.actualQuantity > 0;
              const isChecked = measurable && selectedIds.includes(d.id);
              return (
                <label
                  key={d.id}
                  className={`flex items-baseline gap-2 text-sm ${measurable ? '' : 'opacity-60'}`}
                  title={measurable ? undefined : 'No measured actual — the server skips this line.'}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={!measurable}
                    onChange={() => toggle(d.id)}
                    className="mt-1"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-xs">{d.code}</span>
                    <span className="block truncate">{d.description}</span>
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums">
                    {d.actualQuantity} {d.uom} × {formatZarRate(d.appliedRate)}
                  </span>
                </label>
              );
            })}
          </CardContent>
        </Card>
      )}

      {selectedLines.length > 0 && (
        <dl className="grid grid-cols-3 gap-4 rounded-md border p-3 text-sm">
          <div className="space-y-1">
            <dt className="text-[11px] text-muted-foreground">Subtotal (excl. VAT)</dt>
            <dd className="font-mono tabular-nums">{formatZar(vat.subtotalAmount)}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-[11px] text-muted-foreground">
              VAT @ {Math.round(vat.effectiveTaxRate * 100)}%
            </dt>
            <dd className="font-mono tabular-nums">{formatZar(vat.taxAmount)}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-[11px] text-muted-foreground">Total due</dt>
            <dd className="font-mono tabular-nums">{formatZar(vat.totalWithTax)}</dd>
          </div>
        </dl>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="inv-due" className="text-xs font-medium text-muted-foreground">
            Due date (optional)
          </label>
          <Input
            id="inv-due"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="inv-notes" className="text-xs font-medium text-muted-foreground">
            Notes (optional)
          </label>
          <textarea
            id="inv-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
            maxLength={2000}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() =>
            create.mutate({
              // Omitted when everything measured is selected: the server bills
              // all measured lines by default, and an explicit full list would be
              // a second source of truth about what "all" means.
              ...(checked !== null &&
              checked.length !== billableLines.length
                ? { deliverableIds: checked }
                : {}),
              ...(dueDate ? { dueDate } : {}),
              ...(notes.trim() ? { notes: notes.trim() } : {}),
            })
          }
          disabled={!canSubmit}
        >
          {create.isPending && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
          Raise draft
        </Button>
      </div>
    </div>
  );
}
