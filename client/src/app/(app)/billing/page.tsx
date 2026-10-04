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

export default function BillingPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const register = useQuery({
    queryKey: ['invoices', statusFilter, search],
    queryFn: () =>
      api.get<{ invoices: InvoiceRow[] }>(
        `/api/invoices?${new URLSearchParams({
          ...(statusFilter ? { status: statusFilter } : {}),
          ...(search ? { search } : {}),
        })}`,
      ),
  });

  const invoices = register.data?.invoices ?? [];

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
          <p className="text-sm text-muted-foreground">
            Invoices generated from measured actuals, with VAT treatment and lifecycle control.
          </p>
        </div>
        <span className="text-sm text-muted-foreground">
          {invoices.length} invoice{invoices.length === 1 ? '' : 's'}
        </span>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        {/* ---- Register ---- */}
        <section className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search number or client"
              aria-label="Search invoices"
              className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              aria-label="Filter by status"
              className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            >
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          {register.isError && (
            <p className="text-sm text-destructive">
              {register.error instanceof ApiError
                ? register.error.message
                : 'Could not load the invoice register.'}
            </p>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Invoice</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Issued</TableHead>
                <TableHead scope="col" className="text-right">
                  Total
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((invoice) => (
                <TableRow
                  key={invoice.id}
                  data-state={invoice.id === selectedId ? 'selected' : undefined}
                  className={invoice.id === selectedId ? 'bg-accent' : undefined}
                >
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => setSelectedId(invoice.id)}
                      className="text-left font-medium hover:underline"
                    >
                      {invoice.invoiceNumber}
                    </button>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {invoice.job.project.contract.client.name}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={invoiceVariant(invoice.status)}>{invoice.status}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {formatDate(invoice.issueDate)}
                  </TableCell>
                  <NumericCell>{formatZar(invoice.totalWithTax)}</NumericCell>
                </TableRow>
              ))}
              {invoices.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    No invoices match this filter.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
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
