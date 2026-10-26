'use client';

/**
 * Commercial workspace — Admin and QS only.
 *
 * Access is gated twice: the API refuses every write without the relevant
 * permission, and this screen additionally hides controls the current user
 * cannot use. Hiding is for usability only; the API is the security boundary.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Eye } from 'lucide-react';
import {
  api,
  ApiError,
  type AmendmentSummary,
  type ContractRow,
  type CurrentUser,
  type EngineParameters,
  type RateCardRow,
} from '@/lib/api';
import { usePermissions } from '@/components/auth/usePermissions';
import { Badge } from '@/components/ui/badge';
import { statusVariant } from '@/lib/lifecycle-status';
import { Button } from '@/components/ui/button';
import { CostParameterTable } from '@/components/commercial/CostParameterTable';
import { RateBuildupSheet } from '@/components/commercial/RateBuildupSheet';
import { ServiceCodeRecipeBuilder } from '@/components/commercial/ServiceCodeRecipeBuilder';
import { ContractInspectionSheet } from '@/components/commercial/contract-inspection-sheet';
import { DataTable } from '@/components/data-table/data-table';
import type { ColumnDef } from '@tanstack/react-table';
import { useUrlParam } from '@/hooks/use-url-param';
import { formatDate, formatPercent, formatZar, formatZarRate } from '@/lib/format';

type Tab = 'contracts' | 'parameters' | 'rates' | 'recipes';

/** Whitelist for the `tab` query parameter. */
const TAB_KEYS: readonly Tab[] = ['contracts', 'parameters', 'rates', 'recipes'];

const TABS: Array<{ key: Tab; label: string; permission: string }> = [
  { key: 'contracts', label: 'Contracts & Amendments', permission: 'contract.read' },
  { key: 'parameters', label: 'Cost Parameters', permission: 'costparameter.read' },
  { key: 'rates', label: 'Labour Rate Build-up', permission: 'ratemaster.read' },
  { key: 'recipes', label: 'Service Code Recipes', permission: 'servicecode.read' },
];

/** Module-scope so the identity is stable; see `invoiceColumns`. */
const contractColumns: ColumnDef<any, ContractRow, unknown>[] = [
  {
    id: 'number',
    accessorKey: 'number',
    header: 'Contract',
    enableHiding: false,
    cell: ({ row }) => <span className="font-mono text-sm">{row.original.number}</span>,
  },
  {
    id: 'description',
    accessorKey: 'description',
    header: 'Description',
    cell: ({ row }) => (
      <span className="block max-w-[16rem] truncate" title={row.original.description}>
        {row.original.description}
      </span>
    ),
  },
  {
    id: 'client',
    accessorFn: (row) => row.client.name,
    header: 'Client',
    cell: ({ row }) => <span className="truncate">{row.original.client.name}</span>,
  },
  {
    id: 'type',
    accessorKey: 'type',
    header: 'Type',
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">{row.original.type ?? 'Standard'}</span>
    ),
  },
  {
    id: 'projects',
    header: 'Projects',
    meta: { align: 'right' },
    cell: ({ row }) => (
      <span className="font-mono text-xs tabular-nums">{row.original._count?.projects ?? 0}</span>
    ),
  },
  {
    id: 'vat',
    header: 'VAT',
    enableSorting: false,
    cell: ({ row }) => (
      <Badge variant={row.original.client.isVatRegistered ? 'success' : 'secondary'}>
        {row.original.client.isVatRegistered
          ? (row.original.client.vatNumber ?? 'Registered')
          : 'Not registered'}
      </Badge>
    ),
  },
  {
    id: 'amendments',
    header: 'Amendments',
    enableSorting: false,
    cell: ({ row }) => (
      <ul className="space-y-1">
        {row.original.amendments.map((amendment) => (
          <li key={amendment.id} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono">{amendment.amendmentNumber}</span>
            <Badge variant={statusVariant(amendment.status)}>{amendment.status}</Badge>
            <span className="text-muted-foreground">
              {formatDate(amendment.effectiveDate)} → {formatDate(amendment.expiryDate)} · VAT{' '}
              {formatPercent(amendment.vatRate)}
            </span>
          </li>
        ))}
        {row.original.amendments.length === 0 && (
          <li className="text-xs text-muted-foreground">None</li>
        )}
      </ul>
    ),
  },
];

/**
 * Rate card summary columns.
 *
 * Every money column is declared with `meta: { align: 'right' }` so
 * `DataTable` applies right-alignment and tabular figures uniformly - the reason
 * a numeric column lines up is that it was declared that way, not that each call
 * site remembered to add the classes.
 */
const rateCardColumns: ColumnDef<any, RateCardRow, unknown>[] = [
  {
    id: 'serviceMasterCode',
    accessorKey: 'serviceMasterCode',
    header: 'Code',
    cell: ({ row }) => <span className="font-mono text-xs">{row.original.serviceMasterCode}</span>,
  },
  { id: 'labourType', accessorKey: 'labourType', header: 'Trade' },
  {
    id: 'shiftType',
    accessorKey: 'shiftType',
    header: 'Shift',
    cell: ({ row }) => <span className="text-xs">{row.original.shiftType}</span>,
  },
  {
    id: 'base',
    // "Base" is whichever of custom/council was actually stored, so it sorts on
    // the value shown rather than on a column the user cannot see.
    accessorFn: (row) => row.customRate ?? row.councilRate ?? 0,
    header: 'Base',
    meta: { align: 'right' },
    cell: ({ row }) => formatZar(row.original.customRate ?? row.original.councilRate ?? 0),
  },
  {
    id: 'manInPocket',
    accessorKey: 'manInPocket',
    header: 'In pocket',
    meta: { align: 'right' },
    cell: ({ row }) => formatZarRate(row.original.manInPocket),
  },
  {
    id: 'bdl',
    header: 'BDL',
    meta: { align: 'right' },
    accessorFn: (row) => row.manInPocket + row.leavePay + row.totalStatutoryCost,
    cell: ({ row }) =>
      formatZarRate(
        row.original.manInPocket + row.original.leavePay + row.original.totalStatutoryCost,
      ),
  },
  {
    id: 'overheadCost',
    accessorKey: 'overheadCost',
    header: 'OH',
    meta: { align: 'right' },
    cell: ({ row }) => formatZar(row.original.overheadCost),
  },
  {
    id: 'sgaCost',
    accessorKey: 'sgaCost',
    header: 'SG&A',
    meta: { align: 'right' },
    cell: ({ row }) => formatZar(row.original.sgaCost),
  },
  {
    id: 'profitCost',
    accessorKey: 'profitCost',
    header: 'Profit',
    meta: { align: 'right' },
    cell: ({ row }) => formatZar(row.original.profitCost),
  },
  {
    id: 'fullLoadedRate',
    accessorKey: 'fullLoadedRate',
    header: 'Full loaded',
    meta: { align: 'right' },
    cell: ({ row }) => (
      <span className="font-semibold">{formatZar(row.original.fullLoadedRate)}</span>
    ),
  },
];

export default function CommercialPage() {
  const { permissions, loading: authLoading } = usePermissions();
  const [vatFilter, setVatFilter] = useState('');
  const [amendmentsFilter, setAmendmentsFilter] = useState('');
  const [shiftFilter, setShiftFilter] = useState('');
  const [labourFilter, setLabourFilter] = useState('');
  // Tab lives in the URL so the sidebar can deep-link to it and a reload keeps
  // the user where they were. See `useUrlParam` for the validation rationale.
  const [tab, setTab] = useUrlParam<Tab>('tab', TAB_KEYS, 'contracts');
  const [amendmentId, setAmendmentId] = useState<number | null>(null);
  const [inspectingContract, setInspectingContract] = useState<ContractRow | null>(null);

  const can = (permission: string) => permissions.includes(permission);

  const contracts = useQuery({
    queryKey: ['contracts'],
    queryFn: () => api.get<{ contracts: ContractRow[] }>('/api/contracts'),
    enabled: can('contract.read'),
  });

  const [selectedRateId, setSelectedRateId] = useState<number | null>(null);

  /** Every amendment across every contract, flattened for the picker. */
  const amendments = useMemo<AmendmentSummary[]>(
    () => (contracts.data?.contracts ?? []).flatMap((c) => c.amendments),
    [contracts.data],
  );

  /**
   * The amendment actually in effect.
   *
   * `amendmentId` is only set once the user picks one from the dropdown, so it
   * starts as null. Every query MUST key off this derived value rather than the
   * raw state, otherwise `enabled: amendmentId !== null` is false on first paint
   * and the panel silently stays empty forever.
   */
  const activeAmendmentId = amendmentId ?? amendments[0]?.id ?? null;

  const parameters = useQuery({
    queryKey: ['cost-parameters', activeAmendmentId],
    queryFn: () =>
      api.get<{
        parameters: unknown[];
        engine: EngineParameters;
        amendment: { amendmentNumber: string; vatRate: number };
      }>(`/api/amendments/${activeAmendmentId}/cost-parameters`),
    enabled: tab === 'parameters' && activeAmendmentId !== null && can('costparameter.read'),
  });

  const rates = useQuery({
    queryKey: ['service-master-rates', activeAmendmentId],
    queryFn: () =>
      api.get<{ rates: RateCardRow[] }>('/api/service-master-rates', {
        amendmentId: activeAmendmentId,
      }),
    enabled: tab === 'rates' && activeAmendmentId !== null && can('ratemaster.read'),
  });

  const activeAmendment = amendments.find((a) => a.id === activeAmendmentId);
  const selectedRate = rates.data?.rates.find((r) => r.id === selectedRateId) ?? null;

  if (authLoading) {
    return <p className="py-16 text-center text-sm text-muted-foreground">Loading permissions…</p>;
  }

  const visibleTabs = TABS.filter((t) => can(t.permission));

  if (visibleTabs.length === 0) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <h1 className="text-lg font-semibold">Commercial access required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your roles do not include any commercial permission. Commercial screens are limited to
          Administrator and Commercial / Quantity Surveyor.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Commercial</h1>
          <p className="text-sm text-muted-foreground">
            Contracts, cost parameters, labour rate build-up and service code recipes.
          </p>
        </div>
      </header>

      <nav className="flex flex-wrap gap-1 border-b">
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm transition-colors ${
              tab === t.key
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {amendments.length > 0 && (
        <div className="flex items-center gap-2">
          <label htmlFor="amendment" className="text-sm text-muted-foreground">
            Amendment
          </label>
          <select
            id="amendment"
            value={activeAmendmentId ?? ''}
            onChange={(e) => {
              setAmendmentId(Number(e.target.value));
              setSelectedRateId(null);
            }}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          >
            {amendments.map((a) => (
              <option key={a.id} value={a.id}>
                {a.amendmentNumber} ({a.status})
              </option>
            ))}
          </select>
        </div>
      )}

      {/* ---- Contracts ---- */}
      {tab === 'contracts' && (
        <section className="flex min-h-0 flex-1 flex-col gap-3">
          {contracts.isLoading && (
            <p className="text-sm text-muted-foreground">Loading contracts…</p>
          )}
          {contracts.isError && (
            <p className="text-sm text-destructive">
              {contracts.error instanceof ApiError
                ? contracts.error.message
                : 'Could not load contracts.'}
            </p>
          )}
          {/*
            Contracts are a register, so it gets search, filters and sorting.
            The amendment list stays inside the contract row because an amendment
            has no meaning without its contract - flattening it would produce rows
            whose most important column is a lookup.
          */}
          <DataTable<ContractRow>
            tableId="commercial-contracts"
            caption="Contracts and their amendments"
            data={contracts.data?.contracts ?? []}
            columns={contractColumns}
            rowKey={(contract) => contract.id}
            searchKeys={[
              'number',
              'description',
              'client.name',
              'amendments.amendmentNumber',
              'amendments.status',
            ]}
            searchPlaceholder="Search contract, client or amendment…"
            isLoading={contracts.isLoading}
            initialSort={[{ id: 'number', desc: false }]}
            emptyMessage="No contracts match the current search and filters."
            onRowClick={(contract) => setInspectingContract(contract)}
            renderRowActions={(contract) => (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setInspectingContract(contract)}
                title={`Inspect Contract ${contract.number}`}
                aria-label={`Inspect Contract ${contract.number}`}
                className="hover:bg-muted"
              >
                <Eye className="size-3.5 text-muted-foreground" />
              </Button>
            )}
            filters={[
              {
                id: 'vat',
                label: 'VAT',
                value: vatFilter,
                options: [
                  { value: '', label: 'Any' },
                  { value: 'registered', label: 'Registered' },
                  { value: 'not-registered', label: 'Not registered' },
                ],
                onChange: setVatFilter,
                predicate: (contract, selected) =>
                  selected === 'registered'
                    ? contract.client.isVatRegistered
                    : !contract.client.isVatRegistered,
              },
              {
                id: 'amendments',
                label: 'Amendments',
                value: amendmentsFilter,
                options: [
                  { value: '', label: 'Any' },
                  { value: 'yes', label: 'At least one' },
                  { value: 'no', label: 'None' },
                ],
                onChange: setAmendmentsFilter,
                predicate: (contract, selected) =>
                  selected === 'yes'
                    ? contract.amendments.length > 0
                    : contract.amendments.length === 0,
              },
            ]}
          />

          <ContractInspectionSheet
            contract={inspectingContract}
            open={inspectingContract !== null}
            onOpenChange={(open) => {
              if (!open) setInspectingContract(null);
            }}
            onSelectAmendment={(id, targetTab) => {
              setAmendmentId(id);
              setTab(targetTab);
            }}
          />
        </section>
      )}

      {/* ---- Cost parameters ---- */}
      {tab === 'parameters' && activeAmendmentId !== null && (
        <CostParameterTable
          amendmentId={activeAmendmentId}
          amendmentNumber={activeAmendment?.amendmentNumber ?? String(activeAmendmentId)}
          canEdit={can('costparameter.write')}
        />
      )}

      {/* ---- Rate build-up ---- */}
      {tab === 'rates' && activeAmendmentId !== null && (
        <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Labour master rates</h3>
            {rates.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
            <ul className="max-h-[32rem] space-y-1 overflow-auto">
              {(rates.data?.rates ?? []).map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedRateId(r.id)}
                    className={`w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                      selectedRateId === r.id
                        ? 'border-primary bg-accent'
                        : 'border-transparent hover:bg-accent/50'
                    }`}
                  >
                    <span className="block font-medium">{r.labourType}</span>
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {r.serviceMasterCode} · {r.shiftType}
                      </span>
                      <span className="font-mono text-xs tabular-nums">
                        {formatZar(r.fullLoadedRate)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <RateBuildupSheet
              amendmentId={activeAmendmentId}
              engine={parameters.data?.engine ?? {}}
              selected={selectedRate}
              canEdit={can('ratemaster.write')}
            />
          </div>
        </div>
      )}

      {/* ---- Recipes ---- */}
      {tab === 'recipes' && activeAmendmentId !== null && (
        <ServiceCodeRecipeBuilder
          amendmentId={activeAmendmentId}
          canEdit={can('recipe.labour.write') || can('recipe.material.write')}
        />
      )}

      {/* ---- Rates summary table, always handy ---- */}
      {tab === 'rates' && activeAmendmentId !== null && rates.data && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Rate card summary</h3>
          {/*
            Ten numeric columns across two dozen rate rows is exactly where a
            register stops being readable, so this gets the full toolbar: search
            by code or trade, filter by shift, and sort by any money column to
            answer "what is our most expensive fully-loaded rate?".
          */}
          <DataTable<RateCardRow>
            tableId="commercial-rates"
            caption="Rate card summary"
            data={rates.data.rates}
            columns={rateCardColumns}
            rowKey={(rate) => rate.id}
            searchKeys={['serviceMasterCode', 'labourType', 'shiftType']}
            searchPlaceholder="Search code or trade…"
            initialSort={[{ id: 'fullLoadedRate', desc: true }]}
            pageSize={25}
            emptyMessage="No rate cards match the current search and filters."
            filters={[
              {
                id: 'shift',
                label: 'Shift',
                value: shiftFilter,
                options: [
                  { value: '', label: 'All shifts' },
                  ...[...new Set(rates.data.rates.map((rate) => rate.shiftType))]
                    .sort()
                    .map((shift) => ({ value: shift, label: shift })),
                ],
                onChange: setShiftFilter,
                predicate: (rate, selected) => rate.shiftType === selected,
              },
              {
                id: 'labour',
                label: 'Trade',
                value: labourFilter,
                options: [
                  { value: '', label: 'All trades' },
                  ...[...new Set(rates.data.rates.map((rate) => rate.labourType))]
                    .sort()
                    .map((trade) => ({ value: trade, label: trade })),
                ],
                onChange: setLabourFilter,
                predicate: (rate, selected) => rate.labourType === selected,
              },
            ]}
          />
          <p className="text-xs text-muted-foreground">
            OH and SG&amp;A are authoritative stored values (ADR-001 Q1), not re-derived from the
            parameter table.
          </p>
        </section>
      )}
    </div>
  );
}

/** Re-exported so the route can show a consistent empty state. */
export function CommercialEmpty() {
  return <Button disabled>No commercial data</Button>;
}

/** Keeps the unused-import checker honest about the CurrentUser type. */
export type { CurrentUser };
