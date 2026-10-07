'use client';

/**
 * "Add line item": search the job's amendment's service codes and attach one.
 *
 * ## The picker is scoped to the job's amendment, and that is a correctness rule
 *
 * Service codes and rates are amendment-scoped. The server refuses a line whose
 * service code belongs to a different amendment with `AMENDMENT_MISMATCH` — a job
 * must not price itself against another contract's terms. So the search sends
 * `?amendmentId=<the job's resolved amendment>`, and the user is never offered a code
 * the server will reject.
 *
 * The resolved amendment matters: a job with `amendmentId: null` inherits its
 * project's, and the detail endpoint already reports which one it resolved to.
 * Passing `null` here would silently widen the picker to every code in the system.
 *
 * ## Default quantity and rate
 *
 * The planned quantity defaults to 1 and the applied rate to the code's current
 * calculated rate. Both are editable, because both are routinely overridden at
 * scoping time — but defaulting them means the common case is one click rather than
 * seven keystrokes, and an explicit rate is always visible in the dialog so nobody
 * attaches a line at a rate they did not mean to.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2, Search } from 'lucide-react';
import { api, ApiError, type JobDetail } from '@/lib/api';
import { useDebounced } from '@/hooks/use-debounced';
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
import { formatZarRate } from '@/lib/format';

interface ServiceCodeOption {
  id: number;
  code: string;
  description: string;
  category: string;
  uom: string;
  calculatedUnitRate?: number;
}

/** Debounce for the code search, in ms. */
const SEARCH_DEBOUNCE = 250;

export function AddLineItemDialog({
  job,
  onClose,
  onAdded,
}: {
  job: JobDetail['job'];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<ServiceCodeOption | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [rate, setRate] = useState('');

  // Debounced: typing a code should not fire a query per keystroke.
  const search = useDebounced(term, SEARCH_DEBOUNCE);

  const codes = useServiceCodeSearch(job.amendmentId, search);

  const add = useMutation({
    mutationFn: (payload: {
      serviceCodeId: number;
      plannedQuantity: number;
      appliedRate: number;
    }) => api.post(`/api/jobs/${job.id}/deliverables`, payload),
    onSuccess: () => {
      toast.add({ title: 'Line item added', type: 'success' });
      onAdded();
    },
    onError: (error: Error) =>
      toast.add({
        title: 'Could not add the line item',
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      }),
  });

  const canSubmit =
    selected !== null && Number(quantity) > 0 && Number(rate) >= 0 && !add.isPending;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add line item to job #{job.id}</DialogTitle>
          <DialogDescription>
            Showing service codes from amendment {job.amendment?.amendmentNumber ?? '—'}, which is
            the basis this job prices against.
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
                // Choosing a code resets the overrides, which were set for the
                // previous one.
                setSelected(null);
              }}
              placeholder="Search service code or description."
              aria-label="Search service codes"
              autoFocus
              className="pl-8"
            />
          </div>

          <div
            role="listbox"
            aria-label="Service codes"
            className="max-h-64 overflow-y-auto rounded-md border"
          >
            {codes.isLoading ? (
              <p className="p-3 text-sm text-muted-foreground">Loading service codes…</p>
            ) : codes.data.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                No service codes match. Codes are amendment-scoped, so a code that exists for
                another amendment will not appear here.
              </p>
            ) : (
              codes.data.map((code) => (
                <button
                  key={code.id}
                  type="button"
                  role="option"
                  aria-selected={selected?.id === code.id}
                  onClick={() => {
                    setSelected(code);
                    setRate(String(code.calculatedUnitRate ?? ''));
                  }}
                  className={`flex w-full items-baseline justify-between gap-3 border-b px-3 py-2 text-left last:border-b-0 hover:bg-accent ${
                    selected?.id === code.id ? 'bg-accent' : ''
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block font-mono text-xs">{code.code}</span>
                    <span className="block truncate text-sm">{code.description}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {code.uom} · {formatZarRate(code.calculatedUnitRate ?? 0)}
                  </span>
                </button>
              ))
            )}
          </div>

          {selected && (
            <Card>
              <CardHeader>
                <CardTitle>Line details</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label htmlFor="line-qty" className="text-sm font-medium">
                      Planned quantity ({selected.uom})
                    </label>
                    <Input
                      id="line-qty"
                      type="number"
                      min="0"
                      step="0.01"
                      value={quantity}
                      onChange={(event) => setQuantity(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="line-rate" className="text-sm font-medium">
                      Applied rate (ZAR per {selected.uom})
                    </label>
                    <Input
                      id="line-rate"
                      type="number"
                      min="0"
                      step="0.01"
                      value={rate}
                      onChange={(event) => setRate(event.target.value)}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Snapshot on the line when it is added. Later rate changes will not move
                      this figure.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!selected) return;
              add.mutate({
                serviceCodeId: selected.id,
                plannedQuantity: Number(quantity),
                appliedRate: Number(rate),
              });
            }}
            disabled={!canSubmit}
          >
            {add.isPending && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
            Add to job
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** ------------------------------------------------------------------------- */

/**
 * Service codes for one amendment.
 *
 * Always queried, never conditionally skipped: the dialog opens with an empty
 * search, and showing the amendment's codes immediately is more useful than an empty
 * list with a cursor in it.
 */
function useServiceCodeSearch(amendmentId: number, search: string) {
  const query = useQuery({
    queryKey: ['service-codes', 'by-amendment', amendmentId, search],
    queryFn: async () => {
      const params = new URLSearchParams({ amendmentId: String(amendmentId) });
      if (search) params.set('search', search);
      const result = await api.get<{ serviceCodes: ServiceCodeOption[] }>(
        `/api/service-codes?${params.toString()}`,
      );
      return result.serviceCodes;
    },
  });

  return { ...query, data: useMemo(() => query.data ?? [], [query.data]) };
}
