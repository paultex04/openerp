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
import { Archive, ArchiveRestore, Pencil, Plus, Trash2 } from 'lucide-react';
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
import { toast } from '@/components/ui/toast';
import { DataTable } from '@/components/data-table/data-table';
import { usePermissions } from '@/components/auth/usePermissions';
import { api, ApiError } from '@/lib/api';
import type { FieldDef, Option, ResourceDef } from '@/lib/master-data';

export interface MasterDataPanelProps<T extends object> {
  resource: ResourceDef<T>;
  /** Row identity. */
  rowKey: (row: T) => number | string;
  /**
   * Builds the table columns from the same descriptors the form uses.
   *
   * The feature set is erased to `any`: `DataTable` is generic over the row type
   * only, so the panels never name a feature set and neither does this signature.
   */
  columns: (fields: readonly FieldDef<T>[], rows: readonly T[]) => ColumnDef<any, T, unknown>[];
  /** Shapes the request body. Defaults to the form values verbatim. */
  toPayload?: (values: Record<string, unknown>) => Record<string, unknown>;
  /** Optional select-option sources, keyed by field name. */
  options?: Readonly<Record<string, readonly Option[]>>;
  /**
   * Resolves a field's options from the form's current values.
   *
   * This exists because several forms have a *dependent* picker: a job's
   * amendment must come from the chosen project, and a project's amendment from
   * the chosen contract. A static `options` map cannot express that, so the first
   * draft shipped an amendment dropdown listing every amendment in the system,
   * which was wrong rather than merely ugly — the server would reject a
   * mismatched pair, so the user could pick something and be refused.
   *
   * Returning `undefined` falls back to the static map, so a resource only pays
   * for this where it needs it.
   */
  optionsFor?: (
    fieldName: string,
    values: Record<string, string | boolean>,
  ) => Option[] | undefined;
  /**
   * Extra buttons in the trailing actions column, rendered before Edit/Delete.
   * Used where a row has a destination as well as an edit form — a job opens its
   * detail view, which is not an edit.
   */
  renderExtraRowActions?: (row: T) => React.ReactNode;
  /**
   * Seeds the categorical filters on first render.
   *
   * No caller left. It existed for the Jobs Board's `?status=` deep link, which came
   * from the sidebar's "Valuation Packs" entry. Both are gone now: Job Management
   * owns its own status filter, and a deep link would have to drive that component
   * rather than this one.
   *
   * Kept rather than deleted because it is the one way to pre-fill a register from
   * the URL without the parent owning the filter value - which the user cannot then
   * clear. If a deep link is ever needed again, that trade has to be made
   * deliberately.
   */
  initialFilters?: Readonly<Record<string, string>>;
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
  optionsFor,
  renderExtraRowActions,
  initialFilters,
  toolbarExtra,
  fill = false,
}: MasterDataPanelProps<T>) {
  const queryClient = useQueryClient();
  const { permissions } = usePermissions();

  const [editing, setEditing] = useState<T | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<T | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<T | null>(null);
  const [filterValues, setFilterValues] = useState<Record<string, string>>(() => ({
    ...(initialFilters ?? {}),
  }));
  // Archived rows are hidden by the server by default. This is a deliberate opt-in
  // rather than a client-side filter, because the server is also what makes the
  // *pickers* exclude them - a picker that filtered client-side would still offer a
  // dead contract to someone who had not ticked the box.
  const [showArchived, setShowArchived] = useState(false);

  const list = useQuery({
    queryKey: [...resource.queryKey, { archived: showArchived }],
    queryFn: () =>
      api.get<unknown>(
        resource.supportsArchive && showArchived
          ? `/api/${resource.path}?includeArchived=true`
          : `/api/${resource.path}`,
      ),
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
  const canArchive = resource.archivePermission
    ? permissions.includes(resource.archivePermission)
    : false;

  /**
   * Archive or restore one row.
   *
   * `POST` archives and `DELETE` restores on the same path. That reads oddly, and
   * it is deliberate: `DELETE /archive` removes the row *from the archived set*,
   * which is what the user is asking for.
   */
  const setArchived = useMutation({
    mutationFn: (input: { id: number | string; archived: boolean }) =>
      input.archived
        ? api.post(`/api/${resource.archivePath}/${input.id}/archive`)
        : api.delete(`/api/${resource.archivePath}/${input.id}/archive`),
    onSuccess: (_result, variables) => {
      toast.add({
        title: variables.archived
          ? `${resource.singular} archived`
          : `${resource.singular} restored`,
        description: variables.archived
          ? 'It is hidden from pickers and can be restored at any time.'
          : 'It is selectable again.',
        type: 'success',
      });
      refresh();
    },
    onError: (error: Error) =>
      toast.add({
        title: 'Could not change archive state',
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      }),
  });

  // Static select options: descriptor-declared, overridden by the `options` prop,
  // which is how a resource points a field at a live list (brokers, contract
  // types). Dependent options are resolved inside the dialog, which is the only
  // place the form's current values exist.
  const fields = useMemo(() => {
    return resource.fields.map((field) =>
      options?.[field.name]
        ? { ...field, options: options[field.name], kind: 'select' as const }
        : field,
    );
  }, [resource.fields, options]);

  const tableColumns = useMemo(() => {
    const built = columns(fields, rows);
    // A resource that supports archiving gets a State column without having to ask.
    // The panel already knows `supportsArchive`, so a new archivable entity gets the
    // marker for free rather than remembering to add it - and forgetting is exactly
    // how an archived row ends up looking identical to a live one.
    if (!resource.supportsArchive) return built;
    return [
      ...built,
      {
        header: 'State',
        cell: ({ row }: { row: { original: T } }) =>
          isArchivedRow(row.original) ? (
            <ArchivedPill />
          ) : (
            <span className="text-muted-foreground">Live</span>
          ),
        enableSorting: false,
      } as unknown as ColumnDef<any, T, unknown>,
    ];
  }, [columns, fields, rows, resource.supportsArchive]);

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
            {resource.supportsArchive && (
              <Button
                size="sm"
                variant={showArchived ? 'default' : 'outline'}
                onClick={() => setShowArchived((v) => !v)}
                aria-pressed={showArchived}
                title={
                  showArchived ? 'Showing archived records too' : 'Archived records are hidden'
                }
              >
                {showArchived ? (
                  <ArchiveRestore aria-hidden="true" className="size-4" />
                ) : (
                  <Archive aria-hidden="true" className="size-4" />
                )}
                {showArchived ? 'Hide archived' : 'Show archived'}
              </Button>
            )}
            {canWrite && (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus aria-hidden="true" className="size-4" />
                New {resource.singular.toLowerCase()}
              </Button>
            )}
          </>
        }
        renderRowActions={
          canWrite || canDelete || renderExtraRowActions
            ? (row) => (
                <>
                  {renderExtraRowActions?.(row)}
                  {canArchive && resource.archivePath && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmArchive(row)}
                      aria-label={`${isArchivedRow(row) ? 'Restore' : 'Archive'} ${resource.singular.toLowerCase()} ${rowKey(row)}`}
                    >
                      {isArchivedRow(row) ? (
                        <ArchiveRestore aria-hidden="true" className="size-4" />
                      ) : (
                        <Archive aria-hidden="true" className="size-4" />
                      )}
                      {isArchivedRow(row) ? 'Restore' : 'Archive'}
                    </Button>
                  )}
                  {canWrite && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(row)}
                      aria-label={`Edit ${resource.singular.toLowerCase()} ${rowKey(row)}`}
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
        optionsFor={optionsFor}
        onClose={closeForm}
        onSaved={() => {
          closeForm();
          refresh();
        }}
      />

      {/*
        Archiving is reversible and does not touch anything that references the
        row, so it gets a plain confirmation rather than an `AlertDialog` - the
        destructive-looking treatment is reserved for the delete above it. The copy
        is per-resource because the promise differs: archiving a client does not
        archive its contracts, and a generic string would imply it might.
      */}
      {canArchive && resource.archivePath && (
        <AlertDialog
          open={confirmArchive !== null}
          onOpenChange={(open) => !open && setConfirmArchive(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {isArchivedRow(confirmArchive)
                  ? `Restore ${confirmDeleteTitle(resource, confirmArchive).replace(/^Delete\s*/, '')}?`
                  : `Archive ${confirmDeleteTitle(resource, confirmArchive).replace(/^Delete\s*/, '')}?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {isArchivedRow(confirmArchive)
                  ? 'It becomes selectable in every picker again.'
                  : (resource.archiveWarning ??
                    'It is hidden from pickers and can be restored at any time.')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  confirmArchive &&
                  setArchived.mutate({
                    id: rowKey(confirmArchive),
                    archived: !isArchivedRow(confirmArchive),
                  })
                }
              >
                {isArchivedRow(confirmArchive) ? 'Restore' : 'Archive'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

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

/**
 * The delete confirmation's subject line.
 *
 * Looks for a `name` first, then the other fields that actually identify a row in
 * practice. Without this a job's confirmation read literally "Delete?", which
 * names nothing - a job has no `name` column, only a description, and a client has
 * a name but a project has a `code`.
 */
function confirmDeleteTitle<T>(resource: ResourceDef<T>, row: T | null): string {
  const noun = resource.softDeleteNoun ?? 'Delete';
  if (!row) return noun;
  const record = row as Record<string, unknown>;

  for (const key of ['name', 'fullName', 'number', 'code', 'amendmentNumber', 'description']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      const trimmed = value.trim();
      // A long description is worse than none in a title bar: truncate it.
      const shown = trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed;
      return `${noun} ${shown}`;
    }
  }
  return `${noun} #${String(record.id ?? '')}`;
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
  optionsFor?: (
    fieldName: string,
    values: Record<string, string | boolean>,
  ) => Option[] | undefined;
  onClose: () => void;
  onSaved: () => void;
}

function RecordDialog<T>({
  open,
  fields,
  resource,
  record,
  toPayload,
  optionsFor,
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
        } else if (raw === '') {
          // A blank field that is optional *and* not nullable is omitted rather than
          // sent as `null` or `''`.
          //
          // This matters for the project's amendment. The field's hint promises the
          // server picks the contract's active amendment when it is left blank, and
          // the server does exactly that - but only when the key is *absent*. It
          // distinguishes absent from null on purpose: absent means "decide for me".
          // Sending `null` said "no amendment", which the column cannot hold, so the
          // hint described behaviour the form's own serialisation prevented.
          //
          // On PATCH, omitting a field is also correct: it means "leave unchanged",
          // which is what a blank box in an edit dialog should do.
          continue;
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
                    <DependentSelect
                      id={`${id}-${field.name}`}
                      name={field.name}
                      required={field.required}
                      placeholder={field.placeholder}
                      value={String(values[field.name] ?? '')}
                      fallbackOptions={field.options ?? []}
                      optionsFor={optionsFor}
                      values={values}
                      onChange={(next) => set(field.name, next)}
                    />
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

/**
 * A `<select>` whose option list can depend on the rest of the form.
 *
 * Two behaviours matter here and both were wrong before this existed:
 *
 *  - **Options narrow with the form.** Resolved from the current values on every
 *    render, so choosing a contract immediately narrows the amendment list to
 *    that contract's amendments.
 *  - **A value that is no longer valid is cleared, not silently kept.** If the
 *    user picks a contract *after* an amendment, and that amendment does not
 *    belong to the new contract, keeping it would submit a pair the server
 *    rejects. Clearing it leaves an honest empty picker instead.
 *
 * Clearing during render is the React-sanctioned way to derive state from props:
 * React discards the render output and re-runs immediately, so no paint shows
 * the stale value.
 */
function DependentSelect({
  id,
  name,
  required,
  placeholder,
  value,
  fallbackOptions,
  optionsFor,
  values,
  onChange,
}: {
  id: string;
  name: string;
  required?: boolean;
  placeholder?: string;
  value: string;
  fallbackOptions: readonly Option[];
  optionsFor?: (
    fieldName: string,
    values: Record<string, string | boolean>,
  ) => Option[] | undefined;
  values: Record<string, string | boolean>;
  onChange: (next: string) => void;
}) {
  const resolved = optionsFor?.(name, values) ?? [...fallbackOptions];

  const stale = value !== '' && !resolved.some((option) => option.value === value);
  if (stale && optionsFor) onChange('');

  // A dependent picker with nothing to offer says why, rather than reading as an
  // empty box. "None" implies the parent has no children, which is usually the
  // opposite of the truth - the parent simply has not been chosen yet.
  const emptyLabel =
    placeholder ??
    (optionsFor && resolved.length === 0
      ? 'Choose the parent first'
      : required
        ? 'Choose…'
        : 'None');

  return (
    <>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
      >
        <option value="">{emptyLabel}</option>
        {resolved.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {stale && (
        <p className="text-xs text-muted-foreground">
          Cleared, because it is not valid for the other selection on this form.
        </p>
      )}
    </>
  );
}

/** Every resource's row identity is its `id`; narrowed for the URL builder. */
function recordId<T>(record: T | null): number | string {
  const id = (record as Record<string, unknown> | null)?.id;
  if (typeof id === 'number' || typeof id === 'string') return id;
  throw new Error('Master data record has no id.');
}

/**
 * True when a row is archived.
 *
 * Null-tolerant on purpose. The archive confirmation asks this question about
 * `confirmArchive` while it is still `null`, because the dialog renders its title
 * and copy before anyone has opened it — so this predicate runs on every render
 * with no row. Casting the argument to `T` silenced the compiler and left the
 * runtime dereferencing null, which is how eight administration screens started
 * throwing on open. A predicate over "maybe a row" has to accept maybe.
 */
function isArchivedRow(row: unknown): boolean {
  return (row as Record<string, unknown> | null)?.isArchived === true;
}

/**
 * The archived marker.
 *
 * Its own component rather than inline JSX, because it appears in two places - the
 * auto State column and the archive confirmation - and the wording is the safety
 * mechanism, not decoration: if a contract is missing from a picker, the register
 * has to say *archived* rather than quietly omit it.
 */
function ArchivedPill() {
  return (
    <Badge variant="secondary" className="text-[10px]">
      Archived
    </Badge>
  );
}
