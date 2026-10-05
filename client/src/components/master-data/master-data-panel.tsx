'use client';

/**
 * Generic create/edit/delete panel for master-data tables.
 *
 * Every master-data entity in OpenERP needs the same four things: a searchable
 * list, a create dialog, an edit dialog and a delete confirmation, all gated on
 * permissions and all reporting through a toast. Eight of them need it. Writing
 * eight near-identical screens is how the application ended up with nine bespoke
 * tables in Phase 6, so this takes a field descriptor list instead and a new
 * entity costs a descriptor plus a route.
 *
 * ## What it deliberately does not do
 *
 * **It does not own its columns.** A `ResourceDef` describes *fields*; the
 * column layout, including composite cells like "Sasol (3 contracts)", is the
 * caller's job via the `columns` render prop. Descriptors describe one field, and
 * a column that spans several is not one field.
 *
 * **It does not hard-delete employees.** `softDeleteNoun` in the descriptor
 * changes the wording to "End employment", because `DELETE /api/employees/:id`
 * sets `endDate` server-side. Saying "delete" there would be a lie.
 *
 * **It does not hide a 409.** Refusals come back from the server with a message
 * naming the blocking count, and that message is shown verbatim. Recreating that
 * count on the client would be a second source of truth that drifts.
 */
import type { ColumnDef } from '@tanstack/react-table';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
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
import { toast } from '@/components/ui/toast';
import { DataTable } from '@/components/data-table/data-table';
import { usePermissions } from '@/components/auth/usePermissions';
import { api, ApiError } from '@/lib/api';
import type { FieldDef, ResourceDef } from '@/lib/master-data';

export interface MasterDataPanelProps<T> {
  resource: ResourceDef<T>;
  /** Row identity. */
  rowKey: (row: T) => number | string;
  /** Builds the table columns from the same descriptors the form uses. */
  columns: (fields: readonly FieldDef<T>[], rows: readonly T[]) => ColumnDef<T, unknown>[];
  /** Shapes the request body. Defaults to the form values verbatim. */
  toPayload?: (values: Record<string, unknown>) => Record<string, unknown>;
  /** Optional select-option sources, keyed by field name. */
  options?: Readonly<Record<string, readonly { value: string; label: string }[]>>;
  /** Extra toolbar content beside the New button. */
  toolbarExtra?: React.ReactNode;
  /** Grows the table to fill the viewport. Off for short panels. */
  fill?: boolean;
}

/** Response shapes differ per resource; extract the array the panel needs. */
function extractRows<T>(body: unknown, resource: ResourceDef<T>): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    // Every list endpoint in the organisation surface returns a plural key that
    // matches the resource's own name, so try those before giving up.
    for (const key of [resource.path.replace(/^\/api\//, ''), resource.plural.toLowerCase()]) {
      const value = record[key];
      if (Array.isArray(value)) return value as T[];
    }
  }
  return [];
}

export function MasterDataPanel<T extends object>({
  resource,
  rowKey,
  columns,
  toPayload,
  options,
  toolbarExtra,
  fill = false,
}: MasterDataPanelProps<T>) {
  const queryClient = useQueryClient();
  const { permissions } = usePermissions();

  const [editing, setEditing] = useState<T | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<T | null>(null);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});

  const list = useQuery({
    queryKey: resource.queryKey,
    queryFn: () => api.get<unknown>(`/api/${resource.path}`),
  });

  const rows = useMemo(() => extractRows<T>(list.data, resource), [list.data, resource]);

  const refresh = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: resource.queryKey }),
    [queryClient, resource.queryKey],
  );

  const remove = useMutation({
    mutationFn: (id: number | string) => api.delete(`/api/${resource.path}/${id}`),
    onSuccess: () => {
      toast.add({
        title: confirmDelete ? `${confirmDeleteTitle(resource, confirmDelete)}` : 'Removed',
        description: resource.softDeleteNoun
          ? 'The record is kept for the audit trail.'
          : undefined,
        type: 'success',
      });
      setConfirmDelete(null);
      refresh();
    },
    onError: (error: Error) =>
      toast.add({
        title: `Could not ${resource.softDeleteNoun ? 'end' : 'delete'} ${resource.singular.toLowerCase()}`,
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      }),
  });

  const canWrite = permissions.includes(resource.writePermission);
  const canDelete = resource.deletePermission
    ? permissions.includes(resource.deletePermission)
    : false;

  // Select options: descriptor-declared, overridden by the `options` prop, which
  // is how a resource points a field at a live list (brokers, contract types).
  const fields = useMemo(() => {
    return resource.fields.map((field) =>
      options?.[field.name]
        ? { ...field, options: options[field.name], kind: 'select' as const }
        : field,
    );
  }, [resource.fields, options]);

  const tableColumns = useMemo(() => columns(fields, rows), [columns, fields, rows]);

  const tableFilters = useMemo(
    () =>
      (resource.filters ?? []).map((filter) => ({
        id: filter.id,
        label: filter.label,
        options: filter.options,
        value: filterValues[filter.id] ?? '',
        onChange: (value: string) => setFilterValues((prev) => ({ ...prev, [filter.id]: value })),
        predicate: filter.predicate,
      })),
    [resource.filters, filterValues],
  );

  const formOpen = creating || editing !== null;
  const closeForm = () => {
    setCreating(false);
    setEditing(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <DataTable
        data={rows}
        columns={tableColumns}
        rowKey={rowKey}
        searchKeys={resource.searchKeys}
        searchPlaceholder={resource.searchPlaceholder}
        filters={tableFilters}
        caption={resource.plural}
        emptyMessage={`No ${resource.plural.toLowerCase()} match the current search and filters.`}
        fill={fill}
        isLoading={list.isLoading}
        actions={
          <>
            {toolbarExtra}
            {canWrite && (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus aria-hidden="true" className="size-4" />
                New {resource.singular.toLowerCase()}
              </Button>
            )}
          </>
        }
        renderRowActions={
          canWrite || canDelete
            ? (row) => (
                <>
                  {canWrite && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(row)}
                      aria-label={`Edit ${rowKey(row)}`}
                    >
                      <Pencil aria-hidden="true" className="size-4" />
                      Edit
                    </Button>
                  )}
                  {canDelete && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmDelete(row)}
                      aria-label={`${resource.softDeleteNoun ? 'End' : 'Delete'} ${rowKey(row)}`}
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                      {resource.softDeleteNoun ? 'End' : 'Delete'}
                    </Button>
                  )}
                </>
              )
            : undefined
        }
      />

      {list.isError && (
        <p className="text-sm text-negative">
          {list.error instanceof ApiError
            ? list.error.message
            : `Could not load ${resource.plural.toLowerCase()}.`}
        </p>
      )}

      <RecordDialog
        key={creating ? 'create' : editing ? `edit-${rowKey(editing)}` : 'closed'}
        open={formOpen}
        fields={fields}
        resource={resource}
        record={editing}
        toPayload={toPayload}
        onClose={closeForm}
        onSaved={() => {
          closeForm();
          refresh();
        }}
      />

      {resource.deletePermission && (
        <AlertDialog
          open={confirmDelete !== null}
          onOpenChange={(open) => !open && setConfirmDelete(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirmDeleteTitle(resource, confirmDelete)}?</AlertDialogTitle>
              <AlertDialogDescription>
                {resource.deleteWarning ??
                  (resource.softDeleteNoun
                    ? 'Their record is kept so past jobs still name the right person. This can be undone by clearing the end date.'
                    : 'This cannot be undone from this screen.')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => confirmDelete && remove.mutate(rowKey(confirmDelete))}
              >
                {resource.softDeleteNoun ? 'End employment' : 'Delete'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

function confirmDeleteTitle<T>(resource: ResourceDef<T>, row: T | null): string {
  const noun = resource.softDeleteNoun ?? 'Delete';
  const label = row && (row as Record<string, unknown>).name;
  const labelText = typeof label === 'string' && label.length > 0 ? ` ${label}` : '';
  return `${noun}${labelText}`;
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

interface RecordDialogProps<T> {
  open: boolean;
  fields: readonly FieldDef<T>[];
  resource: ResourceDef<T>;
  record: T | null;
  toPayload?: (values: Record<string, unknown>) => Record<string, unknown>;
  onClose: () => void;
  onSaved: () => void;
}

function RecordDialog<T>({
  open,
  fields,
  resource,
  record,
  toPayload,
  onClose,
  onSaved,
}: RecordDialogProps<T>) {
  const isCreate = record === null;
  const visible = fields.filter((field) => (isCreate ? !field.editOnly : !field.createOnly));

  /**
   * Seeded from the record being edited.
   *
   * This is a `useState` initialiser rather than an effect, so the panel's `key`
   * (which changes per record) remounts it with the right values and there is no
   * cascading render. The alternative — an effect copying props into state — is
   * what makes a form flash empty for a frame before it fills in.
   *
   * The rule for each field:
   *  - a value the server sent is shown as-is, so the form opens on the real data;
   *  - a nullable field the server sent as null is left blank, which the payload
   *    builder reads back as `null` rather than `''`;
   *  - an absent optional field is left untouched by the payload builder, so
   *    PATCH does not clear a column the route never returns.
   */
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    if (record === null) return {};
    const source = record as Record<string, unknown>;
    const seeded: Record<string, string | boolean> = {};
    for (const field of fields) {
      const value = source[field.name];
      if (value === undefined || value === null) continue;
      seeded[field.name] =
        field.kind === 'boolean'
          ? value === true
          : field.kind === 'date'
            ? String(value)
            : String(value);
    }
    return seeded;
  });
  const [touched, setTouched] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {};
      for (const field of visible) {
        const raw = values[field.name];
        if (raw === undefined) {
          // Undefined means "untouched"; the server treats absent as no change on
          // PATCH and supplies its own default on POST.
          if (field.required && isCreate) payload[field.name] = '';
          continue;
        }
        if (field.kind === 'boolean') {
          payload[field.name] = raw === true || raw === 'true';
        } else if (field.kind === 'number' || field.kind === 'money') {
          const numeric = Number(raw);
          payload[field.name] =
            raw === '' && field.nullable ? null : Number.isFinite(numeric) ? numeric : null;
        } else if (field.nullable) {
          payload[field.name] = raw === '' ? null : raw;
        } else {
          payload[field.name] = raw;
        }
      }
      const body = toPayload ? toPayload(payload) : payload;
      return isCreate
        ? api.post(`/api/${resource.path}`, body)
        : api.patch(`/api/${resource.path}/${recordId(record)}`, body);
    },
    onSuccess: () => {
      toast.add({
        title: isCreate ? `${resource.singular} created` : `${resource.singular} updated`,
        type: 'success',
      });
      onSaved();
    },
    onError: (error: Error) =>
      toast.add({
        title: isCreate
          ? `Could not create ${resource.singular.toLowerCase()}`
          : `Could not update ${resource.singular.toLowerCase()}`,
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      }),
  });

  const missing = visible.filter((field) => {
    if (!field.required) return false;
    const value = values[field.name];
    return value === undefined || value === '' || value === false;
  });

  const canSubmit = missing.length === 0;

  const set = (name: string, value: string | boolean) =>
    setValues((prev) => ({ ...prev, [name]: value }));

  const id = `md-${resource.path}-${isCreate ? 'new' : recordId(record)}`;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isCreate
              ? `New ${resource.singular.toLowerCase()}`
              : `Edit ${resource.singular.toLowerCase()}`}
          </DialogTitle>
          <DialogDescription>
            {isCreate
              ? `Creates a ${resource.singular.toLowerCase()} record.`
              : 'Changes are recorded in the audit log against your name.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          {visible.map((field) => (
            <Field key={field.name} className={field.kind === 'boolean' ? 'sm:col-span-2' : ''}>
              {field.kind === 'boolean' ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    id={`${id}-${field.name}`}
                    type="checkbox"
                    checked={values[field.name] === true}
                    onChange={(event) => set(field.name, event.target.checked)}
                  />
                  {field.label}
                </label>
              ) : (
                <>
                  <FieldLabel htmlFor={`${id}-${field.name}`}>
                    {field.label}
                    {field.required && (
                      <span aria-hidden="true" className="text-negative">
                        {' '}
                        *
                      </span>
                    )}
                  </FieldLabel>
                  {field.kind === 'select' ? (
                    <select
                      id={`${id}-${field.name}`}
                      value={String(values[field.name] ?? '')}
                      onChange={(event) => set(field.name, event.target.value)}
                      className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                    >
                      <option value="">{field.required ? 'Choose…' : 'None'}</option>
                      {(field.options ?? []).map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id={`${id}-${field.name}`}
                      type={
                        field.kind === 'email'
                          ? 'email'
                          : field.kind === 'tel'
                            ? 'tel'
                            : field.kind === 'number' || field.kind === 'money'
                              ? 'number'
                              : field.kind === 'date'
                                ? 'date'
                                : 'text'
                      }
                      step={
                        field.kind === 'money'
                          ? '0.01'
                          : field.kind === 'number'
                            ? 'any'
                            : undefined
                      }
                      placeholder={field.placeholder}
                      value={String(values[field.name] ?? '')}
                      onChange={(event) => set(field.name, event.target.value)}
                    />
                  )}
                </>
              )}
              {field.hint && <FieldDescription>{field.hint}</FieldDescription>}
              {touched && field.required && missing.includes(field) && (
                <FieldDescription className="text-negative">
                  {field.label} is required.
                </FieldDescription>
              )}
            </Field>
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setTouched(true);
              if (canSubmit) save.mutate(undefined);
            }}
            disabled={save.isPending}
          >
            {save.isPending ? 'Saving…' : isCreate ? 'Create' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Every resource's row identity is its `id`; narrowed for the URL builder. */
function recordId<T>(record: T | null): number | string {
  const id = (record as Record<string, unknown> | null)?.id;
  if (typeof id === 'number' || typeof id === 'string') return id;
  throw new Error('Master data record has no id.');
}
