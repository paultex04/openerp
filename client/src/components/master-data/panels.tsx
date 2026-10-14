'use client';

/**
 * The eight master-data panels.
 *
 * Each one is thin: a column builder plus, where the entity references another
 * table, the option list for its pickers. Everything else — create, edit, delete,
 * permission gating, toasts, refetch — lives in `MasterDataPanel`.
 *
 * Pickers are typed (ADR-007 D3). A contract form offers a client dropdown, never
 * a numeric id box, because the server validates the reference and a typo becomes
 * a 400 the user has to decode.
 *
 * ## Cell accessors return CONTENT, not a `<td>`
 *
 * `DataTable` wraps whatever an accessor returns in a `TableCell` (or a
 * `NumericCell` when the column declares `meta.align === 'right'`). An accessor
 * that returns its own `<TableCell>` therefore produces `<td><td>…</td></td>`,
 * which is invalid markup the browser silently repairs by hoisting — so the
 * content renders twice in the accessibility tree and the row mis-measures. Every
 * accessor here returns a fragment or a `<span>`, and money columns opt into
 * right-alignment through `meta` rather than through markup.
 */
import type { ColumnDef } from '@tanstack/react-table';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { MasterDataPanel } from '@/components/master-data/master-data-panel';
import {
  amendmentOptionsFor,
  cell,
  moneyCell,
  selectedId,
  type AmendmentOption,
} from '@/components/master-data/columns';
import { api } from '@/lib/api';
import {
  AMENDMENTS,
  BROKERS,
  CLIENTS,
  CONTACTS,
  CONTRACT_TYPES,
  CONTRACTS,
  EMPLOYEES,
  PROJECTS,
  StatusBadge,
  type AmendmentRow,
  type BrokerRow,
  type ClientRow,
  type ContactRow,
  type ContractRow,
  type ContractTypeRow,
  type EmployeeRow,
  type ProjectRow,
} from '@/lib/master-data-resources';

// ---------------------------------------------------------------------------
// Option sources
// ---------------------------------------------------------------------------

interface ClientOption {
  id: number;
  name: string;
}

interface ContractOption {
  id: number;
  number: string;
  client?: { name: string };
}

function useClientOptions() {
  const query = useQuery({
    queryKey: ['clients', 'options'],
    queryFn: () => api.get<{ clients: ClientOption[] }>('/api/clients'),
  });
  return useMemo(
    () => (query.data?.clients ?? []).map((c) => ({ value: String(c.id), label: c.name })),
    [query.data],
  );
}

function useContractOptions() {
  const query = useQuery({
    queryKey: ['contracts', 'options'],
    queryFn: () => api.get<{ contracts: ContractOption[] }>('/api/contracts'),
  });
  return useMemo(
    () =>
      (query.data?.contracts ?? []).map((c) => ({
        value: String(c.id),
        label: c.client ? `${c.number} — ${c.client.name}` : c.number,
      })),
    [query.data],
  );
}

// ---------------------------------------------------------------------------
// Cell helpers. Content only — see the header note.
// ---------------------------------------------------------------------------

/** A muted em dash for an absent value, so an empty cell is visibly empty. */
const dash = (value: string | number | null | undefined) =>
  value === null || value === undefined || value === '' ? (
    <span className="text-muted-foreground">—</span>
  ) : (
    <span>{value}</span>
  );

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

function clientColumns(): ColumnDef<any, ClientRow, unknown>[] {
  return [
    cell<ClientRow>('Company', (row) => (
      <>
        <span className="font-medium">{row.name}</span>
        {row._count && (
          <span className="block text-xs text-muted-foreground">
            {row._count.contracts} contract{row._count.contracts === 1 ? '' : 's'}
          </span>
        )}
      </>
    )),
    cell<ClientRow>('Email', (row) => <span>{row.email}</span>),
    cell<ClientRow>('VAT', (row) =>
      row.isVatRegistered ? (
        <>
          <span className="font-mono text-xs">{row.vatNumber ?? '— missing'}</span>
          {!row.vatNumber && (
            <span className="block text-xs text-warning">Registered, no number on file</span>
          )}
        </>
      ) : (
        <span className="text-muted-foreground">Not registered</span>
      ),
    ),
    cell<ClientRow>('Address', (row) => dash(row.address)),
  ];
}

export function ClientsPanel() {
  return (
    <MasterDataPanel<ClientRow>
      resource={CLIENTS}
      rowKey={(row) => row.id}
      columns={() => clientColumns()}
    />
  );
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export function ContactsPanel() {
  const clientOptions = useClientOptions();
  const columns = useMemo<ColumnDef<any, ContactRow, unknown>[]>(
    () => [
      cell<ContactRow>('Name', (row) => <span className="font-medium">{row.name}</span>),
      cell<ContactRow>('Client', (row) => dash(row.client?.name)),
      cell<ContactRow>('Role', (row) => dash(row.role)),
      cell<ContactRow>('Mobile', (row) => dash(row.mobile)),
      cell<ContactRow>('Email', (row) => dash(row.email)),
      moneyCell<ContactRow>('Jobs', (row) => row._count?.jobs ?? 0),
    ],
    [],
  );

  return (
    <MasterDataPanel<ContactRow>
      resource={CONTACTS}
      rowKey={(row) => row.id}
      columns={() => columns}
      options={{ clientId: clientOptions }}
    />
  );
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export function ContractsPanel() {
  const clientOptions = useClientOptions();
  const columns = useMemo<ColumnDef<any, ContractRow, unknown>[]>(
    () => [
      cell<ContractRow>('Number', (row) => (
        <>
          <span className="font-mono font-medium">{row.number}</span>
          <span className="block text-xs text-muted-foreground">{row.description}</span>
        </>
      )),
      cell<ContractRow>('Client', (row) => dash(row.client?.name)),
      cell<ContractRow>('Type', (row) => dash(row.type)),
      moneyCell<ContractRow>('Amendments', (row) => row.amendments?.length ?? 0),
      cell<ContractRow>('Current', (row) => {
        const active = row.amendments?.find((a) => a.status === 'Active');
        return active ? (
          <>
            <StatusBadge status={active.status} />
            <span className="block text-xs text-muted-foreground">
              No. {active.amendmentNumber}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">None active</span>
        );
      }),
    ],
    [],
  );

  return (
    <MasterDataPanel<ContractRow>
      resource={CONTRACTS}
      rowKey={(row) => row.id}
      columns={() => columns}
      options={{ clientId: clientOptions }}
    />
  );
}

// ---------------------------------------------------------------------------
// Amendments
// ---------------------------------------------------------------------------

export function AmendmentsPanel() {
  const contractOptions = useContractOptions();
  const columns = useMemo<ColumnDef<any, AmendmentRow, unknown>[]>(
    () => [
      cell<AmendmentRow>('Amendment', (row) => (
        <>
          <span className="font-mono font-medium">No. {row.amendmentNumber}</span>
          <span className="block text-xs text-muted-foreground">{row.amendmentType}</span>
        </>
      )),
      cell<AmendmentRow>('Contract', (row) => (
        <>
          <span className="font-mono">{row.contract?.number ?? '—'}</span>
          {row.contract?.client && (
            <span className="block text-xs text-muted-foreground">{row.contract.client.name}</span>
          )}
        </>
      )),
      cell<AmendmentRow>('Status', (row) => <StatusBadge status={row.status} />),
      cell<AmendmentRow>('Effective', (row) => dash(row.effectiveDate)),
      cell<AmendmentRow>('Expiry', (row) => dash(row.expiryDate)),
      cell<AmendmentRow>('VAT', (row) => (
        <span className="font-mono text-xs">{Math.round(row.vatRate * 10000) / 100}%</span>
      )),
      cell<AmendmentRow>('Used by', (row) => {
        const c = row._count;
        if (!c) return <span className="text-muted-foreground">—</span>;
        const parts = [
          c.serviceMasterRates ? `${c.serviceMasterRates} rates` : null,
          c.serviceCodes ? `${c.serviceCodes} codes` : null,
          c.projects ? `${c.projects} projects` : null,
          c.jobs ? `${c.jobs} jobs` : null,
        ].filter(Boolean);
        return parts.length ? (
          <span>{parts.join(', ')}</span>
        ) : (
          <span className="text-muted-foreground">Unreferenced</span>
        );
      }),
    ],
    [],
  );

  return (
    <MasterDataPanel<AmendmentRow>
      resource={AMENDMENTS}
      rowKey={(row) => row.id}
      columns={() => columns}
      options={{ contractId: contractOptions }}
    />
  );
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function ProjectsPanel() {
  const contractOptions = useContractOptions();
  const amendments = useQuery({
    queryKey: ['amendments', 'options'],
    queryFn: () => api.get<{ amendments: AmendmentOption[] }>('/api/amendments'),
  });

  // The amendment picker follows the contract. Passing the contract list here was
  // the bug: both dropdowns showed the same thing, and neither was an amendment.
  const optionsFor = useMemo(() => {
    const contracts = contractOptions;
    const all = amendments.data?.amendments ?? [];
    return (fieldName: string, values: Record<string, string | boolean>) => {
      if (fieldName === 'contractId') return contracts;
      if (fieldName === 'amendmentId')
        return amendmentOptionsFor(all, selectedId(values.contractId));
      return undefined;
    };
  }, [contractOptions, amendments.data]);

  const columns = useMemo<ColumnDef<any, ProjectRow, unknown>[]>(
    () => [
      cell<ProjectRow>('Code', (row) => (
        <>
          <span className="font-mono font-medium">{row.code}</span>
          {row.description && (
            <span className="block text-xs text-muted-foreground">{row.description}</span>
          )}
        </>
      )),
      moneyCell<ProjectRow>('Year', (row) => row.year),
      cell<ProjectRow>('Contract', (row) => (
        <span className="font-mono">{row.contract?.number ?? '—'}</span>
      )),
      moneyCell<ProjectRow>('Jobs', (row) => row._count?.jobs ?? 0),
      cell<ProjectRow>('Start', (row) => dash(row.startDate)),
      cell<ProjectRow>('End', (row) => dash(row.endDate)),
    ],
    [],
  );

  return (
    <MasterDataPanel<ProjectRow>
      resource={PROJECTS}
      rowKey={(row) => row.id}
      columns={() => columns}
      optionsFor={optionsFor}
    />
  );
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export function EmployeesPanel() {
  const brokers = useQuery({
    queryKey: ['brokers', 'options'],
    queryFn: () => api.get<{ brokers: Array<{ id: number; name: string }> }>('/api/brokers'),
  });
  const types = useQuery({
    queryKey: ['employee-contract-types', 'options'],
    queryFn: () =>
      api.get<{ types: Array<{ id: number; name: string }> }>('/api/employee-contract-types'),
  });
  const managers = useQuery({
    queryKey: ['employees', 'options'],
    queryFn: () =>
      api.get<{ employees: Array<{ id: number; fullName: string }> }>('/api/employees'),
  });

  const options = useMemo(
    () => ({
      brokerId: (brokers.data?.brokers ?? []).map((b) => ({ value: String(b.id), label: b.name })),
      contractTypeId: (types.data?.types ?? []).map((t) => ({
        value: String(t.id),
        label: t.name,
      })),
      managerId: (managers.data?.employees ?? []).map((e) => ({
        value: String(e.id),
        label: e.fullName,
      })),
    }),
    [brokers.data, types.data, managers.data],
  );

  const columns = useMemo<ColumnDef<any, EmployeeRow, unknown>[]>(
    () => [
      cell<EmployeeRow>('Name', (row) => (
        <>
          <span className="font-medium">
            {row.name} {row.surname}
          </span>
          {!row.isActive && (
            <span className="block text-xs text-muted-foreground">Ended {row.endDate ?? ''}</span>
          )}
        </>
      )),
      cell<EmployeeRow>('Contact', (row) => (
        <>
          <span>{row.mobile ?? '—'}</span>
          {row.email && <span className="block text-xs text-muted-foreground">{row.email}</span>}
        </>
      )),
      cell<EmployeeRow>('Contract type', (row) => dash(row.contractType?.name)),
      cell<EmployeeRow>('Broker', (row) => dash(row.broker?.name)),
      cell<EmployeeRow>('Manager', (row) =>
        row.manager ? `${row.manager.name} ${row.manager.surname}` : '—',
      ),
      moneyCell<EmployeeRow>('Rate (ZAR/hr)', (row) => row.rate),
      cell<EmployeeRow>('Started', (row) => dash(row.startDate)),
    ],
    [],
  );

  return (
    <MasterDataPanel<EmployeeRow>
      resource={EMPLOYEES}
      rowKey={(row) => row.id}
      columns={() => columns}
      options={options}
    />
  );
}

// ---------------------------------------------------------------------------
// Brokers
// ---------------------------------------------------------------------------

export function BrokersPanel() {
  const columns = useMemo<ColumnDef<any, BrokerRow, unknown>[]>(
    () => [
      cell<BrokerRow>('Broker', (row) => <span className="font-medium">{row.name}</span>),
      moneyCell<BrokerRow>('Active employees', (row) => row.activeEmployees),
    ],
    [],
  );

  return (
    <MasterDataPanel<BrokerRow>
      resource={BROKERS}
      rowKey={(row) => row.id}
      columns={() => columns}
    />
  );
}

// ---------------------------------------------------------------------------
// Employee contract types
// ---------------------------------------------------------------------------

export function ContractTypesPanel() {
  const columns = useMemo<ColumnDef<any, ContractTypeRow, unknown>[]>(
    () => [
      cell<ContractTypeRow>('Type', (row) => <span className="font-medium">{row.name}</span>),
      moneyCell<ContractTypeRow>('Employees', (row) => row.employees),
    ],
    [],
  );

  return (
    <MasterDataPanel<ContractTypeRow>
      resource={CONTRACT_TYPES}
      rowKey={(row) => row.id}
      columns={() => columns}
    />
  );
}
