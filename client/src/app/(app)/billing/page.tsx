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
import { useState } from 'react';
import {
  api,
  ApiError,
  type InvoiceDetail,
  type InvoiceRow,
  type InvoiceTransitionOption,
} from '@/lib/api';
import { InvoiceTransitions } from '@/components/billing/InvoicePanel';
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
const invoiceColumns: ColumnDef<any, InvoiceRow, unknown>[] = [
  {
    id: 'invoiceNumber',
    accessorKey: 'invoiceNumber',
    header: 'Invoice',
    cell: ({ row }) => (
      <span className="block max-w-[12rem]">
        <span className="block font-medium">{row.original.invoiceNumber}</span>
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
    id: 'totalWithTax',
    accessorKey: 'totalWithTax',
    header: 'Total incl. VAT',
    meta: { align: 'right' },
    cell: ({ row }) => <span className="font-medium">{formatZar(row.original.totalWithTax)}</span>,
  },
];

export default function BillingPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const register = useQuery({
    // Fetched unfiltered: `DataTable` owns filtering. The previous version sent
    // `status` and `search` to the server and refetched on every keystroke,
    // which meant a request per character typed and a round trip to answer a
    // question the client already had the data for.
    queryKey: ['invoices'],
    queryFn: () => api.get<{ invoices: InvoiceRow[] }>('/api/invoices'),
  });

  const invoices = register.data?.invoices ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
          <p className="text-sm text-muted-foreground">
            Invoices generated from measured actuals, with VAT treatment and lifecycle control.
          </p>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        {/* ---- Register ---- */}
        <section className="space-y-3">
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
            caption="Invoice register"
            fill
            data={invoices}
            columns={invoiceColumns}
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
            renderRowActions={(invoice) => (
              <Button
                size="sm"
                variant={invoice.id === selectedId ? 'secondary' : 'ghost'}
                onClick={() => setSelectedId(invoice.id)}
              >
                Open
              </Button>
            )}
          />
        </section>

        {/* ---- Document ---- */}
        <section className="space-y-3">
          {selectedId === null ? (
            <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              Select an invoice to see its tax layout.
            </p>
          ) : (
            <InvoiceDocument invoiceId={selectedId} onClose={() => setSelectedId(null)} />
          )}
        </section>
      </div>
    </div>
  );
}

function InvoiceDocument({ invoiceId, onClose }: { invoiceId: number; onClose: () => void }) {
  const queryClient = useQueryClient();

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
          <p className="text-xs text-muted-foreground">
            Job #{job.id} · {job.project.code} · {job.project.contract.number}
          </p>
          {job.workOrder && (
            <p className="font-mono text-[11px] text-muted-foreground">WO {job.workOrder}</p>
          )}
        </div>
        <div className="text-right">
          <Badge variant={invoiceVariant(invoice.status)}>{invoice.status}</Badge>
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
