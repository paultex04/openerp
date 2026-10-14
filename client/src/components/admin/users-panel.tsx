'use client';

/**
 * User administration: the only screen in the application that manages accounts.
 *
 * The API has always supported create (`POST`), edit (`PATCH`) and deactivate
 * (`DELETE`), all gated on `admin.user.write`. The UI exposed only "Deactivate",
 * so a person with the permission to create an account had no way to do it. This
 * closes that gap and puts the list behind the shared `DataTable`.
 *
 * Hard delete is deliberately absent. `DELETE /api/admin/users/:id` deactivates
 * and revokes sessions rather than removing the row, because an account's audit
 * trail must keep naming an actor. See ADR-005.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Pencil, Plus, UserMinus } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { DataTable, stringFilter } from '@/components/data-table/data-table';
import { api, ApiError } from '@/lib/api';

export interface AdminUser {
  id: number;
  email: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  employee: { id: number; name: string; surname: string };
  roleKeys: string[];
  permissionCount: number;
}

interface RoleOption {
  key: string;
  name: string;
  description: string | null;
}

/** Mirrors the server's policy. The server remains the authority; this only
    avoids a pointless round trip, and its message is still shown verbatim. */
const MIN_PASSWORD_LENGTH = 12;

export function UsersPanel({ myId }: { myId: number | undefined }) {
  const queryClient = useQueryClient();
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState<AdminUser | null>(null);

  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.get<{ users: AdminUser[] }>('/api/admin/users'),
  });

  const roles = useQuery({
    queryKey: ['roles'],
    // The roles catalogue is not privileged: any signed-in user may read it, so
    // the picker can label roles by name rather than showing raw keys.
    queryFn: () => api.get<{ roles: RoleOption[] }>('/api/auth/roles'),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['admin-users'] });

  const deactivate = useMutation({
    mutationFn: (id: number) => api.delete(`/api/admin/users/${id}`),
    onSuccess: () => {
      toast.add({
        title: 'Account deactivated',
        description: 'All of their sessions have been revoked. The audit trail keeps their name.',
        type: 'success',
      });
      setConfirmDeactivate(null);
      refresh();
    },
    onError: (error: Error) =>
      toast.add({
        title: 'Could not deactivate',
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      }),
  });

  const roleOptions = useMemo(
    () => [
      { value: '', label: 'All roles' },
      ...(roles.data?.roles ?? []).map((role) => ({ value: role.key, label: role.name })),
    ],
    [roles.data],
  );

  const columns = useMemo<ColumnDef<any, AdminUser, unknown>[]>(
    () => [
      {
        id: 'email',
        accessorKey: 'email',
        header: 'Email',
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.email}</span>,
      },
      {
        id: 'employee',
        header: 'Employee',
        // Sorts on a derived string so the column is orderable, while the cell
        // still renders the two parts separately.
        accessorFn: (row) => `${row.employee.name} ${row.employee.surname}`,
        cell: ({ row }) => (
          <>
            {row.original.employee.name} {row.original.employee.surname}
          </>
        ),
      },
      {
        id: 'roles',
        header: 'Roles',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="flex flex-wrap gap-1">
            {row.original.roleKeys.map((role) => (
              <Badge key={role} variant="outline">
                {role}
              </Badge>
            ))}
          </span>
        ),
      },
      {
        id: 'permissionCount',
        accessorKey: 'permissionCount',
        header: 'Permissions',
        meta: { align: 'right' },
        cell: ({ row }) => row.original.permissionCount,
      },
      {
        id: 'lastLoginAt',
        accessorKey: 'lastLoginAt',
        header: 'Last login',
        cell: ({ row }) => (
          <span className="text-xs whitespace-nowrap">
            {row.original.lastLoginAt
              ? new Date(row.original.lastLoginAt).toLocaleString('en-ZA')
              : 'Never'}
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant={row.original.isActive ? 'success' : 'secondary'}>
            {row.original.isActive ? 'Active' : 'Disabled'}
          </Badge>
        ),
      },
    ],
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <DataTable<AdminUser>
        caption="System user accounts"
        fill
        data={users.data?.users ?? []}
        columns={columns}
        rowKey={(user) => user.id}
        // `roleKeys` is an array; `pluck` joins it, so "administrator" matches.
        searchKeys={['email', 'employee.name', 'employee.surname', 'roleKeys']}
        searchPlaceholder="Search email, name or role…"
        isLoading={users.isLoading}
        initialSort={[{ id: 'email', desc: false }]}
        emptyMessage="No accounts match the current search and filters."
        filters={[
          stringFilter<AdminUser>(
            'status',
            'Status',
            'isActive',
            [
              { value: '', label: 'Any' },
              { value: 'true', label: 'Active' },
              { value: 'false', label: 'Disabled' },
            ],
            statusFilter,
            setStatusFilter,
          ),
          {
            ...stringFilter<AdminUser>(
              'role',
              'Role',
              'roleKeys',
              roleOptions,
              roleFilter,
              setRoleFilter,
            ),
            // A user may hold several roles, so membership is "includes", not
            // equality. `stringFilter` compares with `===` and would never match.
            predicate: (user, selected) => user.roleKeys.includes(selected),
          },
        ]}
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" className="size-4" />
            New user
          </Button>
        }
        renderRowActions={(user) => (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing(user)}
              aria-label={`Edit ${user.email}`}
            >
              <Pencil aria-hidden="true" className="size-4" />
              Edit
            </Button>
            {user.isActive && (
              <Button
                size="sm"
                variant="ghost"
                // Disabled for your own row, matching the API's 409 refusal.
                disabled={user.id === myId}
                title={
                  user.id === myId
                    ? 'You cannot deactivate your own account.'
                    : 'Deactivate and revoke all sessions.'
                }
                onClick={() => setConfirmDeactivate(user)}
              >
                <UserMinus aria-hidden="true" className="size-4" />
                Deactivate
              </Button>
            )}
          </>
        )}
      />

      {users.isError && (
        <p className="text-sm text-negative">
          {users.error instanceof ApiError ? users.error.message : 'Could not load users.'}
        </p>
      )}

      <UserDialog
        key={creating ? 'create' : editing ? `edit-${editing.id}` : 'closed'}
        open={creating || editing !== null}
        user={editing}
        roles={roles.data?.roles ?? []}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => {
          setCreating(false);
          setEditing(null);
          refresh();
        }}
      />

      {/*
        Destructive confirmation. Deactivation ends every session the person
        holds and cannot be undone from this screen, so it is worth a deliberate
        step - but it is reversible (Activate again), which is why it is a
        Dialog rather than something that requires typing the email.
      */}
      <AlertDialog
        open={confirmDeactivate !== null}
        onOpenChange={(open) => !open && setConfirmDeactivate(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {confirmDeactivate?.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              They are signed out immediately on every device and cannot sign in again until an
              administrator reactivates the account. Their name is kept on everything they already
              did - the account is disabled, not erased.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDeactivate && deactivate.mutate(confirmDeactivate.id)}
              disabled={deactivate.isPending}
            >
              {deactivate.isPending ? 'Deactivating…' : 'Deactivate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Create / edit dialog.
 *
 * Mounted with a changing `key` so React remounts it per user. That discards the
 * draft by construction - the alternative, syncing props into state in an effect,
 * is how a form ends up showing the previous record's values after an edit.
 */
function UserDialog({
  open,
  user,
  roles,
  onClose,
  onSaved,
}: {
  open: boolean;
  user: AdminUser | null;
  roles: RoleOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isCreate = user === null;
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [surname, setSurname] = useState('');
  const [startDate, setStartDate] = useState('');
  const [password, setPassword] = useState('');
  const [roleKeys, setRoleKeys] = useState<string[]>([]);

  // Seeded once on mount from the record being edited.
  const [seeded, setSeeded] = useState(false);
  if (open && !seeded) {
    if (user) {
      setEmail(user.email);
      setName(user.employee.name);
      setSurname(user.employee.surname);
      setRoleKeys(user.roleKeys);
    }
    setSeeded(true);
  }

  const toggleRole = (key: string) =>
    setRoleKeys((current) =>
      current.includes(key) ? current.filter((role) => role !== key) : [...current, key],
    );

  const save = useMutation({
    mutationFn: async () => {
      if (isCreate) {
        return api.post('/api/admin/users', {
          email: email.trim(),
          password,
          roleKeys,
          employee: {
            name: name.trim(),
            surname: surname.trim(),
            startDate: startDate || new Date().toISOString().slice(0, 10),
          },
        });
      }
      return api.patch(`/api/admin/users/${user.id}`, {
        roleKeys,
        // Omitted rather than sent empty: sending `''` would be a password
        // change request to a value the server would reject.
        ...(password ? { password } : {}),
      });
    },
    onSuccess: () => {
      toast.add({
        title: isCreate ? 'User created' : 'User updated',
        description: isCreate
          ? `${email.trim()} can now sign in.`
          : password
            ? 'Password reset. Their existing sessions have been signed out.'
            : 'Roles updated.',
        type: 'success',
      });
      onSaved();
    },
    onError: (error: Error) =>
      toast.add({
        title: isCreate ? 'Could not create user' : 'Could not update user',
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      }),
  });

  const canSubmit = isCreate
    ? email.trim().length > 3 &&
      name.trim().length > 0 &&
      surname.trim().length > 0 &&
      password.length >= MIN_PASSWORD_LENGTH &&
      roleKeys.length > 0
    : roleKeys.length > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isCreate ? 'New user' : `Edit ${user?.email}`}</DialogTitle>
          <DialogDescription>
            {isCreate
              ? 'Creates an account and its linked employee record. At least one role is required.'
              : 'Change roles, or reset the password. Resetting signs the person out everywhere.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4">
          {isCreate && (
            <Field>
              <FieldLabel htmlFor="new-email">Email address</FieldLabel>
              <Input
                id="new-email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@contractor.co.za"
              />
            </Field>
          )}

          {isCreate && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="new-name">First name</FieldLabel>
                <Input
                  id="new-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="new-surname">Surname</FieldLabel>
                <Input
                  id="new-surname"
                  value={surname}
                  onChange={(event) => setSurname(event.target.value)}
                />
              </Field>
            </div>
          )}

          {isCreate && (
            <Field>
              <FieldLabel htmlFor="new-start">Employment start date</FieldLabel>
              {/*
                `max` is today. The server accepts any well-formed date, but an
                account created with a future start date is almost always a typo,
                and the browser's own date picker will not offer a later date.
              */}
              <Input
                id="new-start"
                type="date"
                max={new Date().toISOString().slice(0, 10)}
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
              />
              <FieldDescription>
                Left blank, this is today. The date lands on the employee record, not the login.
              </FieldDescription>
            </Field>
          )}

          <Field>
            <FieldLabel htmlFor="new-password">
              {isCreate ? 'Initial password' : 'Reset password (optional)'}
            </FieldLabel>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <FieldDescription>
              At least {MIN_PASSWORD_LENGTH} characters. Leave blank when editing to keep the
              current password.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Roles</FieldLabel>
            {roles.length === 0 ? (
              <Skeleton className="h-20 w-full" />
            ) : (
              <div className="flex flex-wrap gap-2">
                {roles.map((role) => {
                  const selected = roleKeys.includes(role.key);
                  return (
                    <Button
                      key={role.key}
                      type="button"
                      size="sm"
                      variant={selected ? 'default' : 'outline'}
                      // Toggle buttons rather than checkboxes: there is no
                      // checkbox primitive, and `aria-pressed` is the correct
                      // role for a button that toggles state.
                      aria-pressed={selected}
                      onClick={() => toggleRole(role.key)}
                      title={role.description ?? undefined}
                    >
                      {role.name}
                    </Button>
                  );
                })}
              </div>
            )}
            <FieldDescription>
              Permissions are the union of every selected role. At least one is required.
            </FieldDescription>
          </Field>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!canSubmit || save.isPending}>
            {save.isPending ? 'Saving…' : isCreate ? 'Create user' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
