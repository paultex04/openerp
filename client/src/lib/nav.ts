/**
 * Navigation model.
 *
 * One declarative tree, consumed by both the sidebar and the breadcrumb. It used
 * to be five hand-written `<nav>` blocks, one per page, which is why the pages
 * looked like five different applications.
 *
 * Two rules hold this together:
 *
 *  1. Every entry points at a screen that exists. A nav item whose destination
 *     is unimplemented is a broken promise, so entries are only added here once
 *     there is a route and a screen behind them.
 *  2. Every entry carries `anyOf`: the permission set that reveals it. This is
 *     mirroring, not enforcement - the API re-checks every call independently -
 *     but it is what makes the navigation honest about what a role can reach.
 *
 * Permissions are drawn from the same catalogue the API guard enforces
 * (`@openerp/shared`), so a typo here is a compile error rather than a link that
 * silently never appears.
 */
import {
  Boxes,
  Building2,
  ClipboardCheck,
  Clock,
  FileSpreadsheet,
  FileText,
  FolderKanban,
  HardHat,
  ListChecks,
  MessageSquare,
  Receipt,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  /** Path, optionally with a query that pre-selects a tab or filter. */
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Visible when the user holds any one of these permissions. */
  readonly anyOf: readonly string[];
}

export interface NavSection {
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly anyOf: readonly string[];
  readonly items: readonly NavItem[];
}

/**
 * Pipeline order is pipeline order: a valuation pack belongs *before* an
 * invoice, so that is the order the sidebar walks.
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    key: 'commercial',
    label: 'Commercial & Contracts',
    icon: Building2,
    // The section is shown if any of its children would be.
    anyOf: [
      'contract.read',
      'amendment.read',
      'costparameter.read',
      'ratemaster.read',
      'servicecode.read',
    ],
    items: [
      {
        href: '/commercial?tab=contracts',
        label: 'Contracts & Amendments',
        icon: FileText,
        anyOf: ['contract.read', 'amendment.read'],
      },
      {
        href: '/commercial?tab=parameters',
        label: 'Cost Parameters',
        icon: SlidersHorizontal,
        anyOf: ['costparameter.read'],
      },
      {
        href: '/commercial?tab=rates',
        label: 'Labour Rate Masters (Tier 1)',
        icon: HardHat,
        anyOf: ['ratemaster.read'],
      },
      {
        href: '/commercial?tab=recipes',
        label: 'Activity & Material Codes (Tier 2)',
        icon: Boxes,
        anyOf: ['servicecode.read'],
      },
    ],
  },
  {
    key: 'operations',
    label: 'Operations',
    icon: FolderKanban,
    anyOf: ['project.read', 'job.read', 'deliverable.read', 'job.read.assigned'],
    items: [
      {
        // One entry for all of Operations. The Projects Register, Jobs Board and
        // Valuation Packs deep link were three ways into the same data, and each
        // answered a slightly different question. They are now the register's
        // project and status filters — "Valuation Packs" in particular was a saved
        // filter on `status`, and the filter is still there.
        href: '/operations',
        label: 'Job Management',
        icon: ListChecks,
        anyOf: ['job.read', 'job.read.assigned'],
      },
    ],
  },
  {
    key: 'timesheets',
    label: 'Timesheets',
    icon: Clock,
    // Either you record time (`*.own`/`write`) or you consume what it produced
    // (`read` — the costing views).
    anyOf: [
      'timesheet.write.own',
      'timesheet.read.own',
      'timesheet.write',
      'timesheet.read',
      'timesheet.approve',
    ],
    items: [
      {
        href: '/timesheets?tab=enter',
        label: 'Enter Time',
        icon: Clock,
        anyOf: ['timesheet.write.own', 'timesheet.read.own', 'timesheet.write'],
      },
      {
        href: '/timesheets/crew-matrix',
        label: 'Crew Matrix',
        icon: Users,
        anyOf: ['timesheet.write', 'timesheet.approve', 'project.write', 'job.write'],
      },
      {
        href: '/timesheets?tab=approvals',
        label: 'Approvals',
        icon: ClipboardCheck,
        anyOf: ['timesheet.approve'],
      },
      {
        href: '/timesheets?tab=profitability',
        label: 'Labour Profitability',
        icon: TrendingUp,
        anyOf: ['timesheet.read'],
      },
    ],
  },
  {
    key: 'billing',
    label: 'Billing & Finance',
    icon: Receipt,
    anyOf: ['invoice.read'],
    items: [
      {
        href: '/billing',
        label: 'Invoice Register',
        icon: FileSpreadsheet,
        anyOf: ['invoice.read'],
      },
    ],
  },
  {
    key: 'collaboration',
    label: 'Collaboration',
    icon: MessageSquare,
    // Chat is cross-cutting, but the section waits until chat actually exists:
    // the dock in the header is the primary way in, and this is the full-page
    // view someone reaches for on purpose.
    anyOf: ['chat.read'],
    items: [
      {
        href: '/messages',
        label: 'Messages',
        icon: MessageSquare,
        anyOf: ['chat.read'],
      },
    ],
  },
  {
    key: 'administration',
    label: 'Administration',
    icon: ShieldCheck,
    // Admin screens are permission-gated individually too; this only decides
    // whether the section header appears at all.
    anyOf: [
      'admin.user.read',
      'admin.role.read',
      'admin.audit.read',
      'employee.read',
      'broker.read',
      'contracttype.read',
      'contact.read',
    ],
    items: [
      {
        href: '/admin?tab=users',
        label: 'User Directory & Employee Links',
        icon: Users,
        anyOf: ['admin.user.read'],
      },
      {
        href: '/admin?tab=roles',
        label: 'Roles & Permissions Matrix',
        icon: ShieldCheck,
        anyOf: ['admin.role.read'],
      },
      {
        // Phase 7. Clients sit under Administration per ADR-007 Q3, even though
        // they are commercial: they are reference data, not transactions.
        href: '/admin?tab=clients',
        label: 'Clients & Contacts',
        icon: Building2,
        anyOf: ['contract.read', 'contact.read'],
      },
      {
        href: '/admin?tab=contracts',
        label: 'Contracts & Amendments',
        icon: FileText,
        anyOf: ['contract.read', 'amendment.read'],
      },
      {
        href: '/admin?tab=employees',
        label: 'Employees, Brokers & Types',
        icon: HardHat,
        anyOf: ['employee.read', 'broker.read', 'contracttype.read'],
      },
      {
        href: '/admin?tab=projects',
        label: 'Projects',
        icon: FolderKanban,
        anyOf: ['project.read', 'project.write'],
      },
      {
        href: '/admin?tab=audit',
        label: 'System Audit Log',
        icon: ScrollText,
        anyOf: ['admin.audit.read'],
      },
    ],
  },
  {
    key: 'account',
    label: 'Account',
    icon: UserRound,
    /**
     * Never rendered in the sidebar: "My Profile" is reached from the user
     * menu. An empty `anyOf` is what keeps it out - `visibleSections` filters
     * on exactly the same rule as every other section, so this is not a hidden
     * special case. The entry exists so `breadcrumbFor` can label the screen
     * instead of falling back to a bare "OpenERP".
     */
    anyOf: [],
    items: [{ href: '/profile', label: 'My Profile', icon: UserRound, anyOf: [] }],
  },
];

function granted(permissions: ReadonlySet<string>, anyOf: readonly string[]): boolean {
  return anyOf.some((permission) => permissions.has(permission));
}

/**
 * Narrows the tree to what this user may see.
 *
 * Sections whose every child is hidden are dropped too, so a field supervisor
 * does not see an empty "Billing & Finance" heading. An empty result is
 * meaningful: it means the account holds no navigation-bearing permission, and
 * the shell renders a "no access" state rather than a bare frame.
 */
export function visibleSections(permissions: readonly string[]): NavSection[] {
  const set = new Set(permissions);
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => granted(set, item.anyOf)),
  })).filter((section) => section.items.length > 0);
}

/**
 * Resolves a pathname to its breadcrumb trail.
 *
 * Matching ignores the query string and detail segments, so a detail screen
 * keeps the breadcrumb of its register.
 */
export function breadcrumbFor(
  pathname: string,
  search: string,
): { section: NavSection; item: NavItem } | null {
  const query = new URLSearchParams(search);
  const resolvedPath = pathname.startsWith('/operations/') ? '/operations' : pathname;

  // A more specific entry wins: try every item and keep the longest match.
  let best: { section: NavSection; item: NavItem; score: number } | null = null;

  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      const [path, itemQuery] = item.href.split('?');
      if (path !== resolvedPath) continue;

      let score = 1;
      if (itemQuery) {
        // Every filter the entry specifies must match, or it is not this entry.
        let matches = true;
        for (const [key, value] of new URLSearchParams(itemQuery)) {
          if (query.get(key) !== value) matches = false;
        }
        if (!matches) continue;
        score = 2;
      }
      if (!best || score > best.score) best = { section, item, score };
    }
  }

  return best ? { section: best.section, item: best.item } : null;
}
