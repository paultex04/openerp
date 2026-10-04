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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface AdminUser {
  id: number;
  email: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  employee: { id: number; name: string; surname: string };
  roleKeys: string[];
  permissionCount: number;
}

interface RoleRow {
  key: string;
  name: string;
  description: string | null;
  granted: string[];
  expected: string[];
}

interface AuditEntry {
  id: string;
  occurredAt: string;
  actorEmail: string | null;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  model: string;
  recordId: string | null;
  summary: string | null;
  changedFields: string[];
  route: string | null;
  method: string | null;
  after: Record<string, unknown> | null;
}

type Tab = 'users' | 'roles' | 'audit';

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('users');

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6">
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

      {tab === 'users' && <UsersPanel />}
      {tab === 'roles' && <RolesPanel />}
      {tab === 'audit' && <AuditPanel />}
    </main>
  );
}

function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: { id: number; email: string } }>('/api/auth/me'),
  });
}

function UsersPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const me = useMe();
  const myId = me.data?.user.id;

  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.get<{ users: AdminUser[] }>('/api/admin/users'),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['admin-users'] });

  const deactivate = useMutation({
    mutationFn: (id: number) => api.delete(`/api/admin/users/${id}`),
    onSuccess: () => {
      toast({ title: 'Account deactivated', variant: 'success' });
      refresh();
    },
    onError: (e: Error) =>
      toast({
        title: 'Could not deactivate',
        description: e instanceof ApiError ? e.message : e.message,
        variant: 'destructive',
      }),
  });

  if (users.isError) {
    return (
      <p className="text-sm text-destructive">
        {users.error instanceof ApiError ? users.error.message : 'Could not load users.'}
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Email</TableHead>
          <TableHead>Employee</TableHead>
          <TableHead>Roles</TableHead>
          <TableHead className="text-right">Permissions</TableHead>
          <TableHead>Last login</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {(users.data?.users ?? []).map((user) => (
          <TableRow key={user.id}>
            <TableCell className="font-mono text-xs">{user.email}</TableCell>
            <TableCell>
              {user.employee.name} {user.employee.surname}
            </TableCell>
            <TableCell>
              <span className="flex flex-wrap gap-1">
                {user.roleKeys.map((role) => (
                  <Badge key={role} variant="outline">
                    {role}
                  </Badge>
                ))}
              </span>
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {user.permissionCount}
            </TableCell>
            <TableCell className="text-xs">
              {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString('en-ZA') : 'Never'}
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-2">
                <Badge variant={user.isActive ? 'success' : 'secondary'}>
                  {user.isActive ? 'Active' : 'Disabled'}
                </Badge>
                {user.isActive && (
                  <Button
                    size="sm"
                    variant="ghost"
                    // Disabled for your own row, matching the API's refusal.
                    disabled={deactivate.isPending || user.id === myId}
                    title={
                      user.id === myId
                        ? 'You cannot deactivate your own account.'
                        : 'Deactivate and revoke all sessions.'
                    }
                    onClick={() => deactivate.mutate(user.id)}
                  >
                    Deactivate
                  </Button>
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RolesPanel() {
  const roles = useQuery({
    queryKey: ['admin-roles'],
    queryFn: () =>
      api.get<{
        permissions: Array<{ key: string; module: string; description: string }>;
        roles: RoleRow[];
      }>('/api/admin/roles'),
  });

  if (roles.isError) {
    return (
      <p className="text-sm text-destructive">
        {roles.error instanceof ApiError ? roles.error.message : 'Could not load roles.'}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {(roles.data?.roles ?? []).map((role) => {
        const missing = role.expected.filter((p) => !role.granted.includes(p));
        const extra = role.granted.filter((p) => !role.expected.includes(p));
        const drifted = missing.length > 0 || extra.length > 0;

        return (
          <section key={role.key} className="space-y-2 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">
                  {role.name}{' '}
                  <span className="font-mono text-xs text-muted-foreground">{role.key}</span>
                </h2>
                {role.description && (
                  <p className="text-xs text-muted-foreground">{role.description}</p>
                )}
              </div>
              <Badge variant="secondary">{role.granted.length} permissions</Badge>
            </div>

            {drifted && (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                The live grants differ from the seeded catalogue
                {missing.length > 0 && `; missing ${missing.join(', ')}`}
                {extra.length > 0 && `; unexpected ${extra.join(', ')}`}. Run &quot;npm run seed
                --workspace server&quot; to resynchronise.
              </p>
            )}

            <div className="flex flex-wrap gap-1">
              {role.granted.map((permission) => (
                <span
                  key={permission}
                  className="rounded border px-1.5 py-0.5 font-mono text-[10px]"
                  title={
                    roles.data?.permissions.find((p) => p.key === permission)?.description ??
                    permission
                  }
                >
                  {permission}
                </span>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function AuditPanel() {
  const [model, setModel] = useState('');
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const models = useQuery({
    queryKey: ['audit-models'],
    queryFn: () => api.get<{ models: string[] }>('/api/admin/audit/models'),
  });

  const summary = useQuery({
    queryKey: ['audit-summary'],
    queryFn: () =>
      api.get<{
        activity: { create: number; update: number; delete: number; total: number };
        auditWriteFailures: number;
      }>('/api/admin/audit/summary'),
  });

  const entries = useQuery({
    queryKey: ['audit', model, action, search],
    queryFn: () =>
      api.get<{ entries: AuditEntry[]; total: number }>(
        `/api/admin/audit?limit=100&${new URLSearchParams({
          ...(model ? { model } : {}),
          ...(action ? { action } : {}),
          ...(search ? { search } : {}),
        })}`,
      ),
  });

  const activity = summary.data?.activity;

  return (
    <div className="space-y-4">
      {activity && (
        <div className="grid gap-3 sm:grid-cols-4">
          <Tile label="Entries" value={activity.total} />
          <Tile label="Created" value={activity.create} />
          <Tile label="Updated" value={activity.update} />
          <Tile label="Deleted" value={activity.delete} />
        </div>
      )}

      {summary.data && summary.data.auditWriteFailures > 0 && (
        <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-900 dark:bg-red-950/30 dark:text-red-100">
          {summary.data.auditWriteFailures} audit write(s) failed. Entries may be missing; see the
          server log.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search summary, record or actor"
          aria-label="Search the audit log"
          className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        />
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          aria-label="Filter by model"
          className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        >
          <option value="">All models</option>
          {(models.data?.models ?? []).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          aria-label="Filter by action"
          className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        >
          <option value="">All actions</option>
          <option value="CREATE">Created</option>
          <option value="UPDATE">Updated</option>
          <option value="DELETE">Deleted</option>
        </select>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Change</TableHead>
            <TableHead>Route</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(entries.data?.entries ?? []).map((entry) => (
            <TableRow key={entry.id}>
              <TableCell className="whitespace-nowrap text-xs">
                {new Date(entry.occurredAt).toLocaleString('en-ZA')}
              </TableCell>
              <TableCell className="text-xs">{entry.actorEmail ?? '—'}</TableCell>
              <TableCell>
                <Badge
                  variant={
                    entry.action === 'CREATE'
                      ? 'success'
                      : entry.action === 'DELETE'
                        ? 'destructive'
                        : 'secondary'
                  }
                >
                  {entry.action}
                </Badge>
              </TableCell>
              <TableCell>
                <button
                  type="button"
                  className="text-left text-xs hover:underline"
                  onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                >
                  {entry.summary ?? `${entry.model} ${entry.recordId ?? ''}`}
                </button>
                {expanded === entry.id && entry.after && (
                  <pre className="mt-1 max-w-md overflow-auto rounded bg-muted p-2 text-[10px]">
                    {JSON.stringify(entry.after, null, 2)}
                  </pre>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap font-mono text-[10px] text-muted-foreground">
                {entry.method ? `${entry.method} ${entry.route}` : '—'}
              </TableCell>
            </TableRow>
          ))}
          {(entries.data?.entries ?? []).length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                No audit entries match this filter.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
