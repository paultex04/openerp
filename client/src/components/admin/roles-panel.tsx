'use client';

/** Editable matrix for the four non-administrator built-in role grants. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/data-table/data-table';
import { toast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';

interface RoleRow {
  key: string;
  name: string;
  description: string | null;
  granted: string[];
  expected: string[];
  locked: boolean;
}

interface PermissionRow {
  key: string;
  module: string;
  description: string;
}

export function RolesPanel() {
  const queryClient = useQueryClient();
  const [moduleFilter, setModuleFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Set<string>>>({});
  const [savingRole, setSavingRole] = useState<string | null>(null);

  const roles = useQuery({
    queryKey: ['admin-roles'],
    queryFn: () => api.get<{ permissions: PermissionRow[]; roles: RoleRow[] }>('/api/admin/roles'),
  });

  const permissionRows = useMemo(() => roles.data?.permissions ?? [], [roles.data]);
  const roleRows = useMemo(() => roles.data?.roles ?? [], [roles.data]);
  const grantsFor = (role: RoleRow) => drafts[role.key] ?? new Set(role.granted);
  const dirty = (role: RoleRow) => {
    const grants = grantsFor(role);
    return grants.size !== role.granted.length || role.granted.some((key) => !grants.has(key));
  };

  const save = useMutation({
    mutationFn: ({ roleKey, permissionKeys }: { roleKey: string; permissionKeys: string[] }) =>
      api.put(`/api/admin/roles/${encodeURIComponent(roleKey)}/permissions`, { permissionKeys }),
    onMutate: ({ roleKey }) => setSavingRole(roleKey),
    onSuccess: async (_result, { roleKey }) => {
      setDrafts((current) => {
        const next = { ...current };
        delete next[roleKey];
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ['admin-roles'] });
      await queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      toast.add({
        title: 'Role permissions saved',
        description: 'The updated grants are active immediately.',
        type: 'success',
      });
    },
    onError: (error: Error) =>
      toast.add({
        title: 'Could not save role permissions',
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      }),
    onSettled: () => setSavingRole(null),
  });

  type MatrixRow = PermissionRow & { grantedBy: Set<string> };
  const data = useMemo(
    () =>
      permissionRows.map((permission) => ({
        ...permission,
        grantedBy: new Set(
          roleRows.filter((role) => grantsFor(role).has(permission.key)).map((role) => role.key),
        ),
      })),
    [permissionRows, roleRows, drafts],
  );

  const columns = useMemo<ColumnDef<any, MatrixRow, unknown>[]>(() => {
    const roleColumn = (role: RoleRow) =>
      ({
        id: `role-${role.key}`,
        header: role.name,
        enableSorting: false,
        cell: ({ row }: { row: { original: MatrixRow } }) => {
          const granted = grantsFor(role).has(row.original.key);
          return (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={granted}
                disabled={role.locked || save.isPending}
                aria-label={`${granted ? 'Revoke' : 'Grant'} ${row.original.key} for ${role.name}`}
                onChange={(event) => {
                  setDrafts((current) => {
                    const next = new Set(current[role.key] ?? role.granted);
                    if (event.target.checked) next.add(row.original.key);
                    else next.delete(row.original.key);
                    return { ...current, [role.key]: next };
                  });
                }}
                className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
              <span className="sr-only">{granted ? 'Granted' : 'Not granted'}</span>
            </label>
          );
        },
      }) as ColumnDef<any, MatrixRow, unknown>;

    return [
      {
        id: 'key',
        accessorKey: 'key',
        header: 'Permission',
        cell: ({ row }) => <span className="font-mono text-[11px]">{row.original.key}</span>,
      },
      {
        id: 'description',
        accessorKey: 'description',
        header: 'Description',
        cell: ({ row }) => <span className="text-xs">{row.original.description}</span>,
      },
      {
        id: 'grantedByCount',
        header: 'Roles',
        accessorFn: (row) => row.grantedBy.size,
        meta: { align: 'right' },
        cell: ({ row }) => row.original.grantedBy.size,
      },
      ...roleRows.map(roleColumn),
    ];
  }, [roleRows, drafts, save.isPending]);

  const moduleOptions = useMemo(
    () => [
      { value: '', label: 'All modules' },
      ...[...new Set(permissionRows.map((permission) => permission.module))]
        .sort()
        .map((module) => ({ value: module, label: module })),
    ],
    [permissionRows],
  );

  if (roles.isError) {
    return (
      <p className="text-sm text-negative">
        {roles.error instanceof ApiError ? roles.error.message : 'Could not load roles.'}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Toggle permissions for the four built-in non-administrator roles, then save each role.
        Changes apply immediately. The administrator role is locked and always holds every catalogue
        permission. Site supervisors remain scoped to assigned jobs unless another granted role
        provides general job access. Which roles a person holds is set in the Users tab.
      </p>

      {roleRows
        .filter((role) => !role.locked && dirty(role))
        .map((role) => (
          <div
            key={role.key}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-3"
          >
            <div className="text-sm">
              <strong>{role.name}</strong>
              <span className="ml-2 text-muted-foreground">Unsaved permission changes</span>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={save.isPending}
                onClick={() =>
                  setDrafts((current) => {
                    const next = { ...current };
                    delete next[role.key];
                    return next;
                  })
                }
              >
                Reset
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={save.isPending}
                onClick={() =>
                  save.mutate({ roleKey: role.key, permissionKeys: [...grantsFor(role)].sort() })
                }
              >
                {savingRole === role.key ? 'Saving…' : `Save ${role.name}`}
              </Button>
            </div>
          </div>
        ))}

      <DataTable
        caption="Permission matrix by role"
        data={data}
        columns={columns}
        rowKey={(row) => row.key}
        searchKeys={['key', 'description', 'module']}
        searchPlaceholder="Search permission or description…"
        isLoading={roles.isLoading}
        initialSort={[{ id: 'key', desc: false }]}
        pageSize={50}
        emptyMessage="No permissions match the current search."
        filters={[
          {
            id: 'module',
            label: 'Module',
            value: moduleFilter,
            options: moduleOptions,
            onChange: setModuleFilter,
            predicate: (row, selected) => row.module === selected,
          },
          {
            id: 'granted',
            label: 'Held by',
            value: roleFilter,
            options: [
              { value: '', label: 'Any role' },
              ...roleRows.map((role) => ({ value: role.key, label: role.name })),
            ],
            onChange: setRoleFilter,
            predicate: (row, selected) => row.grantedBy.has(selected),
          },
        ]}
      />
    </div>
  );
}
