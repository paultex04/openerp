/**
 * Role-Based Access Control catalogue.
 *
 * This module is the single source of truth for who may do what, and is shared
 * verbatim by the API guard, the seed script and the client so the UI can hide
 * controls the server would reject anyway.
 *
 * Design notes:
 *  * A user may hold one or more roles. Effective permissions are the UNION of
 *    every role's permissions, so a person who is both QS and Billing Clerk
 *    legitimately gains both sets of capabilities.
 *  * `administrator` is granted the full permission set explicitly rather than
 *    via a wildcard. That keeps the Phase 5 permissions-matrix screen honest:
 *    it can display exactly which rows an administrator holds, and revoking a
 *    single capability is a normal UPDATE rather than special-case logic.
 */

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const ROLE_ADMINISTRATOR = 'administrator';
export const ROLE_COMMERCIAL_QS = 'commercial_qs';
export const ROLE_PROJECT_MANAGER = 'project_manager';
export const ROLE_SITE_SUPERVISOR = 'site_supervisor';
export const ROLE_BILLING_CLERK = 'billing_clerk';

export interface RoleDefinition {
  key: string;
  name: string;
  description: string;
}

export const ROLES: readonly RoleDefinition[] = [
  {
    key: ROLE_ADMINISTRATOR,
    name: 'Administrator',
    description:
      'Unrestricted read/write/delete. Manages users, assignable roles, system settings, database parameters and workflow overrides.',
  },
  {
    key: ROLE_COMMERCIAL_QS,
    name: 'Commercial / Quantity Surveyor',
    description:
      'Manages contracts, amendments, cost parameters, service master rates, activity recipes, R1 material BOMs and invoices.',
  },
  {
    key: ROLE_PROJECT_MANAGER,
    name: 'Project Manager',
    description:
      'Creates and manages projects and baseline job scoping; transitions jobs from 01. Scoping to 02. Awaiting PO and monitors cost variances.',
  },
  {
    key: ROLE_SITE_SUPERVISOR,
    name: 'Site Supervisor / Field Engineer',
    description:
      'Restricted to assigned jobs. Enters actual start/end dates and logs field measured actual quantities, then submits jobs for pack preparation.',
  },
  {
    key: ROLE_BILLING_CLERK,
    name: 'Billing / Financial Clerk',
    description:
      'Read-only on operational scoping; full access from 07. Pack Ready through 10. Invoiced / 11. Partially Invoiced, plus invoice generation and status management.',
  },
] as const;

export const ROLE_KEYS = ROLES.map((r) => r.key);

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export const PERMISSION_CATEGORIES = [
  'contract',
  'amendment',
  'pricing',
  'project',
  'job',
  'actuals',
  'invoice',
  'organisation',
  'admin',
] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

export interface PermissionDefinition {
  key: string;
  category: PermissionCategory;
  description: string;
}

const P = (
  key: string,
  category: PermissionCategory,
  description: string,
): PermissionDefinition => ({ key, category, description });

export const PERMISSIONS: readonly PermissionDefinition[] = [
  // --- Contracts -----------------------------------------------------------
  P('contract.read', 'contract', 'View contracts and their clients.'),
  P('contract.write', 'contract', 'Create and edit contracts.'),
  P('contract.delete', 'contract', 'Delete contracts.'),

  // --- Amendments & cost parameters ---------------------------------------
  P('amendment.read', 'amendment', 'View contract amendments and versioning.'),
  P('amendment.write', 'amendment', 'Create, edit and version contract amendments.'),
  P('amendment.delete', 'amendment', 'Delete contract amendments.'),
  P('costparameter.read', 'amendment', 'View global cost parameter configuration.'),
  P('costparameter.write', 'amendment', 'Edit global cost parameter configuration.'),

  // --- Pricing -------------------------------------------------------------
  P('ratemaster.read', 'pricing', 'View Tier 1 labour master rate cards.'),
  P('ratemaster.write', 'pricing', 'Edit Tier 1 labour rate components and build-up.'),
  P('servicecode.read', 'pricing', 'View Tier 2 service code master.'),
  P('servicecode.write', 'pricing', 'Create and edit Tier 2 service code master.'),
  P('servicecode.delete', 'pricing', 'Delete service codes.'),
  P('recipe.labour.write', 'pricing', 'Attach trade roles, crew size and hours per unit.'),
  P('recipe.material.write', 'pricing', 'Build and edit R1 material BOM lines.'),

  // --- Projects ------------------------------------------------------------
  P('project.read', 'project', 'View projects.'),
  P('project.write', 'project', 'Create and edit projects.'),
  P('project.delete', 'project', 'Delete projects.'),

  // --- Jobs ----------------------------------------------------------------
  P('job.read', 'job', 'View job cards and their deliverables.'),
  P('job.read.assigned', 'job', 'View only jobs the user is assigned to.'),
  P('job.write', 'job', 'Create and edit job cards.'),
  P('job.delete', 'job', 'Delete job cards.'),
  P('job.assign', 'job', 'Attach employees to job cards with operational roles.'),
  P('job.transition.scope', 'job', 'Advance a job through the scoping stages (01 -> 01A -> 02).'),
  P(
    'job.transition.execute',
    'job',
    'Advance a job through execution stages (03 -> 04 -> 05 -> 06).',
  ),
  P('job.transition.pack', 'job', 'Submit a completed job for pack preparation (06 -> 07).'),
  P('job.transition.billing', 'job', 'Advance a job through billing stages (07 -> 08 -> 09).'),
  P('job.transition.invoice', 'job', 'Mark a job as invoiced or partially invoiced.'),
  P('job.transition.cancel', 'job', 'Cancel a job.'),

  // --- Actuals -------------------------------------------------------------
  P('deliverable.read', 'actuals', 'View job deliverables with planned vs actual variance.'),
  P('deliverable.write.planned', 'actuals', 'Edit planned quantities during scoping.'),
  P(
    'deliverable.write.actual',
    'actuals',
    'Enter actual quantities and actual dates in the field.',
  ),

  // --- Invoicing -----------------------------------------------------------
  P('invoice.read', 'invoice', 'View the invoice register and invoice details.'),
  P('invoice.write', 'invoice', 'Generate and edit draft invoices.'),
  P('invoice.submit', 'invoice', 'Submit an invoice for approval.'),
  P('invoice.approve', 'invoice', 'Approve an invoice.'),
  P('invoice.status', 'invoice', 'Change invoice status (paid, disputed, cancelled).'),

  // --- Organisation (Phase 7) ---------------------------------------------
  // Clients deliberately ride on `contract.*` rather than having their own keys,
  // so that a client read/write/delete shows under Commercial in the permission
  // matrix. These four tables have no such natural commercial owner, so they get
  // an explicit category. See ADR-007 Q1.
  P('employee.read', 'organisation', 'View the employee directory and org chart.'),
  P('employee.write', 'organisation', 'Create and edit employee records.'),
  P('broker.read', 'organisation', 'View labour brokers.'),
  P('broker.write', 'organisation', 'Create and edit labour brokers.'),
  P('broker.delete', 'organisation', 'Delete labour brokers with no employees.'),
  P('contracttype.read', 'organisation', 'View employee contract types.'),
  P('contracttype.write', 'organisation', 'Create and edit employee contract types.'),
  P(
    'contracttype.delete',
    'organisation',
    'Delete employee contract types that no employee holds.',
  ),
  P('contact.read', 'organisation', 'View client contacts.'),
  P('contact.write', 'organisation', 'Create and edit client contacts.'),
  P('contact.delete', 'organisation', 'Delete client contacts that are not on a job.'),

  // --- Administration ------------------------------------------------------
  P('admin.user.read', 'admin', 'View application users.'),
  P('admin.user.write', 'admin', 'Create users, link employees and reset credentials.'),
  P('admin.role.read', 'admin', 'View roles and the permission matrix.'),
  P('admin.role.write', 'admin', 'Grant or revoke role assignments and permissions.'),
  P('admin.audit.read', 'admin', 'Read the system audit log.'),
] as const;

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

// ---------------------------------------------------------------------------
// Role -> permission grants
// ---------------------------------------------------------------------------

const keysOf = (...prefixes: string[]): string[] =>
  PERMISSION_KEYS.filter((k) => prefixes.some((p) => k.startsWith(p)));

/** Everything the commercial side of the business may touch. */
const COMMERCIAL_GRANTS: string[] = [
  ...keysOf('contract.', 'amendment.', 'costparameter.', 'ratemaster.', 'servicecode.', 'recipe.'),
  'project.read',
  'job.read',
  'deliverable.read',
  'invoice.read',
  'invoice.write',
  'invoice.submit',
];

/** The PM owns scoping but has no commercial rate authority. */
const PROJECT_MANAGER_GRANTS: string[] = [
  'project.read',
  'project.write',
  'job.read',
  'job.write',
  'job.assign',
  'job.transition.scope',
  'deliverable.read',
  'deliverable.write.planned',
  // Read-only, and solely so the crew-assignment picker has someone to pick.
  // The PM may attach employees to jobs (`job.assign`) but must not be able to
  // rewrite the payroll-adjacent employee record itself.
  'employee.read',
];

/** Field supervisors are restricted to their assigned jobs and to actuals. */
const SITE_SUPERVISOR_GRANTS: string[] = [
  'job.read.assigned',
  'deliverable.read',
  'deliverable.write.actual',
  'job.transition.execute',
  'job.transition.pack',
];

/** Billing clerks read operations but own everything from pack-ready onward. */
const BILLING_CLERK_GRANTS: string[] = [
  'job.read',
  'deliverable.read',
  'invoice.read',
  'invoice.write',
  'invoice.submit',
  'invoice.approve',
  'invoice.status',
  'job.transition.billing',
  'job.transition.invoice',
];

export const ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  [ROLE_ADMINISTRATOR]: PERMISSION_KEYS,
  [ROLE_COMMERCIAL_QS]: COMMERCIAL_GRANTS,
  [ROLE_PROJECT_MANAGER]: PROJECT_MANAGER_GRANTS,
  [ROLE_SITE_SUPERVISOR]: SITE_SUPERVISOR_GRANTS,
  [ROLE_BILLING_CLERK]: BILLING_CLERK_GRANTS,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Union of the permissions granted by the supplied roles. */
export function effectivePermissions(roleKeys: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const key of roleKeys) {
    for (const perm of ROLE_PERMISSIONS[key] ?? []) out.add(perm);
  }
  return out;
}

export function hasPermission(roleKeys: readonly string[], permission: string): boolean {
  return roleKeys.some((key) => ROLE_PERMISSIONS[key]?.includes(permission));
}

/** True when any of the user's roles is scoped to assigned jobs only. */
export function isScopedToAssignedJobs(roleKeys: readonly string[]): boolean {
  return (
    roleKeys.includes(ROLE_SITE_SUPERVISOR) &&
    !roleKeys.some((k) => ROLE_PERMISSIONS[k]?.includes('job.read'))
  );
}
