'use client';

/**
 * Roles and permissions matrix.
 *
 * Reframed as one row per permission with a column per role. It was previously a
 * card per role listing its grants as chips, which answered "what can this role
 * do?" but not the question an administrator actually has when granting: "who
 * can do this one thing?" That question needs a row, and a row needs search.
 *
 * The drift warning is kept. A live grant that differs from the seeded catalogue
 * is a genuine operational problem - usually a migration that added a permission
 * and was never re-seeded - so it is surfaced per role rather than buried.
 *
 * Read-only by design: grants come from the code-level catalogue in
 * `@openerp/shared` and are resynchronised by re-running the seed, not edited
 * here. Per-user role assignment lives in the Users tab, where it belongs - it is
 * a property of a person, not of a role.
 */
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/data-table/data-table';
import { api, ApiError } from '@/lib/api';

interface RoleRow {
  key: string;
  name: string;
  description: string | null;
  granted: string[];
  expected: string[];
}

interface PermissionRow {
  key: string;
  module: string;
  description: string;
}

export function RolesPanel() {
  const [moduleFilter, setModuleFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');

  const roles = useQuery({
    queryKey: ['admin-roles'],
    queryFn: () =>
      api.get<{
        permissions: PermissionRow[];
        roles: RoleRow[];
      }>('/api/admin/roles'),
  });

  // `?? []` inline would allocate a new array every render, so every memo
  // downstream of it would recompute on every keystroke in the search box.
  const permissionRows = useMemo(() => roles.data?.permissions ?? [], [roles.data]);
  const roleRows = useMemo(() => roles.data?.roles ?? [], [roles.data]);

  // One row per permission; `granted` is a lookup so a cell is O(1) rather than
  // scanning the role's array for every cell of every row.
  const data = useMemo(
    () =>
      permissionRows.map((permission) => ({
        ...permission,
        grantedBy: new Set(
          roleRows.filter((role) => role.granted.includes(permission.key)).map((role) => role.key),
        ),
      })),
    [permissionRows, roleRows],
  );

  type MatrixRow = (typeof data)[number];

  const columns = useMemo<ColumnDef<MatrixRow, unknown>[]>(() => {
    const roleColumn = (role: RoleRow) =>
      ({
        id: `role-${role.key}`,
        header: role.name,
        enableSorting: false,
        cell: ({ row }: { row: { original: MatrixRow } }) =>
          row.original.grantedBy.has(role.key) ? (
            <Badge variant="success">Granted</Badge>
          ) : (
            <span className="text-muted-foreground" title="Not granted">
              —
            </span>
          ),
      }) as ColumnDef<MatrixRow, unknown>;

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
        // Sortable by breadth, which is the fastest way to spot a permission that
        // almost nobody has - usually a mistake.
        accessorFn: (row) => row.grantedBy.size,
        meta: { align: 'right' },
        cell: ({ row }) => row.original.grantedBy.size,
      },
      ...roleRows.map(roleColumn),
    ];
  }, [roleRows]);

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
      {roleRows
        .map((role) => {
          const missing = role.expected.filter((p) => !role.granted.includes(p));
          const extra = role.granted.filter((p) => !role.expected.includes(p));
          return { role, missing, extra };
        })
        .filter(({ missing, extra }) => missing.length > 0 || extra.length > 0)
        .map(({ role, missing, extra }) => (
          <p
            key={role.key}
            className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning"
          >
            <strong>{role.name}</strong>: live grants differ from the seeded catalogue
            {missing.length > 0 && `; missing ${missing.join(', ')}`}
            {extra.length > 0 && `; unexpected ${extra.join(', ')}`}. Run{' '}
            <code>npm run seed --workspace server</code> to resynchronise.
          </p>
        ))}

      <p className="text-xs text-muted-foreground">
        Read-only. Grants come from the code-level catalogue and are resynchronised by re-running
        the seed; which roles a <em>person</em> holds is set in the Users tab.
      </p>

      <DataTable
        caption="Permission matrix by role"
        fill
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
