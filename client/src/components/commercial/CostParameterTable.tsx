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
import { Plus } from 'lucide-react';
import { costParameterCategoryValues, type CostParameterCategory } from '@openerp/shared';
import { usePermissions } from '@/components/auth/usePermissions';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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

/** Percent rows are entered as percent numbers (7 = 7%); see the table header. */
const isPercentRow = (p: CostParameterRow) => p.uom.trim() === '%';

export function CostParameterTable(props: Props) {
  // The edit buffer is keyed by amendment, so switching amendment remounts this
  // component and its state is rebuilt from the newly fetched rows. That avoids
  // copying props into state inside an effect (which causes a cascading render)
  // and guarantees the draft can never belong to a different amendment.
  return <CostParameterForm key={props.amendmentId} {...props} />;
}

function CostParameterForm({ amendmentId, amendmentNumber, canEdit }: Props) {
  const queryClient = useQueryClient();
  const { roles } = usePermissions();
  const isAdmin = roles.includes('administrator');
  const [draft, setDraft] = useState<Draft>({});
  const [isAddOpen, setIsAddOpen] = useState(false);

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
        <div className="flex items-center gap-2">
          {isAdmin && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsAddOpen(true)}
              className="gap-1.5"
            >
              <Plus className="size-3.5" />
              Add parameter
            </Button>
          )}
          {canEdit && (
            <Button onClick={handleSave} disabled={!dirty || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save parameters'}
            </Button>
          )}
        </div>
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

      {isAdmin && (
        <AddCostParameterDialog
          open={isAddOpen}
          onOpenChange={setIsAddOpen}
          amendmentId={amendmentId}
        />
      )}
    </div>
  );
}

interface AddCostParameterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  amendmentId: number;
}

function AddCostParameterDialog({ open, onOpenChange, amendmentId }: AddCostParameterDialogProps) {
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<CostParameterCategory>('Equipment');
  const [parameterName, setParameterName] = useState('');
  const [numericValue, setNumericValue] = useState('');
  const [uom, setUom] = useState('per Day');
  const [notes, setNotes] = useState('');

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<{ parameter: CostParameterRow }>(`/api/amendments/${amendmentId}/cost-parameters`, {
        category,
        parameterName: parameterName.trim(),
        numericValue: Number(numericValue),
        uom: uom.trim(),
        notes: notes.trim() || null,
      }),
    onSuccess: async () => {
      toast.add({ title: 'Cost parameter created', type: 'success' });
      await queryClient.invalidateQueries({ queryKey: ['cost-parameters', amendmentId] });
      onOpenChange(false);
      setParameterName('');
      setNumericValue('');
      setNotes('');
    },
    onError: (e: Error) =>
      toast.add({
        title: 'Could not create parameter',
        description: e instanceof ApiError ? e.message : e.message,
        type: 'error',
      }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!parameterName.trim() || numericValue.trim() === '' || !uom.trim()) return;
    createMutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add cost parameter</DialogTitle>
          <DialogDescription>
            Configure a new global cost parameter for this amendment. Only administrators can add
            parameters.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="param-category">Category</FieldLabel>
            <select
              id="param-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as CostParameterCategory)}
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {costParameterCategoryValues.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </Field>

          <Field>
            <FieldLabel htmlFor="param-name">Parameter name</FieldLabel>
            <Input
              id="param-name"
              placeholder="e.g. Cherry Picker, Fuel Levy"
              value={parameterName}
              onChange={(e) => setParameterName(e.target.value)}
              required
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="param-val">Numeric value</FieldLabel>
              <Input
                id="param-val"
                type="number"
                step="any"
                placeholder={uom === '%' ? '7 (for 7%)' : '0.00'}
                value={numericValue}
                onChange={(e) => setNumericValue(e.target.value)}
                required
              />
              <FieldDescription>
                {uom === '%' ? 'Percent number (7 = 7%)' : 'Authoritative base value'}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="param-uom">Unit of measure</FieldLabel>
              <Input
                id="param-uom"
                placeholder="%, per Day, per Hour"
                value={uom}
                onChange={(e) => setUom(e.target.value)}
                required
              />
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="param-notes">Notes (optional)</FieldLabel>
            <Input
              id="param-notes"
              placeholder="Contractual basis or revision reference"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                createMutation.isPending ||
                !parameterName.trim() ||
                numericValue.trim() === '' ||
                !uom.trim()
              }
            >
              {createMutation.isPending ? 'Creating…' : 'Add parameter'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
