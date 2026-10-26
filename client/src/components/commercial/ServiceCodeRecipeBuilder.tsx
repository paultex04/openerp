'use client';

/**
 * Service code recipe builder.
 *
 * For an **Activity** code it attaches trade roles with crew size and hours per
 * unit; for an **R1 Material** code it builds a procurement BOM with a markup.
 *
 * Every mutation returns the parent's recomputed rate *and* the variance against
 * the stored rate. The variance banner is not decoration: ADR-001 Q2 requires that
 * service code S00167401 keeps its historical 27.9158 even though a recomputation
 * yields 27.8639, so accepting a new rollup must be an explicit click.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { serviceCodeCategoryValues, type ServiceCodeCategory } from '@openerp/shared';
import { usePermissions } from '@/components/auth/usePermissions';
import {
  api,
  ApiError,
  type ComputationResult,
  type RateCardRow,
  type ServiceCodeDetail,
} from '@/lib/api';
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
import { NumericCell } from '@/components/data-table/NumericCell';
import { formatDelta, formatNumber, formatPercent, formatZarRate } from '@/lib/format';

interface Props {
  amendmentId: number;
  canEdit: boolean;
}

/** Renders the variance between the recomputed and stored rollups. */
function VarianceBanner({
  computation,
  canAccept,
  onAccept,
  accepting,
}: {
  computation: ComputationResult;
  canAccept: boolean;
  onAccept: () => void;
  accepting: boolean;
}) {
  if (computation.variance.matches) {
    return (
      <div className="rounded-md border border-success/40 bg-success/10 p-3 text-xs text-success">
        <span className="font-medium">Rate in agreement.</span>{' '}
        <span className="text-muted-foreground">
          Recomputed {formatZarRate(computation.variance.computed)} matches the stored rate.
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
      <p className="font-medium">Recomputed rate differs from the stored rate</p>
      <p className="mt-1 text-muted-foreground">
        Computed{' '}
        <span className="font-mono tabular-nums">
          {formatZarRate(computation.variance.computed)}
        </span>{' '}
        versus stored{' '}
        <span className="font-mono tabular-nums">{formatZarRate(computation.variance.stored)}</span>{' '}
        ({formatDelta(computation.variance.delta)}). The stored rate is left untouched until you
        accept it — historic jobs and issued invoices keep their original pricing.
      </p>
      {canAccept && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={onAccept}
          disabled={accepting}
        >
          {accepting ? 'Applying…' : 'Accept recomputed rate'}
        </Button>
      )}
    </div>
  );
}

export function ServiceCodeRecipeBuilder({ amendmentId, canEdit }: Props) {
  const queryClient = useQueryClient();
  const { roles } = usePermissions();
  const isAdmin = roles.includes('administrator');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isAddOpen, setIsAddOpen] = useState(false);

  const codes = useQuery({
    queryKey: ['service-codes', amendmentId],
    queryFn: () =>
      api.get<{
        serviceCodes: Array<{
          id: number;
          code: string;
          description: string;
          category: string;
          uom: string;
          calculatedUnitRate: number;
        }>;
      }>('/api/service-codes', { amendmentId }),
  });

  const rates = useQuery({
    queryKey: ['service-master-rates', amendmentId],
    queryFn: () => api.get<{ rates: RateCardRow[] }>('/api/service-master-rates', { amendmentId }),
    enabled: canEdit,
  });

  const detail = useQuery({
    queryKey: ['service-code', selectedId],
    queryFn: () =>
      api.get<{ serviceCode: ServiceCodeDetail; computation: ComputationResult }>(
        `/api/service-codes/${selectedId}`,
      ),
    enabled: selectedId !== null,
  });

  const invalidate = () => queryClient.invalidateQueries();

  const acceptRate = useMutation({
    mutationFn: () => api.post(`/api/service-codes/${selectedId}/apply-rate`),
    onSuccess: async () => {
      toast.add({ title: 'Recomputed rate applied', type: 'success' });
      await invalidate();
    },
    onError: (e: Error) =>
      toast.add({
        title: 'Could not apply rate',
        description: e instanceof ApiError ? e.message : e.message,
        type: 'error',
      }),
  });

  const addLabourLine = useMutation({
    mutationFn: (body: {
      serviceMasterRateId: number;
      crewQuantity: number;
      hoursPerUnit: number;
    }) => api.post(`/api/service-code-labour-items`, { serviceCodeId: selectedId, ...body }),
    onSuccess: async () => {
      toast.add({ title: 'Labour line added', type: 'success' });
      await invalidate();
    },
    onError: (e: Error) =>
      toast.add({
        title: 'Could not add labour line',
        description: e instanceof ApiError ? e.message : e.message,
        type: 'error',
      }),
  });

  const removeLabourLine = useMutation({
    mutationFn: (id: number) => api.delete(`/api/service-code-labour-items/${id}`),
    onSuccess: invalidate,
    onError: (e: Error) =>
      toast.add({
        title: 'Could not remove line',
        description: e instanceof ApiError ? e.message : e.message,
        type: 'error',
      }),
  });

  const addMaterialLine = useMutation({
    mutationFn: (body: { description: string; unitCost: number; quantity: number; uom: string }) =>
      api.post(`/api/service-code-material-items`, { serviceCodeId: selectedId, ...body }),
    onSuccess: async () => {
      toast.add({ title: 'Material line added', type: 'success' });
      await invalidate();
    },
    onError: (e: Error) =>
      toast.add({
        title: 'Could not add material line',
        description: e instanceof ApiError ? e.message : e.message,
        type: 'error',
      }),
  });

  const removeMaterialLine = useMutation({
    mutationFn: (id: number) => api.delete(`/api/service-code-material-items/${id}`),
    onSuccess: invalidate,
    onError: (e: Error) =>
      toast.add({
        title: 'Could not remove line',
        description: e instanceof ApiError ? e.message : e.message,
        type: 'error',
      }),
  });

  // ---- New-line form state ----------------------------------------------
  const [rateId, setRateId] = useState('');
  const [crew, setCrew] = useState('1');
  const [hours, setHours] = useState('0.01');
  const [itemDesc, setItemDesc] = useState('');
  const [unitCost, setUnitCost] = useState('0');
  const [qty, setQty] = useState('1');
  const [uom, setUom] = useState('EA');

  const code = detail.data?.serviceCode;
  const computation = detail.data?.computation;
  const isActivity = code?.category === 'Activity';

  const labourTotal = useMemo(
    () =>
      (code?.labourItems ?? []).reduce(
        (acc, l) => acc + l.crewQuantity * l.hoursPerUnit * l.serviceMasterRate.fullLoadedRate,
        0,
      ),
    [code?.labourItems],
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
      {/* ---- Master list ---- */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Service codes</h3>
          {isAdmin && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsAddOpen(true)}
              className="gap-1 text-xs"
            >
              <Plus className="size-3.5" />
              New code
            </Button>
          )}
        </div>
        {codes.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
        <ul className="max-h-[32rem] space-y-1 overflow-auto">
          {(codes.data?.serviceCodes ?? []).map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setSelectedId(c.id)}
                className={`w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  selectedId === c.id
                    ? 'border-primary bg-accent'
                    : 'border-transparent hover:bg-accent/50'
                }`}
              >
                <span className="block font-mono text-xs">{c.code}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {c.description}
                </span>
                <span className="mt-1 flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">
                    {c.category}
                  </Badge>
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {formatZarRate(c.calculatedUnitRate)}/{c.uom}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* ---- Recipe detail ---- */}
      <div className="space-y-4">
        {!code && (
          <p className="text-sm text-muted-foreground">Select a service code to edit its recipe.</p>
        )}

        {code && computation && (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">
                  <span className="font-mono">{code.code}</span> · {code.description}
                </h3>
                <p className="text-xs text-muted-foreground">
                  Unit of measure {code.uom} · amendment {code.amendment.amendmentNumber} · VAT{' '}
                  {formatPercent(code.amendment.vatRate)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Calculated unit rate</p>
                <p className="text-2xl font-semibold tabular-nums">
                  {formatZarRate(computation.computed)}
                </p>
                <p className="text-xs text-muted-foreground">
                  per {code.uom} · stored {formatZarRate(code.calculatedUnitRate)}
                </p>
              </div>
            </div>

            <VarianceBanner
              computation={computation}
              canAccept={canEdit}
              onAccept={() => acceptRate.mutate()}
              accepting={acceptRate.isPending}
            />

            {/* ---- Activity: labour recipe ---- */}
            {isActivity && (
              <div className="space-y-3">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Trade role</TableHead>
                      <TableHead scope="col">Code</TableHead>
                      <TableHead scope="col" className="text-right">
                        Crew
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        Hours/unit
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        Loaded rate
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        Subtotal
                      </TableHead>
                      {/* Spacer header for the row-action column; still a column header, so it needs the scope too. */}
                      {canEdit && <TableHead scope="col" />}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {code.labourItems.map((line) => {
                      const expected =
                        line.crewQuantity *
                        line.hoursPerUnit *
                        line.serviceMasterRate.fullLoadedRate;
                      return (
                        <TableRow key={line.id}>
                          <TableCell className="font-medium">
                            {line.serviceMasterRate.labourType}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {line.serviceMasterRate.serviceMasterCode}
                          </TableCell>
                          <NumericCell>{formatNumber(line.crewQuantity)}</NumericCell>
                          <NumericCell>{formatNumber(line.hoursPerUnit)}</NumericCell>
                          <NumericCell>
                            {formatZarRate(line.serviceMasterRate.fullLoadedRate)}
                          </NumericCell>
                          <NumericCell
                            className={
                              Math.abs(expected - line.lineSubtotal) > 0.0001
                                ? 'font-semibold text-warning'
                                : undefined
                            }
                          >
                            {formatZarRate(line.lineSubtotal)}
                          </NumericCell>
                          {canEdit && (
                            <TableCell className="text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => removeLabourLine.mutate(line.id)}
                                disabled={removeLabourLine.isPending}
                              >
                                Remove
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                    {code.labourItems.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={canEdit ? 7 : 6}
                          className="text-center text-muted-foreground"
                        >
                          No labour lines yet — this rate is carried over from elsewhere.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>

                <p className="text-xs text-muted-foreground">
                  Total crew hours per unit {formatNumber(computation.totalHoursPerUnit ?? 0)} ·
                  computed labour value {formatZarRate(labourTotal)}
                </p>

                {canEdit && (
                  <div className="flex flex-wrap items-end gap-2 rounded-md border p-3">
                    <label className="space-y-1">
                      <span className="text-xs text-muted-foreground">Trade role</span>
                      <select
                        value={rateId}
                        onChange={(e) => setRateId(e.target.value)}
                        className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                      >
                        <option value="">Select…</option>
                        {(rates.data?.rates ?? []).map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.labourType} ({r.serviceMasterCode})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs text-muted-foreground">Crew</span>
                      <input
                        type="number"
                        step="0.01"
                        value={crew}
                        onChange={(e) => setCrew(e.target.value)}
                        className="w-24 rounded-md border border-input bg-background px-2 py-1.5 text-right font-mono text-sm"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs text-muted-foreground">Hours/unit</span>
                      <input
                        type="number"
                        step="0.0001"
                        value={hours}
                        onChange={(e) => setHours(e.target.value)}
                        className="w-28 rounded-md border border-input bg-background px-2 py-1.5 text-right font-mono text-sm"
                      />
                    </label>
                    <Button
                      onClick={() =>
                        rateId &&
                        addLabourLine.mutate({
                          serviceMasterRateId: Number(rateId),
                          crewQuantity: Number(crew),
                          hoursPerUnit: Number(hours),
                        })
                      }
                      disabled={!rateId || addLabourLine.isPending}
                    >
                      {addLabourLine.isPending ? 'Adding…' : 'Attach role'}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* ---- R1 Material: procurement BOM ---- */}
            {!isActivity && (
              <div className="space-y-3">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Item</TableHead>
                      <TableHead scope="col">Code</TableHead>
                      <TableHead scope="col">Supplier</TableHead>
                      <TableHead scope="col" className="text-right">
                        Unit cost
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        Qty
                      </TableHead>
                      <TableHead scope="col">UoM</TableHead>
                      <TableHead scope="col" className="text-right">
                        Subtotal
                      </TableHead>
                      {/* Spacer header for the row-action column; still a column header, so it needs the scope too. */}
                      {canEdit && <TableHead scope="col" />}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {code.materialItems.map((line) => (
                      <TableRow key={line.id}>
                        <TableCell className="font-medium">{line.description}</TableCell>
                        <TableCell className="font-mono text-xs">{line.itemCode ?? '—'}</TableCell>
                        <TableCell className="text-xs">{line.supplierName ?? '—'}</TableCell>
                        <NumericCell>{formatZarRate(line.unitCost)}</NumericCell>
                        <NumericCell>{formatNumber(line.quantity)}</NumericCell>
                        <TableCell className="text-xs">{line.uom}</TableCell>
                        <NumericCell>{formatZarRate(line.subtotalCost)}</NumericCell>
                        {canEdit && (
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => removeMaterialLine.mutate(line.id)}
                              disabled={removeMaterialLine.isPending}
                            >
                              Remove
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                    {code.materialItems.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={canEdit ? 8 : 7}
                          className="text-center text-muted-foreground"
                        >
                          No procurement lines yet.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>

                <p className="text-xs text-muted-foreground">
                  Procurement subtotal {formatZarRate(computation.subtotalCost ?? 0)} · markup{' '}
                  {formatPercent(code.materialMarkupPct)} ={' '}
                  {formatZarRate(computation.markupAmount ?? 0)}
                </p>

                {canEdit && (
                  <div className="flex flex-wrap items-end gap-2 rounded-md border p-3">
                    <label className="space-y-1">
                      <span className="text-xs text-muted-foreground">Description</span>
                      <input
                        type="text"
                        value={itemDesc}
                        onChange={(e) => setItemDesc(e.target.value)}
                        className="w-56 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs text-muted-foreground">Unit cost</span>
                      <input
                        type="number"
                        step="0.0001"
                        value={unitCost}
                        onChange={(e) => setUnitCost(e.target.value)}
                        className="w-28 rounded-md border border-input bg-background px-2 py-1.5 text-right font-mono text-sm"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs text-muted-foreground">Qty</span>
                      <input
                        type="number"
                        step="0.01"
                        value={qty}
                        onChange={(e) => setQty(e.target.value)}
                        className="w-24 rounded-md border border-input bg-background px-2 py-1.5 text-right font-mono text-sm"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs text-muted-foreground">UoM</span>
                      <input
                        type="text"
                        value={uom}
                        onChange={(e) => setUom(e.target.value)}
                        className="w-20 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                      />
                    </label>
                    <Button
                      onClick={() =>
                        itemDesc.trim() &&
                        addMaterialLine.mutate({
                          description: itemDesc.trim(),
                          unitCost: Number(unitCost),
                          quantity: Number(qty),
                          uom,
                        })
                      }
                      disabled={!itemDesc.trim() || addMaterialLine.isPending}
                    >
                      {addMaterialLine.isPending ? 'Adding…' : 'Add item'}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {isAdmin && (
        <AddServiceCodeDialog
          open={isAddOpen}
          onOpenChange={setIsAddOpen}
          amendmentId={amendmentId}
          onCreated={(newCodeId) => setSelectedId(newCodeId)}
        />
      )}
    </div>
  );
}

interface AddServiceCodeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  amendmentId: number;
  onCreated: (serviceCodeId: number) => void;
}

function AddServiceCodeDialog({
  open,
  onOpenChange,
  amendmentId,
  onCreated,
}: AddServiceCodeDialogProps) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<ServiceCodeCategory>('Activity');
  const [uom, setUom] = useState('M');
  const [materialMarkupPct, setMaterialMarkupPct] = useState('0');

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<{
        serviceCode: {
          id: number;
          code: string;
          description: string;
          category: string;
          uom: string;
        };
      }>('/api/service-codes', {
        amendmentId,
        code: code.trim(),
        description: description.trim(),
        category,
        uom: uom.trim(),
        materialMarkupPct: Number(materialMarkupPct),
      }),
    onSuccess: async (data) => {
      toast.add({ title: 'Service code created', type: 'success' });
      await queryClient.invalidateQueries({ queryKey: ['service-codes', amendmentId] });
      onOpenChange(false);
      setCode('');
      setDescription('');
      setMaterialMarkupPct('0');
      if (data?.serviceCode?.id) {
        onCreated(data.serviceCode.id);
      }
    },
    onError: (e: Error) =>
      toast.add({
        title: 'Could not create service code',
        description: e instanceof ApiError ? e.message : e.message,
        type: 'error',
      }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !description.trim() || !uom.trim()) return;
    createMutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New service code</DialogTitle>
          <DialogDescription>
            Create a new deliverable service code or material recipe item for Amendment {amendmentId}.
            Only administrators can create service codes.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="sc-code">Code</FieldLabel>
              <Input
                id="sc-code"
                placeholder="e.g. S00247970"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="sc-cat">Category</FieldLabel>
              <select
                id="sc-cat"
                value={category}
                onChange={(e) => setCategory(e.target.value as ServiceCodeCategory)}
                className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {serviceCodeCategoryValues.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="sc-desc">Description</FieldLabel>
            <Input
              id="sc-desc"
              placeholder="e.g. Cable removal per metre"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="sc-uom">Unit of measure</FieldLabel>
              <Input
                id="sc-uom"
                placeholder="e.g. M, EA, KG, HR"
                value={uom}
                onChange={(e) => setUom(e.target.value)}
                required
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="sc-markup">Material markup (fraction)</FieldLabel>
              <Input
                id="sc-markup"
                type="number"
                step="0.0001"
                min="0"
                max="1"
                placeholder="0.15 = 15%"
                value={materialMarkupPct}
                onChange={(e) => setMaterialMarkupPct(e.target.value)}
              />
              <FieldDescription>0.15 = 15%</FieldDescription>
            </Field>
          </div>

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
                createMutation.isPending || !code.trim() || !description.trim() || !uom.trim()
              }
            >
              {createMutation.isPending ? 'Creating…' : 'Create service code'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
