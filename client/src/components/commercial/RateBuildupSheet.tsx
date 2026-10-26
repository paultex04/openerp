'use client';

/**
 * Interactive Tier 1 labour rate build-up sheet.
 *
 * The inline preview is computed **locally** with the exact same engine the
 * server persists with (`@openerp/shared`), so what the user sees while typing is
 * what will be written. There is no round-trip and no divergence.
 *
 * The sheet also surfaces the ADR-001 F2 divergence explicitly: the stored
 * (authoritative) overheads are shown alongside what re-deriving them from the
 * amendment's parameters would produce, because the two differ by roughly 0.4%.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  compareAgainstDerived,
  computeFullLoadedRate,
  shiftTypeValues,
  type ShiftType,
  type AmendmentCostParameters,
  type Tier1Result,
} from '@openerp/shared';
import { api, ApiError, type RateCardRow } from '@/lib/api';
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
import { NumericCell } from '@/components/data-table/NumericCell';
import { formatDelta, formatPercent, formatZar } from '@/lib/format';

interface Draft {
  serviceMasterCode: string;
  labourType: string;
  shiftType: ShiftType;
  uom: string;
  bargainingCouncilDesc: string;
  councilRate: string;
  customRate: string;
  wagePremiumPct: string;
  leavePay: string;
  totalStatutoryCost: string;
  ppeCost: string;
  transportCost: string;
  equipmentCost: string;
  overheadCost: string;
  sgaCost: string;
  profitPct: string;
  deriveOverheads: boolean;
}

const BLANK: Draft = {
  serviceMasterCode: '',
  labourType: '',
  shiftType: 'NT',
  uom: 'per Hour',
  bargainingCouncilDesc: '',
  councilRate: '',
  customRate: '',
  wagePremiumPct: '0',
  leavePay: '0',
  totalStatutoryCost: '0',
  ppeCost: '0',
  transportCost: '0',
  equipmentCost: '0',
  overheadCost: '0',
  sgaCost: '0',
  profitPct: '0.095',
  deriveOverheads: false,
};

function draftFrom(card: RateCardRow): Draft {
  return {
    serviceMasterCode: card.serviceMasterCode,
    labourType: card.labourType,
    shiftType: (card.shiftType as ShiftType) ?? 'NT',
    uom: card.uom,
    bargainingCouncilDesc: card.bargainingCouncilDesc ?? '',
    councilRate: card.councilRate !== null ? String(card.councilRate) : '',
    customRate: card.customRate !== null ? String(card.customRate) : '',
    // The stored wage premium is already a fraction.
    wagePremiumPct: String(card.wagePremiumPct),
    leavePay: String(card.leavePay),
    totalStatutoryCost: String(card.totalStatutoryCost),
    ppeCost: String(card.ppeCost),
    transportCost: String(card.transportCost),
    equipmentCost: String(card.equipmentCost),
    overheadCost: String(card.overheadCost),
    sgaCost: String(card.sgaCost),
    profitPct: '0.095',
    deriveOverheads: false,
  };
}

/** Lenient numeric field parse: anything non-finite becomes 0. */
function toNumber(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

interface Props {
  amendmentId: number;
  engine: AmendmentCostParameters;
  selected: RateCardRow | null;
  canEdit: boolean;
  isCreating?: boolean;
  onCancelCreate?: () => void;
  onCreated?: (rateId: number) => void;
}

/**
 * A labelled row of the build-up. `muted` marks a value that comes from the
 * amendment parameters rather than the rate card.
 */
function Line({
  label: caption,
  value,
  formula,
  muted,
  highlight,
}: {
  label: string;
  value: number;
  formula: string;
  muted?: boolean;
  highlight?: boolean;
}) {
  return (
    <TableRow className={highlight ? 'bg-success/10' : undefined}>
      <TableCell>
        <span className="font-medium">{caption}</span>
        {muted && (
          <Badge variant="outline" className="ml-2">
            from parameters
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{formula}</TableCell>
      <NumericCell className={highlight ? 'font-semibold' : undefined}>
        {formatZar(value)}
      </NumericCell>
    </TableRow>
  );
}

export function RateBuildupSheet({
  amendmentId,
  engine,
  selected,
  canEdit,
  isCreating,
  onCancelCreate,
  onCreated,
}: Props) {
  // The edit buffer is reset by keying the subtree, not by copying props into
  // state inside an effect. `key` changes unmount and remount this component,
  // which discards the draft and initialises it from the newly selected card —
  // no effect, no cascading render, and the draft can never drift out of sync
  // with the selection.
  const selectionKey = isCreating
    ? `new:${amendmentId}`
    : selected
      ? `${amendmentId}:${selected.id}`
      : `blank:${amendmentId}`;

  return (
    <RateBuildupForm
      key={selectionKey}
      amendmentId={amendmentId}
      engine={engine}
      selected={selected}
      canEdit={canEdit}
      isCreating={isCreating}
      onCancelCreate={onCancelCreate}
      onCreated={onCreated}
    />
  );
}

// The toast manager is a module singleton, so the form reaches for it directly
// rather than receiving it as a prop. Prop-drilling a global made the component
// untestable without an importer and forced a hand-written signature to be kept
// in sync with the toast API.
function RateBuildupForm({
  amendmentId,
  engine,
  selected,
  canEdit,
  isCreating,
  onCancelCreate,
  onCreated,
}: Props) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(selected && !isCreating ? draftFrom(selected) : BLANK);
  const [profitPctInput, setProfitPctInput] = useState(String(engine.profitPct ?? 0.095));

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const hasBaseRate = draft.councilRate.trim() !== '' || draft.customRate.trim() !== '';

  const inputs = useMemo(
    () => ({
      councilRate: draft.councilRate.trim() === '' ? null : toNumber(draft.councilRate),
      customRate: draft.customRate.trim() === '' ? null : toNumber(draft.customRate),
      wagePremiumPct: toNumber(draft.wagePremiumPct),
      leavePay: toNumber(draft.leavePay),
      totalStatutoryCost: toNumber(draft.totalStatutoryCost),
      ppeCost: toNumber(draft.ppeCost),
      transportCost: toNumber(draft.transportCost),
      equipmentCost: toNumber(draft.equipmentCost),
      profitPct: toNumber(profitPctInput),
    }),
    [draft, profitPctInput],
  );

  /**
   * Local preview. Mirrors the server policy exactly: authoritative overheads
   * unless `deriveOverheads` is explicitly ticked.
   */
  const computed: Tier1Result | null = useMemo(() => {
    if (!hasBaseRate) return null;
    const policy = draft.deriveOverheads
      ? {
          mode: 'derived' as const,
          overheadPct: engine.overheadPct ?? 0,
          sgaPct: engine.sgaPct ?? 0,
        }
      : {
          mode: 'authoritative' as const,
          overheadCost: toNumber(draft.overheadCost),
          sgaCost: toNumber(draft.sgaCost),
        };

    try {
      return computeFullLoadedRate(inputs, policy);
    } catch {
      return null;
    }
  }, [inputs, draft.deriveOverheads, draft.overheadCost, draft.sgaCost, hasBaseRate, engine]);

  /** ADR-001 F2: what re-deriving overheads from parameters would give. */
  const comparison = useMemo(() => {
    if (!hasBaseRate) return null;
    if (engine.overheadPct === undefined || engine.sgaPct === undefined) return null;
    try {
      return compareAgainstDerived(
        inputs,
        toNumber(draft.overheadCost),
        toNumber(draft.sgaCost),
        engine.overheadPct,
        engine.sgaPct,
      );
    } catch {
      return null;
    }
  }, [inputs, draft.overheadCost, draft.sgaCost, engine, hasBaseRate]);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        amendmentId,
        serviceMasterCode: isCreating ? draft.serviceMasterCode.trim() : selected!.serviceMasterCode,
        labourType: isCreating ? draft.labourType.trim() : selected!.labourType,
        shiftType: isCreating ? draft.shiftType : selected!.shiftType,
        uom: isCreating ? draft.uom.trim() : selected!.uom,
        bargainingCouncilDesc: isCreating
          ? draft.bargainingCouncilDesc.trim() || null
          : selected?.bargainingCouncilDesc,
        councilRate: draft.councilRate.trim() === '' ? null : toNumber(draft.councilRate),
        customRate: draft.customRate.trim() === '' ? null : toNumber(draft.customRate),
        wagePremiumPct: toNumber(draft.wagePremiumPct),
        leavePay: toNumber(draft.leavePay),
        totalStatutoryCost: toNumber(draft.totalStatutoryCost),
        ppeCost: toNumber(draft.ppeCost),
        transportCost: toNumber(draft.transportCost),
        equipmentCost: toNumber(draft.equipmentCost),
        overheadCost: toNumber(draft.overheadCost),
        sgaCost: toNumber(draft.sgaCost),
        profitPct: toNumber(profitPctInput),
        deriveOverheads: draft.deriveOverheads,
      };

      if (isCreating) {
        return api.post<{ rate: RateCardRow }>('/api/service-master-rates', payload);
      } else {
        if (!selected) throw new Error('No rate card selected.');
        return api.put<{ rate: RateCardRow }>(`/api/service-master-rates/${selected.id}`, payload);
      }
    },
    onSuccess: async (data) => {
      toast.add({
        title: isCreating ? 'Rate card created' : 'Rate card saved',
        type: 'success',
      });
      await queryClient.invalidateQueries({ queryKey: ['service-master-rates', amendmentId] });
      if (isCreating && data?.rate?.id) {
        onCreated?.(data.rate.id);
      }
    },
    onError: (e: Error) =>
      toast.add({
        title: isCreating ? 'Could not create rate card' : 'Could not save rate card',
        description: e instanceof ApiError ? e.message : e.message,
        type: 'error',
      }),
  });

  const field = (
    caption: string,
    key: keyof Draft,
    options: { step?: string; hint?: string } = {},
  ) => (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{caption}</span>
      <input
        type="number"
        step={options.step ?? '0.01'}
        value={draft[key] as string}
        disabled={!canEdit}
        onChange={(e) => set(key, e.target.value as Draft[typeof key])}
        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-right font-mono text-sm tabular-nums disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {options.hint && <span className="text-[10px] text-muted-foreground">{options.hint}</span>}
    </label>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      {/* ---- Inputs ---- */}
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold">
            {isCreating
              ? 'New labour master rate card'
              : selected
                ? `${selected.serviceMasterCode} · ${selected.labourType}`
                : 'Rate build-up'}
          </h3>
          {isCreating ? (
            <p className="text-xs text-muted-foreground">
              Define a new trade rate card for Amendment {amendmentId}. Real-time preview uses the
              shared calculation engine.
            </p>
          ) : selected ? (
            <p className="text-xs text-muted-foreground">
              Stored full loaded rate {formatZar(selected.fullLoadedRate)} per {selected.uom}
            </p>
          ) : null}
        </div>

        {isCreating && (
          <div className="grid grid-cols-2 gap-3 rounded-md border p-3 bg-muted/20">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Service master code</span>
              <input
                type="text"
                placeholder="e.g. S00259999"
                value={draft.serviceMasterCode}
                onChange={(e) => set('serviceMasterCode', e.target.value)}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                required
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Labour type / Trade</span>
              <input
                type="text"
                placeholder="e.g. Artisan Mechanical"
                value={draft.labourType}
                onChange={(e) => set('labourType', e.target.value)}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                required
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Shift type</span>
              <select
                value={draft.shiftType}
                onChange={(e) => set('shiftType', e.target.value as ShiftType)}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {shiftTypeValues.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Unit of measure</span>
              <input
                type="text"
                value={draft.uom}
                onChange={(e) => set('uom', e.target.value)}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                required
              />
            </label>
            <label className="col-span-2 block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                Bargaining council description (optional)
              </span>
              <input
                type="text"
                placeholder="e.g. MEIBC Main Agreement Rate A"
                value={draft.bargainingCouncilDesc}
                onChange={(e) => set('bargainingCouncilDesc', e.target.value)}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          {field('Council rate (ZAR)', 'councilRate')}
          {field('Custom rate (ZAR)', 'customRate', { hint: 'Takes precedence when set.' })}
          {field('Wage premium (fraction)', 'wagePremiumPct', {
            step: '0.0001',
            hint: '0.005 = 0.5%',
          })}
          {label(
            'Profit margin (fraction)',
            <input
              type="number"
              step="0.0001"
              value={profitPctInput}
              disabled={!canEdit}
              onChange={(e) => setProfitPctInput(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-right font-mono text-sm tabular-nums disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />,
          )}
          {field('Leave pay', 'leavePay')}
          {field('Total statutory', 'totalStatutoryCost')}
          {field('PPE cost', 'ppeCost')}
          {field('Transport cost', 'transportCost')}
          {field('Equipment cost', 'equipmentCost')}
          {field('Overhead cost', 'overheadCost', { hint: 'Authoritative when not deriving.' })}
          {field('SG&A cost', 'sgaCost', { hint: 'Authoritative when not deriving.' })}
        </div>

        <label className="flex items-start gap-2 rounded-md border p-3 text-xs">
          <input
            type="checkbox"
            checked={draft.deriveOverheads}
            disabled={!canEdit}
            onChange={(e) => set('deriveOverheads', e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">
              Re-derive overheads and SG&amp;A from amendment parameters
            </span>
            <span className="block text-muted-foreground">
              Off by default. Stored overheads are authoritative (ADR-001 Q1); deriving changes the
              published 227.61 ZAR/hr reference to 226.72 ZAR/hr.
            </span>
          </span>
        </label>

        {isCreating ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onCancelCreate}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => save.mutate()}
              disabled={
                save.isPending ||
                !computed ||
                !draft.serviceMasterCode.trim() ||
                !draft.labourType.trim()
              }
            >
              {save.isPending ? 'Creating…' : 'Create rate card'}
            </Button>
          </div>
        ) : canEdit && selected ? (
          <Button onClick={() => save.mutate()} disabled={save.isPending || !computed}>
            {save.isPending ? 'Saving…' : 'Save rate card'}
          </Button>
        ) : null}
      </div>

      {/* ---- Live preview ---- */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Build-up preview</h3>
          <p className="text-xs text-muted-foreground">
            Computed in the browser with the same engine the API persists with.
          </p>
        </div>

        {!hasBaseRate ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            Enter a council rate or a custom rate to see the build-up.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Component</TableHead>
                <TableHead scope="col">Basis</TableHead>
                <TableHead scope="col" className="text-right">
                  ZAR
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <Line
                label="Man in pocket"
                value={computed!.manInPocket}
                formula={`${formatZar(computed!.baseRate)} x (1 + ${formatPercent(inputs.wagePremiumPct, 4)})`}
              />
              <Line
                label="Base direct labour"
                value={computed!.baseDirectLabour}
                formula="in pocket + leave + statutory"
              />
              <Line
                label="Equipment cost"
                value={toNumber(draft.equipmentCost)}
                formula="per hour"
              />
              <Line
                label="Overhead cost"
                value={computed!.overheadCost}
                formula={
                  draft.deriveOverheads
                    ? `(BDL + equipment) x ${formatPercent(engine.overheadPct ?? 0)}`
                    : 'authoritative stored value'
                }
                muted={draft.deriveOverheads}
              />
              <Line
                label="SG&A cost"
                value={computed!.sgaCost}
                formula={
                  draft.deriveOverheads
                    ? `(BDL + equipment + OH) x ${formatPercent(engine.sgaPct ?? 0)}`
                    : 'authoritative stored value'
                }
                muted={draft.deriveOverheads}
              />
              <Line label="PPE cost" value={toNumber(draft.ppeCost)} formula="per hour" />
              <Line
                label="Transport cost"
                value={toNumber(draft.transportCost)}
                formula="per hour"
              />
              <Line
                label="Profit cost"
                value={computed!.profitCost}
                formula={`(BDL + equip + OH + SG&A + PPE + transport) x ${formatPercent(inputs.profitPct)}`}
              />
              <Line
                label="Full loaded rate"
                value={computed!.fullLoadedRate}
                formula="sum of the above"
                highlight
              />
            </TableBody>
          </Table>
        )}

        {comparison && !draft.deriveOverheads && (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
            <p className="font-medium">Parameter-derived comparison</p>
            <p className="mt-1 text-muted-foreground">
              Re-deriving overheads from this amendment&rsquo;s parameters (
              {(engine.overheadPct! * 100).toFixed(2)}% / {(engine.sgaPct! * 100).toFixed(2)}%)
              would give{' '}
              <span className="font-mono tabular-nums">
                {formatZar(comparison.derived.fullLoadedRate)}
              </span>{' '}
              instead of{' '}
              <span className="font-mono tabular-nums">
                {formatZar(comparison.authoritative.fullLoadedRate)}
              </span>{' '}
              ({formatDelta(comparison.fullLoadedRateDelta)}).
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Small helper so the profit input can sit in the same grid as the others. */
function label(text: string, input: React.ReactNode) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{text}</span>
      {input}
    </label>
  );
}
