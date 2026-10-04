'use client';

/**
 * Shared data table: search, filter, sort, paginate, optional row actions.
 *
 * WHY THIS EXISTS
 *
 * There were fourteen tables in the application, each hand-rolled, and not one
 * of them could be searched or filtered. On a register with more than a screenful
 * of rows that is not a missing nicety - it means you cannot answer "show me the
 * submitted invoices" without reading every row. Fourteen bespoke
 * implementations would have made it worse, so the behaviour lives here once.
 *
 * DESIGN: search and filtering happen in this component, not in TanStack's
 * filter model. Every list endpoint returns the full set (they are small,
 * bounded by the database, not paginated server-side), so filtering the rows we
 * already hold is instantaneous and needs no extra round trip. TanStack then
 * handles sorting and pagination, which is where its row model genuinely earns
 * its keep. The split keeps the filter semantics obvious: a filter is
 * `predicate(row, value)`, not a stringly-typed `columnFilters` object.
 *
 * This is deliberately NOT in `components/ui/`: that directory is owned by the
 * shadcn registry and is replaced wholesale by `shadcn add --overwrite`.
 */

import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown, Search, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { NumericCell } from '@/components/data-table/NumericCell';
import { cn } from '@/lib/utils';

export interface DataTableFilter<T> {
  /** Stable id; also the filter's state key. */
  id: string;
  label: string;
  /** The current value, or `''` for "all". */
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  /**
   * Return false to exclude a row. Not a "contains" test - filters here are
   * categorical, where `===` is the honest comparison.
   */
  predicate: (row: T, value: string) => boolean;
}

export interface DataTableProps<T> {
  data: readonly T[];
  columns: ColumnDef<T, unknown>[];
  /** Unique per row. */
  rowKey: (row: T) => string | number;
  /**
   * Fields searched by the free-text box. Dotted paths are walked, so
   * `'employee.name'` works without a pre-flattened copy of the data.
   */
  searchKeys: readonly string[];
  searchPlaceholder?: string;
  filters?: readonly DataTableFilter<T>[];
  /** Required: an unlabelled table is unusable with a screen reader. */
  caption: string;
  emptyMessage?: string;
  initialSort?: SortingState;
  pageSize?: number;
  /** Rendered in the toolbar, right-aligned. Typically "New ..." actions. */
  actions?: ReactNode;
  /** Renders a cell in a trailing actions column. */
  renderRowActions?: (row: T) => ReactNode;
  isLoading?: boolean;
  /** Extra classes on the scroll container, for cards of a known height. */
  className?: string;
}

/** Reads a possibly-dotted path out of an unknown record. */
function pluck(row: unknown, path: string): string {
  let current: unknown = row;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return '';
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || current === undefined) return '';
  if (Array.isArray(current)) return current.map(String).join(' ');
  if (typeof current === 'object') return '';
  return String(current);
}

/**
 * Free-text match over the configured keys.
 *
 * Case-insensitive, and every whitespace-separated term must match *some* key -
 * so "pack ready" finds `07. Pack Ready`, and "pack sasol" narrows rather than
 * widening. Requiring all terms is what makes a multi-word search feel precise
 * instead of returning everything that contains any one word.
 */
function matchesSearch(row: unknown, keys: readonly string[], term: string): boolean {
  const terms = term.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = keys.map((key) => pluck(row, key).toLowerCase());
  return terms.every((needle) => haystack.some((value) => value.includes(needle)));
}

export function DataTable<T>({
  data,
  columns,
  rowKey,
  searchKeys,
  searchPlaceholder = 'Search…',
  filters = [],
  caption,
  emptyMessage = 'Nothing matches the current search and filters.',
  initialSort,
  pageSize = 25,
  actions,
  renderRowActions,
  isLoading = false,
  className,
}: DataTableProps<T>) {
  const [term, setTerm] = useState('');
  const [sorting, setSorting] = useState<SortingState>(initialSort ?? []);

  const filtered = useMemo(() => {
    let rows = data;
    if (term.trim()) rows = rows.filter((row) => matchesSearch(row, searchKeys, term.trim()));
    for (const filter of filters) {
      if (!filter.value) continue;
      rows = rows.filter((row) => filter.predicate(row, filter.value));
    }
    return rows;
  }, [data, term, searchKeys, filters]);

  const allColumns = useMemo(
    () =>
      renderRowActions
        ? [
            ...columns,
            {
              id: '__actions',
              header: () => <span className="sr-only">Row actions</span>,
              cell: ({ row }: { row: { original: T } }) => (
                <div className="flex justify-end gap-1">{renderRowActions(row.original)}</div>
              ),
              enableSorting: false,
            } as unknown as ColumnDef<T, unknown>,
          ]
        : columns,
    [columns, renderRowActions],
  );

  const table = useReactTable({
    data: filtered as T[],
    columns: allColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  const activeFilterCount = filters.filter((filter) => filter.value).length;
  const isFiltered = Boolean(term.trim()) || activeFilterCount > 0;
  const pageRows = table.getRowModel().rows;
  const total = filtered.length;

  const clearAll = () => {
    setTerm('');
    for (const filter of filters) if (filter.value) filter.onChange('');
  };

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {/* Toolbar. `role="search"` marks it as a search region for assistive tech. */}
      <div
        role="search"
        className="flex flex-wrap items-center gap-2"
        aria-label={`${caption} controls`}
      >
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={`Search ${caption}`}
            className="pl-8"
          />
        </div>

        {filters.map((filter) => (
          <label key={filter.id} className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">{filter.label}</span>
            {/*
              A native <select>: `ui/select.tsx` ships without a root `Select`
              export, so adopting it means hand-assembling Base UI's root and
              parts. See ADR-006 F3. A native select is fully keyboard- and
              screen-reader-accessible, and it renders natively on every platform.
            */}
            <select
              value={filter.value}
              onChange={(event) => filter.onChange(event.target.value)}
              aria-label={filter.label}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            >
              {filter.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ))}

        {isFiltered && (
          <Button variant="ghost" size="sm" onClick={clearAll}>
            <X aria-hidden="true" className="size-3.5" />
            Clear
          </Button>
        )}

        {/*
          Announced politely rather than shown only visually: a filter change
          that silently alters a row count is disorienting without it.
        */}
        <span aria-live="polite" className="ml-auto text-xs text-muted-foreground">
          {isLoading ? 'Loading…' : `${total} of ${data.length} ${total === 1 ? 'row' : 'rows'}`}
        </span>

        {actions}
      </div>

      {/* The scroll container is focusable so a keyboard user can reach a table
          that overflows, which otherwise traps them with no way to scroll. */}
      <div
        tabIndex={0}
        role="region"
        aria-label={caption}
        className="focus-visible:ring-ring overflow-x-auto rounded-lg border focus-visible:ring-2 focus-visible:outline-none"
      >
        <Table>
          <TableCaption className="sr-only">{caption}</TableCaption>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sortDirection = header.column.getIsSorted();
                  const sortable = header.column.getCanSort();
                  const label = flexRender(header.column.columnDef.header, header.getContext());

                  return (
                    <TableHead
                      key={header.id}
                      scope="col"
                      aria-sort={
                        sortDirection === 'asc'
                          ? 'ascending'
                          : sortDirection === 'desc'
                            ? 'descending'
                            : sortable
                              ? 'none'
                              : undefined
                      }
                      className={cn(!sortable && '[&_button]:cursor-default')}
                    >
                      {sortable ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="-mx-1 inline-flex items-center gap-1 rounded px-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                          {label}
                          {sortDirection === 'asc' ? (
                            <ArrowUp aria-hidden="true" className="size-3.5" />
                          ) : sortDirection === 'desc' ? (
                            <ArrowDown aria-hidden="true" className="size-3.5" />
                          ) : (
                            <ChevronsUpDown aria-hidden="true" className="size-3.5 opacity-40" />
                          )}
                        </button>
                      ) : (
                        label
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>

          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, index) => (
                <TableRow key={`skeleton-${index}`}>
                  {allColumns.map((_column, cellIndex) => (
                    <TableCell key={cellIndex}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : pageRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={allColumns.length} className="h-32">
                  <Empty>
                    <EmptyDescription>{emptyMessage}</EmptyDescription>
                  </Empty>
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((row) => (
                <TableRow key={rowKey(row.original)}>
                  {row.getVisibleCells().map((cell) => {
                    // Numeric cells opt in via `meta.align`, so right-alignment
                    // and tabular figures are decided once with the column rather
                    // than re-derived at every call site.
                    const align = (cell.column.columnDef.meta as { align?: string } | undefined)
                      ?.align;
                    const value = flexRender(cell.column.columnDef.cell, cell.getContext());

                    return align === 'right' ? (
                      <NumericCell key={cell.id} className="whitespace-nowrap">
                        {value}
                      </NumericCell>
                    ) : (
                      <TableCell key={cell.id}>{value}</TableCell>
                    );
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination. Only shown when it can do something, so a 4-row table does
          not grow a control for a page it does not have. */}
      {table.getPageCount() > 1 && (
        <nav
          aria-label={`${caption} pagination`}
          className="flex flex-wrap items-center justify-between gap-2 text-xs"
        >
          <span className="text-muted-foreground">
            Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
          </span>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-muted-foreground">
              Rows
              <select
                value={String(pageSize)}
                onChange={(event) => table.setPageSize(Number(event.target.value))}
                aria-label="Rows per page"
                className="h-7 rounded-md border border-input bg-background px-1.5"
              >
                {[10, 25, 50, 100].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="outline"
              size="sm"
              disabled={!table.getCanPreviousPage()}
              onClick={() => table.previousPage()}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!table.getCanNextPage()}
              onClick={() => table.nextPage()}
            >
              Next
            </Button>
          </div>
        </nav>
      )}
    </div>
  );
}

/** Small helper for a categorical filter over a string field. */
export function stringFilter<T>(
  id: string,
  label: string,
  field: string,
  options: ReadonlyArray<{ value: string; label: string }>,
  value: string,
  onChange: (next: string) => void,
): DataTableFilter<T> {
  return {
    id,
    label,
    value,
    options,
    onChange,
    predicate: (row, selected) => pluck(row, field) === selected,
  };
}

/** Exported so page-level filters can share the value-cell idiom. */
export function BadgeCell({ value }: { value: string }) {
  return <Badge variant="outline">{value}</Badge>;
}
