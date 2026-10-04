'use client';

/**
 * Administration: user accounts, the role/permission matrix, and the audit log.
 *
 * Two things this screen refuses to do:
 *
 *  - It does not let an administrator lock themselves out. Deactivating your own
 *    account or dropping your own administrator role are the two mistakes with no
 *    recovery path short of direct SQL, so the buttons are disabled for your own
 *    row and the API refuses them independently.
 *  - It does not present the permission matrix as a single source of truth. Both
 *    the live grants and the catalogue's expectation are shown per role, and a
 *    mismatch is highlighted: adding a permission without re-seeding is a real
 *    failure mode that is otherwise invisible until someone cannot do their job.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useUrlParam } from '@/hooks/use-url-param';
import { UsersPanel } from '@/components/admin/users-panel';
import { AuditPanel } from '@/components/admin/audit-panel';
import { RolesPanel } from '@/components/admin/roles-panel';

type Tab = 'users' | 'roles' | 'audit';

/** Whitelist for the `tab` query parameter. */
const TAB_KEYS: readonly Tab[] = ['users', 'roles', 'audit'];

export default function AdminPage() {
  // URL-backed so each admin screen is deep-linkable from the sidebar and the
  // audit trail can be linked directly at a reviewer.
  const [tab, setTab] = useUrlParam<Tab>('tab', TAB_KEYS, 'users');
  const me = useMe();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Administration</h1>
        <p className="text-sm text-muted-foreground">
          User accounts, role permissions and the audit trail of every change.
        </p>
      </header>

      <nav className="flex gap-1 rounded-md border p-1">
        {(
          [
            ['users', 'Users'],
            ['roles', 'Roles & permissions'],
            ['audit', 'Audit log'],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={tab === key ? 'default' : 'ghost'}
            onClick={() => setTab(key)}
          >
            {label}
          </Button>
        ))}
      </nav>

      {tab === 'users' && <UsersPanel myId={me.data?.user.id} />}
      {tab === 'roles' && <RolesPanel />}
      {tab === 'audit' && <AuditPanel />}
    </div>
  );
}

function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: { id: number; email: string } }>('/api/auth/me'),
  });
}
