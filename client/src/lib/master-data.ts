/**
 * Permission-gated form fields for the generic master-data panel.
 *
 * A "master data" record in OpenERP is a row in one of the eight tables below.
 * Every one of them needs the same four things - a list, a create dialog, an edit
 * dialog and a delete confirmation - so they share `MasterDataPanel` rather than
 * each getting a bespoke screen. That is the same reasoning as the shared
 * `DataTable`, which replaced nine bespoke tables in Phase 6.
 *
 * A field descriptor declares how to render a column, how to render the matching
 * input, and whether the input is required. Everything else - permission gating,
 * toast feedback, refetch after write, the 409 message - is the panel's job.
 *
 * ## Two deliberate omissions
 *
 * **Numeric and money columns are not sortable through `DataTable`'s string
 * comparison.** `Employee.rate` is a Decimal serialised as a number, and the
 * table's `NumericCell` already handles right-alignment. See `data-table.tsx`.
 *
 * **Employee delete deactivates rather than deletes.** The panel's `deletePath`
 * points at `DELETE /api/employees/:id`, which sets `endDate` server-side, so the
 * confirmation copy says "End employment" rather than "Delete". Getting this wrong
 * in the UI would tell the user their record is being destroyed when it is not.
 */
import type { ReactNode } from 'react';

export type FieldKind =
  'text' | 'email' | 'tel' | 'number' | 'date' | 'money' | 'boolean' | 'select';

export interface Option {
  value: string;
  label: string;
}

export interface FieldDef<T> {
  /** Key on the record. Also the form field name. */
  name: keyof T & string;
  label: string;
  kind: FieldKind;
  /** Rendered in the table cell. */
  render?: (row: T) => ReactNode;
  /** Rendered under the input in the dialog. */
  hint?: string;
  required?: boolean;
  /** `placeholder` for text-ish inputs. */
  placeholder?: string;
  /** Options for `select`. Resolved from a query by the panel. */
  options?: readonly Option[];
  /** Inputs the server treats as null when empty. Checkboxes are not affected. */
  nullable?: boolean;
  /** Column header override. */
  header?: string;
  /** Excluded from the create dialog when the server fills it (e.g. ids). */
  createOnly?: boolean;
  /** Excluded from the edit dialog. */
  editOnly?: boolean;
}

/** A panel's route + columns + fields + permission keys. */
export interface ResourceDef<T> {
  /** Singular, for buttons and dialog titles: "Employee". */
  singular: string;
  /** Plural, for captions: "Employees". */
  plural: string;
  /** Query key. Must be stable and unique per resource. */
  queryKey: readonly string[];
  /** Path segment: `/api/employees` -> `'employees'`. */
  path: string;
  /** Permission required to POST. */
  writePermission: string;
  /** Permission required to DELETE, if the resource is deletable at all. */
  deletePermission?: string;
  searchKeys: readonly string[];
  searchPlaceholder: string;
  fields: readonly FieldDef<T>[];
  /** Extra categorical filters, e.g. active/inactive. */
  filters?: readonly {
    id: string;
    label: string;
    options: readonly Option[];
    /** Value written back into the filter state. */
    predicate: (row: T, value: string) => boolean;
  }[];
  /**
   * Set when the DELETE verb does not destroy the row. The confirmation and the
   * success toast both use this instead of "delete".
   */
  softDeleteNoun?: string;
  /** Explains why a row cannot be deleted, shown in the confirmation dialog. */
  deleteWarning?: string;
  /**
   * The list endpoint accepts `?includeArchived=`, so the panel can offer a
   * "Show archived" control. Required for archive to be discoverable at all: with
   * it, an archived row is out of the default list and needs a deliberate action to
   * see.
   */
  supportsArchive?: boolean;
  /**
   * Sets `isArchived` on the row via `POST /api/<archivePath>/:id/archive`. Omit
   * on a resource that cannot be archived.
   *
   * Deliberately NOT the same verb as delete. Delete removes a row that nothing
   * references; archive retires one that something does, reversibly. Giving both
   * the same button is what made "cannot delete" feel like a dead end.
   */
  archivePath?: string;
  /** Permission required to archive or restore. Separate from write and delete. */
  archivePermission?: string;
  /**
   * What archiving means for this entity, shown in the confirmation. Written per
   * resource on purpose: "archive this contract" and "archive this broker" are
   * different promises, and one generic string would promise the same for both.
   */
  archiveWarning?: string;
}
