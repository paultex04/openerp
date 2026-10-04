'use client';

/**
 * Invoice lifecycle controls.
 *
 * Renders only the transitions the server reports as permitted, exactly as the
 * job stepper does. The UI never decides legality — a rule that lives in two
 * places eventually disagrees, and here the disagreement would be a billing
 * clerk being offered a button that 422s.
 *
 * Refused options are listed with their reasons rather than hidden: "why can I
 * not mark this paid?" is a real question and the answer is worth showing.
 */
import { useMutation } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, type InvoiceTransitionOption } from '@/lib/api';

const TERMINAL = new Set(['Paid', 'Cancelled']);

export function invoiceVariant(status: string) {
  if (status === 'Paid') return 'success';
  if (status === 'Cancelled') return 'destructive';
  if (status === 'Disputed') return 'destructive';
  if (status === 'Approved' || status === 'Partially Paid') return 'success';
  if (status === 'Submitted') return 'warning';
  return 'secondary';
}

export function InvoiceTransitions({
  invoiceId,
  status,
  transitions,
  onTransitioned,
}: {
  invoiceId: number;
  status: string;
  transitions: InvoiceTransitionOption[];
  onTransitioned?: () => void;
}) {
  const { toast } = useToast();

  const move = useMutation({
    mutationFn: (to: string) => api.post(`/api/invoices/${invoiceId}/transition`, { status: to }),
    onSuccess: (result) => {
      const jobStatus = (result as { transition?: { jobStatus?: string } }).transition?.jobStatus;
      toast({
        title: 'Invoice updated',
        description: jobStatus ? `Job moved to ${jobStatus}.` : undefined,
        variant: 'success',
      });
      onTransitioned?.();
    },
    onError: (e: Error) =>
      toast({
        title: 'Transition refused',
        description: e instanceof ApiError ? e.message : e.message,
        variant: 'destructive',
      }),
  });

  const permitted = transitions.filter((t) => t.allowed);
  const refused = transitions.filter((t) => !t.allowed);
  const isTerminal = TERMINAL.has(status);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={invoiceVariant(status)}>{status}</Badge>

        {isTerminal ? (
          <span className="text-sm text-muted-foreground">
            {status === 'Paid'
              ? 'Settled in full. This document is financial history.'
              : 'Cancelled. This document is closed.'}
          </span>
        ) : permitted.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            No transitions are available to you at this stage.
          </span>
        ) : (
          permitted.map((t) => (
            <Button
              key={t.to}
              size="sm"
              variant={t.to === 'Cancelled' ? 'destructive' : 'outline'}
              onClick={() => move.mutate(t.to)}
              disabled={move.isPending}
              title={t.reason}
            >
              {t.to === 'Cancelled' ? 'Cancel invoice' : `Mark ${t.to}`}
            </Button>
          ))
        )}
      </div>

      {refused.length > 0 && (
        <details className="rounded-md border p-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Why can I not do some of these?
          </summary>
          <ul className="mt-2 space-y-1">
            {refused.map((t) => (
              <li key={t.to} className="text-muted-foreground">
                <span className="font-medium">{t.to}</span> — {t.reason}
                {t.requiredPermission && (
                  <span className="ml-1 opacity-70">({t.requiredPermission})</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
