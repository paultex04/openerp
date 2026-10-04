'use client';

/**
 * Global cost parameter configuration.
 *
 * Percentages are stored in `contract_cost_parameters.numeric_value` as **percent
 * numbers** (7 means 7%), while the API's `engine` projection returns fractions.
 * This component edits the raw percent number and shows the fraction the engine
 * will actually use, because mixing those two units up is the single easiest way
 * to inflate a rate tenfold.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, ApiError, type CostParameterRow, type EngineParameters } from '@/lib/api';
import { formatNumber, formatPercent } from '@/lib/format';

interface Props {
  amendmentId: number;
  amendmentNumber: string;
  canEdit: boolean;
}

interface ParametersResponse {
  amendment: { id: number; amendmentNumber: string; vatRate: number };
  parameters: CostParameterRow[];
  engine: EngineParameters;
}

/**
 * Only *edited* values are held. Anything absent falls back to the server value,
 * so the draft starts empty and stays correct as data refreshes.
 */
type Draft = Record<string, string>;

export function CostParameterTable(props: Props) {
  // The edit buffer is keyed by amendment, so switching amendment remounts this
  // component and its state is rebuilt from the newly fetched rows. That avoids
  // copying props into state inside an effect (which causes a cascading render)
  // and guarantees the draft can never belong to a different amendment.
  return <CostParameterForm key={props.amendmentId} {...props} />;
}

function CostParameterForm({ amendmentId, amendmentNumber, canEdit }: Props) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>({});

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['cost-parameters', amendmentId],
    queryFn: () => api.get<ParametersResponse>(`/api/amendments/${amendmentId}/cost-parameters`),
  });

  const save = useMutation({
    mutationFn: async (parameters: Array<Omit<CostParameterRow, 'id' | 'amendmentId'>>) =>
      api.put<{ parameters: CostParameterRow[] }>(
        `/api/amendments/${amendmentId}/cost-parameters`,
        {
          parameters,
        },
      ),
    onSuccess: async () => {
      toast.add({ title: 'Cost parameters saved', type: 'success' });
      await queryClient.invalidateQueries({ queryKey: ['cost-parameters', amendmentId] });
    },
    onError: (e: Error) =>
      toast.add({
        title: 'Could not save parameters',
        description: e instanceof ApiError ? e.message : 'Unexpected error.',
        type: 'error',
      }),
  });

  const handleChange = (name: string, value: string) =>
    setDraft((prev) => ({ ...prev, [name]: value }));

  const handleSave = () => {
    if (!data) return;
    const payload = data.parameters.map((p) => ({
      category: p.category,
      parameterName: p.parameterName,
      numericValue: Number(draft[p.parameterName] ?? p.numericValue),
      uom: p.uom,
      notes: p.notes,
    }));
    save.mutate(payload);
  };

  if (isLoading) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">Loading cost parameters…</p>
    );
  }

  if (isError) {
    return (
      <p className="py-8 text-center text-sm text-destructive">
        {error instanceof ApiError ? error.message : 'Could not load cost parameters.'}
      </p>
    );
  }

  const isPercentRow = (p: CostParameterRow) => p.uom.trim() === '%';
  const dirty =
    data !== undefined &&
    data.parameters.some((p) => Number(draft[p.parameterName]) !== p.numericValue);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold">Cost parameters</h3>
          <p className="text-xs text-muted-foreground">
            Amendment {amendmentNumber}. Percentages are entered as percent numbers (7 = 7%); the
            engine consumes them as fractions.
          </p>
        </div>
        {canEdit && (
          <Button onClick={handleSave} disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save parameters'}
          </Button>
        )}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Category</TableHead>
            <TableHead scope="col">Parameter</TableHead>
            <TableHead scope="col" className="text-right">
              Value
            </TableHead>
            <TableHead scope="col">Unit</TableHead>
            <TableHead scope="col" className="text-right">
              Engine fraction
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data!.parameters.map((p) => {
            const value = draft[p.parameterName] ?? String(p.numericValue);
            const asNumber = Number(value);
            const valid = Number.isFinite(asNumber);
            const percent = isPercentRow(p);

            return (
              <TableRow key={p.id}>
                <TableCell>
                  <Badge variant="outline">{p.category}</Badge>
                </TableCell>
                <TableCell className="font-medium">{p.parameterName}</TableCell>
                <TableCell className="text-right">
                  {canEdit ? (
                    <input
                      type="number"
                      step={percent ? 0.01 : 0.0001}
                      value={value}
                      onChange={(e) => handleChange(p.parameterName, e.target.value)}
                      className="w-32 rounded-md border border-input bg-background px-2 py-1 text-right font-mono text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`${p.parameterName} value`}
                    />
                  ) : (
                    <span className="font-mono tabular-nums">{formatNumber(p.numericValue)}</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{p.uom}</TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {percent && valid ? (
                    <span className="font-mono tabular-nums">{formatPercent(asNumber / 100)}</span>
                  ) : (
                    '—'
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {data!.parameters.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No cost parameters are configured for this amendment.
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Amendment VAT rate:{' '}
        <span className="font-mono tabular-nums">{formatPercent(data!.amendment.vatRate)}</span>
      </p>
    </div>
  );
}
