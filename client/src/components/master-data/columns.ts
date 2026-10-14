import type { ColumnDef } from '@tanstack/react-table';
import type { ReactNode } from 'react';

/**
 * Shared helpers for dependent select fields in the master-data panels.
 *
 * Both of these exist because of a real defect rather than as conveniences, and both
 * were originally local to the jobs panel, which has since moved to
 * `components/job-management`. The projects panel needs the same behaviour, so the
 * logic lives here rather than being copied and drifting.
 */

/** The minimum amendment shape these helpers need. */
export interface AmendmentOption {
  id: number;
  contractId: number;
  amendmentNumber: string;
  status: string;
}

/**
 * The amendments belonging to one contract, as picker options.
 *
 * This is the fix for a real defect. The project form's amendment dropdown used to
 * be handed the *contract* list, so the two dropdowns showed identical options and
 * neither was an amendment. The job form then "fixed" it by listing every amendment
 * in the system, which is also wrong - it offers amendments from contracts the job is
 * not covered by, and the server rejects the pairing with a 422 the user has to
 * decode.
 *
 * Returns an empty list when no contract is chosen, which is honest: a project cannot
 * pick an amendment before it has a contract to pick it from. The field's placeholder
 * says so, rather than leaving an empty box that looks broken.
 */
export function amendmentOptionsFor(
  amendments: readonly AmendmentOption[],
  contractId: number | null,
): Array<{ value: string; label: string }> {
  if (contractId === null || !Number.isFinite(contractId)) return [];
  return amendments
    .filter((a) => a.contractId === contractId)
    .map((a) => ({ value: String(a.id), label: `${a.amendmentNumber} (${a.status})` }));
}

/** Reads a select value as a foreign key, or null when nothing is chosen. */
export function selectedId(value: string | boolean | undefined): number | null {
  if (value === undefined || value === '' || value === true || value === false) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * A display column.
 *
 * ## Why this returns `unknown` and the row type is erased
 *
 * `DataTable` accepts `ColumnDef<T, unknown>[]`, and these panels pass it tables
 * generic over their own row types (nothing at this level knows about a feature
 * set). TanStack Table v9's `ColumnDef` carries a third feature-set parameter
 * whose default is *not* a bare `unknown`, so naming it is what makes the array
 * assignable to what `DataTable<T>` declares.
 *
 * The alternative - inferring the feature set from a concrete table instance -
 * would drag a feature-set type parameter through every panel signature for no
 * gain: the columns here are plain display columns that never touch sorting or
 * filtering state, so all they need is the row type.
 */
export function cell<T extends object>(header: string, accessor: (row: T) => ReactNode) {
  return {
    header,
    cell: ({ row }: { row: { original: T } }) => accessor(row.original),
  } as unknown as ColumnDef<any, T, unknown>;
}

/** Right-aligned and tabular, matching the other registers' numeric columns. */
export function moneyCell<T extends object>(header: string, accessor: (row: T) => number | null) {
  return {
    header,
    meta: { align: 'right' },
    cell: ({ row }: { row: { original: T } }) => accessor(row.original),
  } as unknown as ColumnDef<any, T, unknown>;
}
