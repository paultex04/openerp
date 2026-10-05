'use client';

/**
 * Field descriptors for every master-data panel.
 *
 * Kept apart from the panels themselves so the shape of an entity can be read in
 * one place. Each descriptor names the fields, how to render each one, and which
 * permission gates the whole panel.
 *
 * Option lists are NOT declared here. A `select` field whose options come from
 * another table (a contract's client, an employee's broker) is resolved by the
 * panel at runtime, because a descriptor cannot hold live data. See
 * `MasterDataPanel`'s `options` prop.
 */
import { Badge } from '@/components/ui/badge';
import { statusVariant } from '@/lib/lifecycle-status';
import { formatDate, formatZar } from '@/lib/format';
import { amendmentTypeValues, contractAmendmentStatusValues } from '@openerp/shared';
import type { ResourceDef } from '@/lib/master-data';

// ---------------------------------------------------------------------------
// Record shapes. These mirror the server's serialisers; the shared Zod schemas
// validate the request side, and `api.ts` types the responses per screen.
// ---------------------------------------------------------------------------

export interface ClientRow {
  id: number;
  name: string;
  email: string;
  address: string | null;
  isVatRegistered: boolean;
  vatNumber: string | null;
  _count?: { contracts: number };
}

export interface ContactRow {
  id: number;
  clientId: number;
  name: string;
  mobile: string | null;
  email: string | null;
  client: { id: number; name: string };
  _count?: { jobs: number };
}

export interface ContractRow {
  id: number;
  clientId?: number;
  number: string;
  description: string;
  type: string | null;
  client: { id: number; name: string; isVatRegistered: boolean; vatNumber: string | null };
  amendments: Array<{
    id: number;
    amendmentNumber: string;
    status: string;
    effectiveDate: string;
    expiryDate: string | null;
    vatRate: number;
  }>;
  _count?: { projects: number };
}

export interface AmendmentRow {
  id: number;
  contractId: number;
  amendmentNumber: string;
  amendmentType: string;
  effectiveDate: string;
  expiryDate: string | null;
  signedDate: string | null;
  status: string;
  notes: string | null;
  vatRate: number;
  contract?: { id: number; number: string; client: { name: string } };
  _count?: {
    costParameters: number;
    serviceMasterRates: number;
    serviceCodes: number;
    projects: number;
    jobs: number;
  };
}

export interface ProjectRow {
  id: number;
  code: string;
  year: number;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  contract?: { id: number; number: string };
  amendment?: { id: number; amendmentNumber: string } | null;
  contractId?: number;
  amendmentId?: number;
  _count?: { jobs: number };
}

export interface EmployeeRow {
  id: number;
  name: string;
  surname: string;
  fullName: string;
  mobile: string | null;
  email: string | null;
  idNumber: string | null;
  startDate: string;
  endDate: string | null;
  rate: number | null;
  isActive: boolean;
  brokerId: number | null;
  contractTypeId: number;
  managerId: number | null;
  broker: { id: number; name: string } | null;
  contractType: { id: number; name: string };
  manager: { id: number; name: string; surname: string } | null;
  _count?: { jobAssignments: number; supervisedJobs: number };
}

export interface BrokerRow {
  id: number;
  name: string;
  activeEmployees: number;
}

export interface ContractTypeRow {
  id: number;
  name: string;
  employees: number;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export const CLIENTS: ResourceDef<ClientRow> = {
  singular: 'Client',
  plural: 'Clients',
  queryKey: ['clients'],
  path: 'clients',
  writePermission: 'contract.write',
  deletePermission: 'contract.delete',
  searchKeys: ['name', 'email', 'vatNumber'],
  searchPlaceholder: 'Search clients…',
  fields: [
    { name: 'name', label: 'Company name', kind: 'text', required: true },
    { name: 'email', label: 'Email', kind: 'email', required: true, nullable: true },
    { name: 'address', label: 'Address', kind: 'text', nullable: true },
    {
      name: 'isVatRegistered',
      label: 'VAT registered',
      kind: 'boolean',
      hint: 'When off, invoices raised for this client must not charge VAT.',
    },
    {
      name: 'vatNumber',
      label: 'SARS VAT number',
      kind: 'text',
      nullable: true,
      placeholder: '10 digits',
      hint: 'Printed on tax invoices. Required for the VAT compliance check to pass.',
    },
  ],
  filters: [
    {
      id: 'vat',
      label: 'VAT',
      options: [
        { value: '', label: 'Any' },
        { value: 'registered', label: 'Registered' },
        { value: 'unregistered', label: 'Not registered' },
      ],
      predicate: (row, value) =>
        value === 'registered' ? row.isVatRegistered : !row.isVatRegistered,
    },
  ],
  deleteWarning:
    'A client with contracts or contacts cannot be deleted — the server refuses with the blocking count. Delete those first, or leave the client as the historical record.',
};

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export const CONTACTS: ResourceDef<ContactRow> = {
  singular: 'Contact',
  plural: 'Client contacts',
  queryKey: ['contacts'],
  path: 'contacts',
  writePermission: 'contact.write',
  deletePermission: 'contact.delete',
  searchKeys: ['name', 'email', 'mobile', 'client.name'],
  searchPlaceholder: 'Search contacts…',
  fields: [
    { name: 'clientId', label: 'Client', kind: 'select', required: true, header: 'Client' },
    { name: 'name', label: 'Contact name', kind: 'text', required: true },
    { name: 'mobile', label: 'Mobile', kind: 'tel', nullable: true },
    { name: 'email', label: 'Email', kind: 'email', nullable: true },
  ],
  deleteWarning:
    'A contact named on a job card cannot be deleted — reassign those jobs first, or the job would point at nobody.',
};

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export const CONTRACTS: ResourceDef<ContractRow> = {
  singular: 'Contract',
  plural: 'Contracts',
  queryKey: ['contracts'],
  path: 'contracts',
  writePermission: 'contract.write',
  deletePermission: 'contract.delete',
  searchKeys: ['number', 'description', 'type', 'client.name'],
  searchPlaceholder: 'Search contracts…',
  fields: [
    { name: 'number', label: 'Contract number', kind: 'text', required: true },
    { name: 'clientId', label: 'Client', kind: 'select', required: true, header: 'Client' },
    { name: 'description', label: 'Description', kind: 'text', required: true },
    { name: 'type', label: 'Type', kind: 'text', nullable: true, placeholder: 'e.g. Framework' },
  ],
  deleteWarning:
    'A contract with amendments or projects cannot be deleted. Terminate or supersede it instead.',
};

// ---------------------------------------------------------------------------
// Amendments
// ---------------------------------------------------------------------------

export const AMENDMENTS: ResourceDef<AmendmentRow> = {
  singular: 'Amendment',
  plural: 'Amendments',
  queryKey: ['amendments'],
  path: 'amendments',
  writePermission: 'amendment.write',
  deletePermission: 'amendment.delete',
  searchKeys: [
    'amendmentNumber',
    'amendmentType',
    'status',
    'contract.number',
    'contract.client.name',
  ],
  searchPlaceholder: 'Search amendments…',
  fields: [
    { name: 'contractId', label: 'Contract', kind: 'select', required: true, header: 'Contract' },
    {
      name: 'amendmentNumber',
      label: 'Amendment no.',
      kind: 'text',
      required: true,
      placeholder: '01',
      hint: 'Unique within the contract.',
    },
    {
      name: 'amendmentType',
      label: 'Type',
      kind: 'select',
      required: true,
      options: amendmentTypeValues.map((value) => ({ value, label: value })),
    },
    { name: 'effectiveDate', label: 'Effective date', kind: 'date', required: true },
    { name: 'expiryDate', label: 'Expiry date', kind: 'date', nullable: true },
    { name: 'signedDate', label: 'Signed date', kind: 'date', nullable: true },
    {
      name: 'status',
      label: 'Status',
      kind: 'select',
      required: true,
      options: contractAmendmentStatusValues.map((value) => ({ value, label: value })),
    },
    {
      name: 'vatRate',
      label: 'VAT rate',
      kind: 'number',
      placeholder: '0.15',
      hint: 'As a fraction: 0.15 = 15%. Snapshotted onto each invoice.',
    },
    { name: 'notes', label: 'Notes', kind: 'text', nullable: true },
  ],
  deleteWarning:
    'An amendment referenced by cost parameters, rate cards, service codes, projects or jobs cannot be deleted. Supersede it with a new amendment instead.',
};

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const PROJECTS: ResourceDef<ProjectRow> = {
  singular: 'Project',
  plural: 'Projects',
  queryKey: ['projects'],
  path: 'projects',
  writePermission: 'project.write',
  deletePermission: 'project.delete',
  searchKeys: ['code', 'description', 'contract.number'],
  searchPlaceholder: 'Search projects…',
  fields: [
    {
      name: 'code',
      label: 'Project code',
      kind: 'text',
      required: true,
      placeholder: 'P-2026-001',
    },
    { name: 'contractId', label: 'Contract', kind: 'select', required: true, header: 'Contract' },
    {
      name: 'amendmentId',
      label: 'Amendment',
      kind: 'select',
      nullable: true,
      hint: 'Leave blank to inherit the contract’s active amendment.',
    },
    { name: 'year', label: 'Year', kind: 'number', required: true, placeholder: '2026' },
    { name: 'startDate', label: 'Start date', kind: 'date', nullable: true },
    { name: 'endDate', label: 'End date', kind: 'date', nullable: true },
    { name: 'description', label: 'Description', kind: 'text', nullable: true },
  ],
  deleteWarning: 'A project with jobs cannot be deleted — the jobs reference it.',
};

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export const EMPLOYEES: ResourceDef<EmployeeRow> = {
  singular: 'Employee',
  plural: 'Employees',
  queryKey: ['employees'],
  path: 'employees',
  // Note: `employee.write`, not a delete key. There is no employee hard delete,
  // so the panel's remove action is "End employment", which sets `endDate`.
  writePermission: 'employee.write',
  deletePermission: 'employee.write',
  softDeleteNoun: 'End employment for',
  searchKeys: ['fullName', 'email', 'mobile', 'idNumber', 'broker.name', 'contractType.name'],
  searchPlaceholder: 'Search employees…',
  fields: [
    { name: 'name', label: 'First name', kind: 'text', required: true },
    { name: 'surname', label: 'Surname', kind: 'text', required: true },
    { name: 'idNumber', label: 'ID number', kind: 'text', nullable: true },
    { name: 'mobile', label: 'Mobile', kind: 'tel', nullable: true },
    { name: 'email', label: 'Email', kind: 'email', nullable: true },
    { name: 'startDate', label: 'Start date', kind: 'date', required: true },
    {
      name: 'endDate',
      label: 'End date',
      kind: 'date',
      nullable: true,
      hint: 'Set to terminate employment. Cleared again to re-activate.',
    },
    { name: 'contractTypeId', label: 'Contract type', kind: 'select', required: true },
    { name: 'brokerId', label: 'Broker', kind: 'select', nullable: true },
    { name: 'managerId', label: 'Manager', kind: 'select', nullable: true },
    { name: 'rate', label: 'Rate (ZAR/hr)', kind: 'money', nullable: true, placeholder: '0.00' },
  ],
  filters: [
    {
      id: 'status',
      label: 'Status',
      options: [
        { value: '', label: 'Any' },
        { value: 'active', label: 'Employed' },
        { value: 'inactive', label: 'Ended' },
      ],
      predicate: (row, value) => (value === 'active' ? row.isActive : !row.isActive),
    },
  ],
  deleteWarning:
    'This sets an end date rather than deleting the record, because the employee supervises jobs and appears on crew assignments. Any linked sign-in account is deactivated at the same time. Clear the end date to undo.',
};

// ---------------------------------------------------------------------------
// Brokers
// ---------------------------------------------------------------------------

export const BROKERS: ResourceDef<BrokerRow> = {
  singular: 'Broker',
  plural: 'Brokers',
  queryKey: ['brokers'],
  path: 'brokers',
  writePermission: 'broker.write',
  deletePermission: 'broker.delete',
  searchKeys: ['name'],
  searchPlaceholder: 'Search brokers…',
  fields: [{ name: 'name', label: 'Broker name', kind: 'text', required: true }],
  deleteWarning:
    'A broker with employees cannot be deleted — reassign them first, or leave the broker as the historical record.',
};

// ---------------------------------------------------------------------------
// Employee contract types
// ---------------------------------------------------------------------------

export const CONTRACT_TYPES: ResourceDef<ContractTypeRow> = {
  singular: 'Contract type',
  plural: 'Employee contract types',
  queryKey: ['employee-contract-types'],
  path: 'employee-contract-types',
  writePermission: 'contracttype.write',
  deletePermission: 'contracttype.delete',
  searchKeys: ['name'],
  searchPlaceholder: 'Search contract types…',
  fields: [{ name: 'name', label: 'Type name', kind: 'text', required: true }],
  deleteWarning:
    'A contract type held by any employee cannot be deleted — `contractTypeId` is mandatory on an employee, so there is no “unassigned” state to move them into.',
};

// ---------------------------------------------------------------------------
// Shared cell renderers, used by the per-resource column builders.
// ---------------------------------------------------------------------------

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={statusVariant(status)}>{status}</Badge>;
}

/**
 * Money as text. The column declares `meta.align = 'right'` instead, which is how
 * `DataTable` decides to apply the numeric-cell treatment — a renderer that
 * returned its own `<td>` would produce `<td><td>`.
 */
export function MoneyText({ value }: { value: number | null | undefined }): React.ReactNode {
  if (value === null || value === undefined)
    return <span className="text-muted-foreground">—</span>;
  return <span>{formatZar(value)}</span>;
}

/** An ISO date as stored, or a muted em dash. */
export function DateText({ value }: { value: string | null | undefined }): React.ReactNode {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return <span className="whitespace-nowrap">{formatDate(value)}</span>;
}
