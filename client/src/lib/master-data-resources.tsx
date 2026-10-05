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
import {
  JOB_STATUSES,
  amendmentTypeValues,
  contractAmendmentStatusValues,
  jobPriorityValues,
} from '@openerp/shared';
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
  isArchived?: boolean;
  vatNumber: string | null;
  _count?: { contracts: number };
}

export interface ContactRow {
  id: number;
  clientId: number;
  name: string;
  mobile: string | null;
  email: string | null;
  /** Phase 8 item 4: e.g. "Accounts receivable", "Site contact". */
  role: string | null;
  isArchived?: boolean;
  client: { id: number; name: string };
  _count?: { jobs: number };
}

export interface ContractRow {
  id: number;
  clientId?: number;
  isArchived?: boolean;
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
  isArchived?: boolean;
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
  isArchived?: boolean;
  activeEmployees: number;
}

export interface ContractTypeRow {
  id: number;
  name: string;
  isArchived?: boolean;
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
  supportsArchive: true,
  archivePath: 'clients',
  archivePermission: 'client.archive',
  archiveWarning:
    'The client disappears from every picker - no new contract, project or contact can be created against it - but existing contracts, jobs and invoices are untouched and still show this client. Restorable at any time.',
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
  supportsArchive: true,
  archivePath: 'contacts',
  archivePermission: 'contact.archive',
  archiveWarning:
    'The contact disappears from the job contact picker. Jobs already naming this person are unaffected. The server refuses to archive a contact still named on a job.',
  searchKeys: ['name', 'email', 'mobile', 'client.name'],
  searchPlaceholder: 'Search contacts…',
  fields: [
    { name: 'clientId', label: 'Client', kind: 'select', required: true, header: 'Client' },
    { name: 'name', label: 'Contact name', kind: 'text', required: true },
    {
      name: 'role',
      label: 'Role at client',
      kind: 'text',
      nullable: true,
      placeholder: 'e.g. Accounts receivable',
      hint: 'Free text, so a picker can tell the finance contact from the site contact.',
    },
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
  supportsArchive: true,
  archivePath: 'contracts',
  archivePermission: 'contract.archive',
  archiveWarning:
    'The contract disappears from the project and amendment pickers. Its amendments are NOT archived with it, and existing projects and jobs are untouched. The server refuses while any job is still running.',
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
  supportsArchive: true,
  archivePath: 'amendments',
  archivePermission: 'amendment.archive',
  archiveWarning:
    'The amendment disappears from the project and job pickers. Its rate cards, service codes and cost parameters are NOT archived with it. The server refuses while any job is priced against it.',
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
// Jobs
// ---------------------------------------------------------------------------

export interface JobMasterRow {
  id: number;
  status: string;
  priority: string;
  description: string | null;
  workOrder: string | null;
  workOrderReceivedDate: string | null;
  purchaseOrder: string | null;
  purchaseOrderReceivedDate: string | null;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  area: string | null;
  projectId?: number;
  amendmentId?: number | null;
  supervisorId?: number | null;
  clientContactId?: number | null;
  project: { id: number; code: string; year: number; contract?: { number: string } };
  supervisor: { id: number; name: string; surname: string } | null;
  _count?: { serviceCodes: number; assignments: number; invoices: number };
}

/**
 * Jobs.
 *
 * Included in the generic panel despite not being master data, because the
 * create/edit form is genuinely just fields. What is deliberately NOT a field:
 *
 *  - **`status`.** A job's status is lifecycle state, not an attribute. It moves
 *    only through `POST /api/jobs/:id/transition`, which enforces the 13-step
 *    state machine and the permission each step needs. Putting it in a PATCH form
 *    would offer a control that either does nothing or bypasses the gate, which is
 *    the exact bug ADR-003 exists to prevent. The status column is read-only and
 *    the transitions live on the job card.
 *  - **`actualStartDate` / `actualEndDate`.** Field supervisors enter these at
 *    the point of work, on the job card, alongside the actuals. They are not a
 *    planning-office edit.
 *
 * So this panel creates and maintains a job's *paperwork*; the job card owns its
 * lifecycle and its actuals.
 */
export const JOBS: ResourceDef<JobMasterRow> = {
  singular: 'Job',
  plural: 'Jobs',
  queryKey: ['jobs'],
  path: 'jobs',
  writePermission: 'job.write',
  deletePermission: 'job.delete',
  searchKeys: [
    'description',
    'workOrder',
    'purchaseOrder',
    'area',
    'project.code',
    'supervisor.name',
    'supervisor.surname',
  ],
  searchPlaceholder: 'Search jobs…',
  fields: [
    { name: 'projectId', label: 'Project', kind: 'select', required: true, header: 'Project' },
    {
      name: 'amendmentId',
      label: 'Amendment',
      kind: 'select',
      nullable: true,
      // Resolved per-form: only the chosen project's amendments.
      hint: 'Leave blank to inherit the project’s amendment.',
    },
    {
      name: 'supervisorId',
      label: 'Supervisor',
      kind: 'select',
      nullable: true,
      hint: 'A site supervisor, from the employee directory.',
    },
    {
      name: 'clientContactId',
      label: 'Client contact',
      kind: 'select',
      nullable: true,
      hint: 'The person at the client who placed the order.',
    },
    { name: 'workOrder', label: 'Work order', kind: 'text', nullable: true },
    { name: 'workOrderReceivedDate', label: 'WO received', kind: 'date', nullable: true },
    { name: 'purchaseOrder', label: 'Purchase order', kind: 'text', nullable: true },
    { name: 'purchaseOrderReceivedDate', label: 'PO received', kind: 'date', nullable: true },
    { name: 'plannedStartDate', label: 'Planned start', kind: 'date', nullable: true },
    { name: 'plannedEndDate', label: 'Planned end', kind: 'date', nullable: true },
    { name: 'area', label: 'Area', kind: 'text', nullable: true, placeholder: 'e.g. Substation 6' },
    {
      name: 'priority',
      label: 'Priority',
      kind: 'select',
      required: true,
      options: jobPriorityValues.map((value) => ({ value, label: value })),
    },
    { name: 'description', label: 'Description', kind: 'text', nullable: true },
  ],
  filters: [
    {
      id: 'status',
      label: 'Status',
      // Built from the shared state machine, not from whatever statuses happen to
      // appear in the data. A status that no job currently holds must still be
      // selectable, or the filter cannot be used to ask "is anything stuck here?".
      options: [
        { value: '', label: 'Any' },
        ...JOB_STATUSES.map((status) => ({ value: status, label: status })),
      ],
      predicate: (row, value) => row.status === value,
    },
    {
      id: 'priority',
      label: 'Priority',
      options: [
        { value: '', label: 'Any' },
        ...jobPriorityValues.map((value) => ({ value, label: value })),
      ],
      predicate: (row, value) => row.priority === value,
    },
    {
      id: 'supervised',
      label: 'Supervisor',
      options: [
        { value: '', label: 'Any' },
        { value: 'yes', label: 'Assigned' },
        { value: 'no', label: 'Unassigned' },
      ],
      predicate: (row, value) => (value === 'yes' ? Boolean(row.supervisor) : !row.supervisor),
    },
  ],
  deleteWarning:
    'A job is deleted only while it has no deliverables, crew or invoices. Once work has been scoped or measured it belongs to the record — cancel it through the lifecycle instead.',
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
  supportsArchive: true,
  archivePath: 'brokers',
  archivePermission: 'broker.archive',
  archiveWarning:
    'The broker disappears from the employee picker. Employees already assigned to it keep the link and still show the name. The server refuses while any employee holds it.',
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
  supportsArchive: true,
  archivePath: 'employee-contract-types',
  archivePermission: 'contracttype.archive',
  archiveWarning:
    'The contract type disappears from the employee form. Employees already on it keep the link. The server refuses while any employee holds it, because contractTypeId is mandatory and there is no unassigned state to move them into.',
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
 * An archived row's marker.
 *
 * Rendered rather than the row merely being greyed, because "why is this dim?" is
 * a question the user should never have to ask: if a contract is absent from a
 * picker, the register has to say *archived* rather than silently omit it. That is
 * the whole safety argument for the column - the audit trail of a retirement stays
 * visible.
 */
export function ArchivedBadge() {
  return (
    <Badge variant="secondary" className="text-[10px]">
      Archived
    </Badge>
  );
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
