'use client';

/**
 * Administration: user accounts, the role/permission matrix, the audit log, and
 * every master-data table.
 *
 * Three things this screen refuses to do:
 *
 *  - It does not let an administrator lock themselves out. Deactivating your own
 *    account or dropping your own administrator role are the two mistakes with no
 *    recovery path short of direct SQL, so the buttons are disabled for your own
 *    row and the API refuses them independently.
 *  - It does not present the permission matrix as a single source of truth. Both
 *    the live grants and the catalogue's expectation are shown per role, and a
 *    mismatch is highlighted: adding a permission without re-seeding is a real
 *    failure mode that is otherwise invisible until someone cannot do their job.
 *  - It does not render a tab the viewer has no permission for. Each tab declares
 *    the permission that reveals it, so a project manager deep-linked to
 *    `?tab=clients` gets "you do not have access" rather than a screen of failed
 *    requests. The API refuses independently; this only avoids the pointless
 *    round trip.
 *
 * Phase 7 added the master-data tabs. Clients, contracts and amendments were
 * fully implemented on the server for four releases with no way to reach them
 * from here — see ADR-007.
 */
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useUrlParam } from '@/hooks/use-url-param';
import { usePermissions } from '@/components/auth/usePermissions';
import { UsersPanel } from '@/components/admin/users-panel';
import { AuditPanel } from '@/components/admin/audit-panel';
import { RolesPanel } from '@/components/admin/roles-panel';
import { WorkflowPanel } from '@/components/admin/workflow-panel';
import {
  AmendmentsPanel,
  BrokersPanel,
  ClientsPanel,
  ContactsPanel,
  ContractTypesPanel,
  ContractsPanel,
  EmployeesPanel,
  ProjectsPanel,
} from '@/components/master-data/panels';
import { api } from '@/lib/api';

type Tab =
  | 'users'
  | 'roles'
  | 'workflow'
  | 'clients'
  | 'contacts'
  | 'contracts'
  | 'amendments'
  | 'projects'
  | 'employees'
  | 'brokers'
  | 'contract-types'
  | 'audit';

/** Whitelist for the `tab` query parameter. */
const TAB_KEYS: readonly Tab[] = [
  'users',
  'roles',
  'workflow',
  'clients',
  'contacts',
  'contracts',
  'amendments',
  'projects',
  'employees',
  'brokers',
  'contract-types',
  'audit',
];

interface TabDef {
  key: Tab;
  label: string;
  /** Reveals the tab. Mirrors the permission the API enforces. */
  anyOf: readonly string[];
}

/**
 * Grouped so eleven tabs do not become one unreadable strip. The groups are the
 * three things an administrator actually does: manage access, maintain records,
 * check what happened.
 */
const TAB_GROUPS: ReadonlyArray<{ label: string; tabs: TabDef[] }> = [
  {
    label: 'Access',
    tabs: [
      { key: 'users', label: 'Users', anyOf: ['admin.user.read'] },
      { key: 'roles', label: 'Roles & permissions', anyOf: ['admin.role.read'] },
    ],
  },
  {
    label: 'Records',
    tabs: [
      { key: 'clients', label: 'Clients', anyOf: ['contract.read'] },
      { key: 'contacts', label: 'Contacts', anyOf: ['contact.read'] },
      { key: 'contracts', label: 'Contracts', anyOf: ['contract.read'] },
      { key: 'amendments', label: 'Amendments', anyOf: ['amendment.read'] },
      { key: 'projects', label: 'Projects', anyOf: ['project.read'] },
      { key: 'employees', label: 'Employees', anyOf: ['employee.read'] },
      { key: 'brokers', label: 'Brokers', anyOf: ['broker.read'] },
      { key: 'contract-types', label: 'Contract types', anyOf: ['contracttype.read'] },
      // The job pipeline sits with the other catalogues: it is edited data that
      // the rest of the application reads back.
      { key: 'workflow', label: 'Job workflow', anyOf: ['admin.workflow.read'] },
    ],
  },
  {
    label: 'Audit',
    tabs: [{ key: 'audit', label: 'Audit log', anyOf: ['admin.audit.read'] }],
  },
];

const ALL_TABS: TabDef[] = TAB_GROUPS.flatMap((group) => group.tabs);

export default function AdminPage() {
  // URL-backed so each admin screen is deep-linkable from the sidebar and the
  // audit trail can be linked directly at a reviewer.
  const [tab, setTab] = useUrlParam<Tab>('tab', TAB_KEYS, 'users');
  const { permissions, loading } = usePermissions();
  const me = useMe();

  const allowed = (def: TabDef) => def.anyOf.some((p) => permissions.includes(p));
  const visibleGroups = TAB_GROUPS.map((group) => ({
    ...group,
    tabs: group.tabs.filter(allowed),
  })).filter((group) => group.tabs.length > 0);

  // `useUrlParam` cannot tell "the URL asked for `?tab=clients`" apart from "the
  // URL said nothing, so the fallback applies". Only the first deserves an
  // "access denied"; the second should quietly land on a tab the viewer can use,
  // or a project manager opening /admin would meet a refusal for a screen they
  // never asked for.
  const searchParams = useSearchParams();
  const asked = searchParams.has('tab');
  const requested = ALL_TABS.find((t) => t.key === tab);
  const permitted = requested ? allowed(requested) : true;
  const fallbackTab = visibleGroups[0]?.tabs[0]?.key;
  const activeTab = permitted || asked ? tab : (fallbackTab ?? tab);
  const refuse = asked && !permitted;

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6">
        <p className="py-16 text-center text-sm text-muted-foreground">Loading permissions…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Administration</h1>
        <p className="text-sm text-muted-foreground">
          User accounts, role permissions, the job workflow, every master-data table, and the audit
          trail of every change.
        </p>
      </header>

      <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border p-2">
        {visibleGroups.map((group) => (
          // The group itself wraps: a group with nine tabs cannot fit a narrow
          // window on one line, and without `flex-wrap` here the buttons were
          // clipped at the container's edge - the last two tabs rendered past
          // the border, unreachable. Wrapping inside the group lets a long group
          // spill onto its own lines instead.
          <div key={group.label} className="flex flex-wrap items-center gap-1">
            <span className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {group.label}
            </span>
            {group.tabs.map((def) => (
              <Button
                key={def.key}
                size="sm"
                variant={activeTab === def.key ? 'default' : 'ghost'}
                aria-current={activeTab === def.key ? 'page' : undefined}
                onClick={() => setTab(def.key)}
              >
                {def.label}
              </Button>
            ))}
          </div>
        ))}
      </nav>

      {visibleGroups.length === 0 && (
        <Alert className="border-warning/40 bg-warning/5 text-warning-foreground">
          Your account holds no administration permission. Ask an administrator for the access you
          need.
        </Alert>
      )}

      {refuse ? (
        <Alert className="border-warning/40 bg-warning/5 text-warning-foreground">
          You do not have permission to open “{requested?.label ?? tab}”. It needs{' '}
          <code className="font-mono">{requested?.anyOf.join(' or ')}</code>.
        </Alert>
      ) : (
        <>
          {activeTab === 'users' && <UsersPanel myId={me.data?.user.id} />}
          {activeTab === 'roles' && <RolesPanel />}
          {activeTab === 'workflow' && <WorkflowPanel />}
          {activeTab === 'clients' && <ClientsPanel />}
          {activeTab === 'contacts' && <ContactsPanel />}
          {activeTab === 'contracts' && <ContractsPanel />}
          {activeTab === 'amendments' && <AmendmentsPanel />}
          {activeTab === 'projects' && <ProjectsPanel />}
          {activeTab === 'employees' && <EmployeesPanel />}
          {activeTab === 'brokers' && <BrokersPanel />}
          {activeTab === 'contract-types' && <ContractTypesPanel />}
          {activeTab === 'audit' && <AuditPanel />}
        </>
      )}
    </div>
  );
}

function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: { id: number; email: string } }>('/api/auth/me'),
  });
}
