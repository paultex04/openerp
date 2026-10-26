'use client';

/**
 * Billing workspace: the invoice register and, on the right, the selected
 * invoice's tax layout.
 *
 * The document is laid out for reading rather than for the database: parties and
 * VAT numbers at the top, a line table with the snapshot prices, then the totals
 * block, the compliance verdict and the lifecycle controls. That layout is what a
 * printer produces and what the specification asks for, so the same component
 * serves both.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useEffect, useMemo, useState } from 'react';
import { FileDown, Plus } from 'lucide-react';
import {
  api,
  ApiError,
  type InvoiceDetail,
  type InvoiceRow,
  type InvoiceTransitionOption,
} from '@/lib/api';
import { InvoiceTransitions } from '@/components/billing/InvoicePanel';
import { NewInvoiceDialog } from '@/components/billing/NewInvoiceDialog';
import { usePermissions } from '@/components/auth/usePermissions';
import { invoiceVariant } from '@/lib/lifecycle-status';
import { Badge } from '@/components/ui/badge';
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
import { DataTable } from '@/components/data-table/data-table';
import { formatDate, formatNumber, formatPercent, formatZar, formatZarRate } from '@/lib/format';
import { toast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const STATUSES = [
  'Draft',
  'Submitted',
  'Approved',
  'Partially Paid',
  'Paid',
  'Disputed',
  'Cancelled',
];

/**
 * Column definitions for the register.
 *
 * Declared at module scope so the array identity is stable across renders.
 * `DataTable` memoises the row model on this reference; a definition rebuilt on
 * every render would defeat that and re-run sorting on each keystroke.
 */
const invoiceColumns = (onOpen: (id: number) => void): ColumnDef<any, InvoiceRow, unknown>[] => [
  {
    id: 'invoiceNumber',
    accessorKey: 'invoiceNumber',
    header: 'Invoice',
    enableHiding: false,
    cell: ({ row }) => (
      <span className="block max-w-[12rem]">
        <button
          type="button"
          className="text-left font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={`Open invoice ${row.original.invoiceNumber}`}
          onClick={() => onOpen(row.original.id)}
        >
          {row.original.invoiceNumber}
        </button>
        <span className="block truncate text-[11px] text-muted-foreground">
          {row.original.job.project.contract.client.name}
        </span>
      </span>
    ),
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => (
      <Badge variant={invoiceVariant(row.original.status)}>{row.original.status}</Badge>
    ),
  },
  {
    id: 'client',
    header: 'Client',
    accessorFn: (row) => row.job.project.contract.client.name,
    cell: ({ row }) => (
      <span className="text-xs truncate max-w-40 block" title={row.original.job.project.contract.client.name}>
        {row.original.job.project.contract.client.name}
      </span>
    ),
  },
  {
    id: 'contract',
    header: 'Contract',
    accessorFn: (row) => row.job.project.contract.number,
    cell: ({ row }) => (
      <span className="font-mono text-xs">{row.original.job.project.contract.number}</span>
    ),
  },
  {
    id: 'project',
    header: 'Project',
    accessorFn: (row) => row.job.project.code,
    cell: ({ row }) => (
      <span className="font-mono text-xs">{row.original.job.project.code}</span>
    ),
  },
  {
    id: 'job',
    header: 'Job',
    accessorFn: (row) => row.job.id,
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground">#{row.original.job.id}</span>
    ),
  },
  {
    id: 'issueDate',
    accessorKey: 'issueDate',
    header: 'Issued',
    cell: ({ row }) => (
      <span className="text-xs whitespace-nowrap">{formatDate(row.original.issueDate)}</span>
    ),
  },
  {
    id: 'dueDate',
    accessorKey: 'dueDate',
    header: 'Due',
    cell: ({ row }) => (
      <span className="text-xs whitespace-nowrap">{formatDate(row.original.dueDate)}</span>
    ),
  },
  {
    id: 'subtotalAmount',
    accessorKey: 'subtotalAmount',
    header: 'Subtotal excl. VAT',
    meta: { align: 'right' },
    cell: ({ row }) => <span className="tabular-nums">{formatZar(row.original.subtotalAmount)}</span>,
  },
  {
    id: 'taxAmount',
    accessorKey: 'taxAmount',
    header: 'SARS 15% VAT',
    meta: { align: 'right' },
    cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{formatZar(row.original.taxAmount)}</span>,
  },
  {
    id: 'totalWithTax',
    accessorKey: 'totalWithTax',
    header: 'Total incl. VAT',
    meta: { align: 'right' },
    cell: ({ row }) => <span className="font-medium tabular-nums">{formatZar(row.original.totalWithTax)}</span>,
  },
  {
    id: 'lineCount',
    accessorKey: 'lineCount',
    header: 'Lines',
    meta: { align: 'right' },
    cell: ({ row }) => <span className="tabular-nums">{row.original.lineCount}</span>,
  },
  {
    id: 'pdf',
    header: 'PDF',
    meta: { align: 'right' },
    cell: ({ row }) => (
      <Button
        size="sm"
        variant="ghost"
        className="size-7 p-0"
        title="Download Tax Invoice PDF"
        onClick={(e) => {
          e.stopPropagation();
          window.open(`/api/invoices/${row.original.id}/pdf`, '_blank');
        }}
      >
        <FileDown className="size-4 text-muted-foreground hover:text-primary" />
        <span className="sr-only">Download PDF</span>
      </Button>
    ),
  },
];

export default function BillingPage() {
  const { can } = usePermissions();
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newInvoiceOpen, setNewInvoiceOpen] = useState(false);

  const register = useQuery({
    // Fetched unfiltered: `DataTable` owns filtering. The previous version sent
    // `status` and `search` to the server and refetched on every keystroke,
    // which meant a request per character typed and a round trip to answer a
    // question the client already had the data for.
    queryKey: ['invoices'],
    queryFn: () => api.get<{ invoices: InvoiceRow[] }>('/api/invoices'),
  });

  const invoices = register.data?.invoices ?? [];
  const columns = useMemo(() => invoiceColumns(setSelectedId), []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
          <p className="text-sm text-muted-foreground">
            Invoices generated from measured actuals, with VAT treatment and lifecycle control.
          </p>
        </div>
        {/*
          The button needs both permissions: creating an invoice is
          `invoice.write`, and the job picker reads `/api/jobs` (`job.read`).
          Rendering it without either would promise a dialog that 403s.
        */}
        {can('invoice.write') && can('job.read') && (
          <Button onClick={() => setNewInvoiceOpen(true)}>New invoice</Button>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* ---- Register ---- */}
        <section className="flex min-h-0 flex-1 flex-col gap-3">
          {register.isError && (
            <p className="text-sm text-negative">
              {register.error instanceof ApiError
                ? register.error.message
                : 'Could not load the invoice register.'}
            </p>
          )}

          {/*
            The register is a search-and-act list, so it gets the shared
            DataTable: free-text search, a status filter, sortable columns and
            pagination. Its previous hand-rolled toolbar had search and a status
            filter but no sorting and no paging, and the two controls were styled
            separately from every other register in the app.

            Note the invoice *lines* further down are deliberately NOT a
            DataTable: they are the body of a printable document, and a toolbar
            would appear on the printed page.
          */}
          <DataTable<InvoiceRow>
            tableId="billing-invoices"
            caption="Invoice register"
            data={invoices}
            columns={columns}
            rowKey={(invoice) => invoice.id}
            searchKeys={[
              'invoiceNumber',
              'job.project.contract.number',
              'job.project.contract.client.name',
            ]}
            searchPlaceholder="Search invoice, contract or client…"
            isLoading={register.isLoading}
            initialSort={[{ id: 'issueDate', desc: true }]}
            emptyMessage="No invoices match the current search and filters."
            initialColumnVisibility={{
              invoiceNumber: true,
              status: true,
              client: true,
              contract: false,
              project: false,
              job: false,
              issueDate: true,
              dueDate: true,
              subtotalAmount: false,
              taxAmount: false,
              totalWithTax: true,
              lineCount: false,
              pdf: true,
            }}
            onRowClick={(row) => setSelectedId(row.id)}
            emptyAction={
              can('invoice.write') ? (
                <Button size="sm" onClick={() => setNewInvoiceOpen(true)}>
                  <Plus aria-hidden="true" className="size-4 mr-1.5" />
                  New Tax Invoice
                </Button>
              ) : undefined
            }
            filters={[
              {
                id: 'status',
                label: 'Status',
                value: statusFilter,
                options: [
                  { value: '', label: 'All statuses' },
                  ...STATUSES.map((status) => ({ value: status, label: status })),
                ],
                onChange: setStatusFilter,
                predicate: (invoice, selected) => invoice.status === selected,
              },
            ]}
          />
        </section>

        <Dialog open={selectedId !== null} onOpenChange={(open) => !open && setSelectedId(null)}>
          <DialogContent className="flex max-h-[92dvh] w-[min(96vw,80rem)] max-w-none flex-col overflow-hidden p-0 sm:max-w-none">
            <DialogHeader className="shrink-0 border-b px-6 py-4">
              <DialogTitle>Invoice detail</DialogTitle>
              <DialogDescription>
                Invoice document, lifecycle actions and billing position.
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 overflow-y-auto px-6 py-4">
              {selectedId !== null && (
                <InvoiceDocument invoiceId={selectedId} onClose={() => setSelectedId(null)} />
              )}
            </div>
          </DialogContent>
        </Dialog>

        <NewInvoiceDialog
          open={newInvoiceOpen}
          onOpenChange={setNewInvoiceOpen}
          onCreated={(invoiceId) => setSelectedId(invoiceId)}
        />
      </div>
    </div>
  );
}

function InvoiceDocument({ invoiceId, onClose }: { invoiceId: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [draftDueDate, setDraftDueDate] = useState('');
  const [draftNotes, setDraftNotes] = useState('');

  const detail = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: () => api.get<InvoiceDetail>(`/api/invoices/${invoiceId}`),
  });

  const transitions = useQuery({
    queryKey: ['invoice-transitions', invoiceId],
    queryFn: () =>
      api.get<{ from: string; transitions: InvoiceTransitionOption[] }>(
        `/api/invoices/${invoiceId}/transitions`,
      ),
    enabled: detail.isSuccess,
  });

  const refresh = () => {
    void detail.refetch();
    void transitions.refetch();
    void queryClient.invalidateQueries({ queryKey: ['invoices'] });
  };

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/invoices/${invoiceId}`),
    onSuccess: () => {
      toast.add({ title: 'Invoice deleted', type: 'success' });
      onClose();
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
    onError: (e: Error) =>
      toast.add({
        title: 'Could not delete',
        description: e instanceof ApiError ? e.message : e.message,
        type: 'error',
      }),
  });
  const draftSave = useMutation({
    mutationFn: () =>
      api.patch(`/api/invoices/${invoiceId}`, {
        dueDate: draftDueDate || null,
        notes: draftNotes || null,
      }),
    onSuccess: () => {
      toast.add({ title: 'Draft invoice updated', type: 'success' });
      refresh();
    },
    onError: (error: Error) =>
      toast.add({
        title: 'Could not update draft invoice',
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      }),
  });

  useEffect(() => {
    const invoice = detail.data?.invoice;
    if (!invoice) return;
    setDraftDueDate(invoice.dueDate ?? '');
    setDraftNotes(invoice.notes ?? '');
  }, [detail.data?.invoice.id, detail.data?.invoice.dueDate, detail.data?.invoice.notes]);

  if (detail.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading invoice…</p>;
  }

  if (detail.isError) {
    return (
      <p className="text-sm text-destructive">
        {detail.error instanceof ApiError ? detail.error.message : 'Could not load the invoice.'}
      </p>
    );
  }

  if (!detail.data) {
    return <p className="text-sm text-muted-foreground">Invoice not found.</p>;
  }

  const { invoice, lines, client, job, vat, compliance, permissions, jobPosition } = detail.data;

  return (
    <article className="space-y-5 rounded-lg border p-5 print:border-0">
      {/* ---- Header: parties and identity ---- */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{invoice.invoiceNumber}</h2>
          <p className="text-xs text-muted-foreground">
            Issued {formatDate(invoice.issueDate)} · Due {formatDate(invoice.dueDate)}
          </p>
          {permissions.canEdit && (
            <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">Due date</span>
                <input
                  type="date"
                  value={draftDueDate}
                  onChange={(event) => setDraftDueDate(event.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-2"
                />
              </label>
              <label className="space-y-1 text-xs sm:col-span-2">
                <span className="text-muted-foreground">Notes</span>
                <textarea
                  value={draftNotes}
                  onChange={(event) => setDraftNotes(event.target.value)}
                  rows={2}
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5"
                />
              </label>
              <div className="sm:col-span-2">
                <Button size="sm" onClick={() => draftSave.mutate()} disabled={draftSave.isPending}>
                  {draftSave.isPending ? 'Saving…' : 'Save draft details'}
                </Button>
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Job #{job.id} · {job.project.code} · {job.project.contract.number}
          </p>
          {job.workOrder && (
            <p className="font-mono text-[11px] text-muted-foreground">WO {job.workOrder}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2 text-right">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="flex items-center gap-1.5"
              onClick={() => window.open(`/api/invoices/${invoiceId}/pdf`, '_blank')}
              title="Download official SARS-compliant Tax Invoice PDF"
            >
              <FileDown className="size-4 text-primary" />
              <span>Download PDF</span>
            </Button>
            <Badge variant={invoiceVariant(invoice.status)}>{invoice.status}</Badge>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">{client.name}</p>
          <p className="text-[11px] text-muted-foreground">
            {client.isVatRegistered ? 'VAT registered' : 'Not VAT registered'}
            {client.vatNumber ? ` · ${client.vatNumber}` : ''}
          </p>
        </div>
      </div>

      {/* ---- Compliance ---- */}
      {!compliance.ok && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          <p className="font-medium">Compliance warnings</p>
          <ul className="mt-1 list-disc pl-4">
            {compliance.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ---- Lines ---- */}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Code</TableHead>
              <TableHead scope="col">Description</TableHead>
              <TableHead scope="col" className="text-right">
                Qty
              </TableHead>
              <TableHead scope="col">UOM</TableHead>
              <TableHead scope="col" className="text-right">
                Unit price
              </TableHead>
              <TableHead scope="col" className="text-right">
                Subtotal
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((line) => (
              <TableRow key={line.id}>
                <TableCell className="font-mono text-xs">{line.code}</TableCell>
                <TableCell>
                  <span className="block max-w-xs truncate" title={line.description ?? ''}>
                    {line.description ?? '—'}
                  </span>
                </TableCell>
                <NumericCell>{formatNumber(line.billedQuantity)}</NumericCell>
                <TableCell className="text-xs">{line.uom}</TableCell>
                <NumericCell>{formatZarRate(line.unitPrice)}</NumericCell>
                <NumericCell>{formatZar(line.subtotal)}</NumericCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* ---- Totals ---- */}
      <div className="flex justify-end">
        <dl className="w-full max-w-xs space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Subtotal (excl. VAT)</dt>
            <dd className="font-mono tabular-nums">{formatZar(vat.subtotalAmount)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">
              VAT @ {formatPercent(vat.effectiveTaxRate)}
              {vat.taxRate !== vat.effectiveTaxRate && (
                <span className="ml-1 opacity-70">
                  (amendment {formatPercent(vat.taxRate)}, not applied)
                </span>
              )}
            </dt>
            <dd className="font-mono tabular-nums">{formatZar(vat.taxAmount)}</dd>
          </div>
          <div className="flex justify-between border-t pt-1 text-base font-semibold">
            <dt>Total due</dt>
            <dd className="font-mono tabular-nums">{formatZar(vat.totalWithTax)}</dd>
          </div>
        </dl>
      </div>

      {/* ---- Job position ---- */}
      <div className="rounded-md border p-3 text-xs">
        <p className="font-medium">Job billing position</p>
        <dl className="mt-1 grid grid-cols-3 gap-2 text-muted-foreground">
          <div>
            <dt>Job actuals</dt>
            <dd className="font-mono tabular-nums text-foreground">
              {formatZar(jobPosition.jobActualTotal)}
            </dd>
          </div>
          <div>
            <dt>Recognised</dt>
            <dd className="font-mono tabular-nums text-foreground">
              {formatZar(jobPosition.recognisedBilledTotal)}
            </dd>
          </div>
          <div>
            <dt>Remaining</dt>
            <dd className="font-mono tabular-nums text-foreground">
              {formatZar(jobPosition.remainingUnbilled)}
            </dd>
          </div>
        </dl>
        {jobPosition.remainingUnbilled < 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Negative because job actuals are VAT-exclusive while the invoice total includes VAT.
          </p>
        )}
      </div>

      {invoice.notes && (
        <p className="rounded-md border p-3 text-xs">
          <span className="font-medium">Notes: </span>
          {invoice.notes}
        </p>
      )}

      {/* ---- Lifecycle ---- */}
      <div className="border-t pt-4">
        <InvoiceTransitions
          invoiceId={invoiceId}
          status={invoice.status}
          transitions={transitions.data?.transitions ?? []}
          onTransitioned={refresh}
        />
        {permissions.canDelete && (
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              Delete invoice
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}
