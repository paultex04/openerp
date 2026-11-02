/**
 * Declarative route rules for module-level authorization.
 *
 * Each entry defines the pathname prefix, friendly name, and permissions
 * required to view the module. Used by `RouteGuard` to proactively prevent
 * unauthorized views before page content mounts.
 */

export interface RouteRule {
  readonly prefix: string;
  readonly name: string;
  readonly anyOf: readonly string[];
  readonly requiredRoles?: readonly string[];
}

export const ROUTE_RULES: readonly RouteRule[] = [
  {
    prefix: '/admin',
    name: 'Administration',
    anyOf: [
      'admin.user.read',
      'admin.role.read',
      'admin.audit.read',
      'employee.read',
      'broker.read',
      'contracttype.read',
      'contact.read',
    ],
    requiredRoles: ['Administrator'],
  },
  {
    prefix: '/commercial',
    name: 'Commercial & Contracts',
    anyOf: [
      'contract.read',
      'amendment.read',
      'costparameter.read',
      'ratemaster.read',
      'servicecode.read',
    ],
    requiredRoles: ['Administrator', 'Commercial / QS'],
  },
  {
    prefix: '/billing',
    name: 'Billing & Finance',
    anyOf: ['invoice.read'],
    requiredRoles: ['Administrator', 'Commercial / QS', 'Billing Clerk'],
  },
  {
    prefix: '/timesheets/crew-matrix',
    name: 'Crew Timesheet Matrix',
    anyOf: ['timesheet.write', 'timesheet.approve', 'project.write', 'job.write'],
    requiredRoles: ['Administrator', 'Project Manager', 'Site Supervisor'],
  },
  {
    prefix: '/timesheets',
    name: 'Timesheets',
    anyOf: [
      'timesheet.write.own',
      'timesheet.read.own',
      'timesheet.write',
      'timesheet.read',
      'timesheet.approve',
    ],
  },
  {
    prefix: '/operations',
    name: 'Job Operations',
    anyOf: ['project.read', 'job.read', 'deliverable.read', 'job.read.assigned'],
    requiredRoles: ['Administrator', 'Project Manager', 'Director'],
  },
  {
    prefix: '/tasks',
    name: 'Tasks',
    anyOf: ['task.read'],
  },
  {
    prefix: '/messages',
    name: 'Messages',
    anyOf: ['chat.read'],
  },
];

/**
 * Matches a pathname to the most specific matching rule (longest prefix).
 */
export function findMatchingRouteRule(pathname: string): RouteRule | null {
  const matches = ROUTE_RULES.filter((rule) => {
    if (pathname === rule.prefix) return true;
    if (pathname.startsWith(`${rule.prefix}/`)) return true;
    return false;
  });

  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.prefix.length - a.prefix.length)[0] ?? null;
}
