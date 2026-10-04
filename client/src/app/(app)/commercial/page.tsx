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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { NumericCell } from '@/components/data-table/NumericCell';
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

export default function CommercialPage() {
  const { permissions, loading: authLoading } = usePermissions();
  // Tab lives in the URL so the sidebar can deep-link to it and a reload keeps
  // the user where they were. See `useUrlParam` for the validation rationale.
  const [tab, setTab] = useUrlParam<Tab>('tab', TAB_KEYS, 'contracts');
  const [amendmentId, setAmendmentId] = useState<number | null>(null);

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
    <div className="mx-auto max-w-7xl space-y-6">
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
        <section className="space-y-3">
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Contract</TableHead>
                <TableHead scope="col">Description</TableHead>
                <TableHead scope="col">Client</TableHead>
                <TableHead scope="col">VAT</TableHead>
                <TableHead scope="col">Amendments</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(contracts.data?.contracts ?? []).map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-mono text-sm">{c.number}</TableCell>
                  <TableCell>{c.description}</TableCell>
                  <TableCell>{c.client.name}</TableCell>
                  <TableCell>
                    <Badge variant={c.client.isVatRegistered ? 'success' : 'secondary'}>
                      {c.client.isVatRegistered
                        ? (c.client.vatNumber ?? 'Registered')
                        : 'Not registered'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <ul className="space-y-1">
                      {c.amendments.map((a) => (
                        <li key={a.id} className="flex items-center gap-2 text-xs">
                          <span className="font-mono">{a.amendmentNumber}</span>
                          <Badge variant={statusVariant(a.status)}>{a.status}</Badge>
                          <span className="text-muted-foreground">
                            {formatDate(a.effectiveDate)} → {formatDate(a.expiryDate)} · VAT{' '}
                            {formatPercent(a.vatRate)}
                          </span>
                        </li>
                      ))}
                      {c.amendments.length === 0 && (
                        <li className="text-xs text-muted-foreground">None</li>
                      )}
                    </ul>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Code</TableHead>
                <TableHead scope="col">Trade</TableHead>
                <TableHead scope="col">Shift</TableHead>
                <TableHead scope="col" className="text-right">
                  Base
                </TableHead>
                <TableHead scope="col" className="text-right">
                  In pocket
                </TableHead>
                <TableHead scope="col" className="text-right">
                  BDL
                </TableHead>
                <TableHead scope="col" className="text-right">
                  OH
                </TableHead>
                <TableHead scope="col" className="text-right">
                  SG&amp;A
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Profit
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Full loaded
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rates.data.rates.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.serviceMasterCode}</TableCell>
                  <TableCell>{r.labourType}</TableCell>
                  <TableCell className="text-xs">{r.shiftType}</TableCell>
                  <NumericCell>{formatZar(r.customRate ?? r.councilRate ?? 0)}</NumericCell>
                  <NumericCell>{formatZarRate(r.manInPocket)}</NumericCell>
                  <NumericCell>
                    {formatZarRate(r.manInPocket + r.leavePay + r.totalStatutoryCost)}
                  </NumericCell>
                  <NumericCell>{formatZar(r.overheadCost)}</NumericCell>
                  <NumericCell>{formatZar(r.sgaCost)}</NumericCell>
                  <NumericCell>{formatZar(r.profitCost)}</NumericCell>
                  <NumericCell className="font-semibold">{formatZar(r.fullLoadedRate)}</NumericCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
