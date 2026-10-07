'use client';

/**
 * Billing hand-off on the job: what has been invoiced, and the button that raises
 * a draft from the measured actuals.
 *
 * ## The button creates an invoice; it does not move the job
 *
 * Moving the job to 10. Invoiced / 11. Partially Invoiced happens when an invoice
 * is *approved*, via `markJobInvoiced` — the invoice lifecycle owns that, not this
 * control. This button only calls `POST /api/jobs/:id/invoices`, which raises a
 * Draft. Every figure on that draft is derived server-side from the job's measured
 * actuals and the amendment; the caller supplies nothing financial.
 *
 * Offered only from 07. Pack Ready onward and the reason is always visible — the
 * API enforces the same rule and returns 409 with this explanation, so hiding it
 * without explanation would leave a billing clerk guessing.
 */

import { useMutation } from '@tanstack/react-query';
import { FilePlus2 } from 'lucide-react';
import { api, ApiError, type JobDetail } from '@/lib/api';
import { usePermissions } from '@/components/auth/usePermissions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';
import { formatZar } from '@/lib/format';
import { invoiceVariant } from '@/lib/lifecycle-status';

/**
 * Job stages from which billing will accept an invoice. Mirrors the API.
 *
 * Duplicated rather than imported because the server's set lives in
 * `server/src/billing/service.ts`, which the client cannot import. If the two
 * disagree the server wins with a 409 — this list only decides whether the button
 * is shown, never whether generation succeeds.
 */
const BILLABLE_STATUSES = new Set([
  '07. Pack Ready',
  '08. Out for signature',
  '09. Awaiting change order',
  '10. Invoiced',
  '11. Partially Invoiced',
]);

type Job = JobDetail['job'];

export function JobBillingCard({
  job,
  onChanged,
}: {
  job: Job;
  onChanged: () => void;
}) {
  const { can, loading } = usePermissions();
  const canWrite = can('invoice.write');
  const billable = BILLABLE_STATUSES.has(job.status);

  const generate = useMutation({
    mutationFn: () =>
      api.post<{ invoice: { id: number; invoiceNumber: string } }>(
        `/api/jobs/${job.id}/invoices`,
        {},
      ),
    onSuccess: (result) => {
      toast.add({
        title: `Draft ${result.invoice.invoiceNumber} raised`,
        description: 'Review it on the Billing page before submitting.',
        type: 'success',
      });
      onChanged();
    },
    onError: (e: Error) =>
      toast.add({
        title: 'Could not raise an invoice',
        // Shown verbatim: the server names the blocker (open invoice, no
        // actuals, not yet billable) and a paraphrase would drift.
        description: e instanceof ApiError ? e.message : e.message,
        type: 'error',
      }),
  });

  // NOTE: this must stay a <section>, not a bare <Card>.
  //
  // The selected-job column is a height-capped flex container, and every shadcn
  // Card carries `overflow-hidden` — which resets its automatic minimum height
  // to zero, so as a direct flex item it shrinks below its content and then
  // clips it. That is exactly what happened here: the card rendered 32px tall
  // (header only) with 154px of content clipped inside it, while the invoice
  // list and the button sat invisibly in the DOM. A <section> is
  // overflow-visible, so its minimum is its content and it refuses the shrink.
  // The sibling panels return sections for the same structural reason.
  return (
    <section className="space-y-4">
    <Card>
      <CardHeader>
        <CardTitle>Billing</CardTitle>
        <CardDescription>
          Invoices raised from this job&apos;s measured actuals.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {job.invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No invoices raised yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {job.invoices.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono text-xs">{inv.invoiceNumber}</span>
                <Badge variant={invoiceVariant(inv.status)}>{inv.status}</Badge>
                <span className="ml-auto font-mono tabular-nums">
                  {formatZar(inv.totalWithTax)}
                </span>
              </li>
            ))}
          </ul>
        )}

        {!loading && !canWrite && (
          <p className="text-xs text-muted-foreground">
            You do not hold <code className="font-mono">invoice.write</code>, so drafts cannot
            be raised from this job.
          </p>
        )}

        {!loading && canWrite && !billable && (
          <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
            Billing takes ownership at 07. Pack Ready. This job is at {job.status}, so an
            invoice cannot be raised yet — revenue is not recognised against work whose scope
            is still being planned or executed.
          </p>
        )}

        {!loading && canWrite && billable && (
          <Button size="sm" onClick={() => generate.mutate()} disabled={generate.isPending}>
            <FilePlus2 aria-hidden="true" className="size-4" />
            {generate.isPending ? 'Raising…' : 'Raise draft invoice'}
          </Button>
        )}
      </CardContent>
    </Card>
    </section>
  );
}
