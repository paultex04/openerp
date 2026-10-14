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
 *
 * TANSTACK TABLE v9
 *
 * v9 replaced the v8 "row model factory" options with an explicit feature set and
 * renamed the hook. Three consequences are visible below:
 *
 *  - `useReactTable` is now `useTable`, and the feature set is assembled once at
 *    module scope by `tableFeatures(...)`. Registering a feature is what makes its
 *    options and column properties exist, so a `column.enableSorting` or a
 *    `table.getSortedRowModel()` is a type error without it, not a runtime no-op.
 *  - The core row model is always present and `getCoreRowModel` is gone, so only
 *    sorting and pagination are opted into here.
 *  - State is read from `table.state` (a snapshot on the table) rather than
 *    `table.getState()`.
 *
 * The feature set is deliberately narrow. Every list endpoint returns the whole
 * set and this component filters in plain JavaScript, so the column-filtering and
 * global-filtering features would be dead weight in the bundle.
 */

import {
  columnVisibilityFeature,
  createPaginatedRowModel,
  createSortedRowModel,
  flexRender,
  rowPaginationFeature,
  rowSortingFeature,
  sortFns,
  tableFeatures,
  useTable,
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

/**
 * The features this table uses: sorting and pagination, with the built-in
 * comparator registry.
 *
 * `sortFns` is registered rather than left out because a column opts into a named
 * strategy (`sortFn: 'alphanumeric'`); an unregistered name is not a valid
 * `sortFn` value, and `'auto'` would resolve to nothing.
 *
 * Declared at module scope so the object identity is stable across renders: it is
 * part of the table's options, and a new object each render would rebuild the
 * table.
 */
const features = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  columnVisibilityFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortFns,
});

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

export interface DataTableProps<T extends object> {
  data: readonly T[];
  /**
   * Column definitions for the row type.
   *
   * The third argument is the feature set, and it has to be named explicitly:
   * TData's default is `unknown`, so `ColumnDef<T, unknown>` as written in the
   * registries would be a `ColumnDef` with no data row and would reject every
   * accessor. `typeof features` ties the columns to the features declared above.
   */
  columns: ColumnDef<typeof features, T, unknown>[];
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
  /**
   * Grow to fill the available height, scrolling the rows internally and pinning
   * the toolbar and pagination in place.
   *
   * This is what makes a register behave like an application screen rather than a
   * document: the toolbar stays visible while you scroll fifty rows, and the
   * pagination controls never end up below the fold.
   *
   * Requires an ancestor with a definite height - the app shell supplies one.
   */
  fill?: boolean;
  /** Extra classes on the scroll container, for cards of a known height. */
  className?: string;

  /**
   * Controlled server-side pagination.
   *
   * Supply all three, or none. With them the table stops filtering, sorting and
   * slicing `data` locally: it emits the requested page and renders exactly what
   * the server returned. Without them the behaviour is unchanged — the original
   * model, where every list endpoint returns everything and the browser does the
   * work.
   *
   * ## Why the jobs register needs this
   *
   * Every other register here fetches the whole set and filters in the browser.
   * That is the right trade while the result fits in memory, and wrong for jobs:
   * a jobs table grows with every job the company ever runs, and a search box that
   * has to download the table before it can answer "find WO-9844210" stops being
   * usable at exactly the scale it was built for.
   *
   * ## Why it is all-or-nothing
   *
   * TanStack's row model computes `rowCount` from the rows it holds, so a table in
   * server mode would report "page 1 of 1" for every page and Next would be
   * permanently disabled. `manualPagination` tells it to trust `rowCount` instead.
   * Mixing the two - server paging with client filtering - is the genuinely broken
   * case, and it is refused here rather than silently producing wrong answers: the
   * search box would filter one page of a many-page result and report a count that
   * has nothing to do with the total.
   */
  manualPagination?: {
    pageIndex: number;
    pageSize: number;
    rowCount: number;
    onPageIndexChange: (next: number) => void;
    onPageSizeChange: (next: number) => void;
  };
  /** Called when the free-text box changes. In server mode, replaces local filtering. */
  onSearchChange?: (term: string) => void;
  /** Controlled search term. Pair with `onSearchChange` in server mode. */
  searchTerm?: string;
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

export function DataTable<T extends object>({
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
  fill = false,
  className,
  manualPagination,
  onSearchChange,
  searchTerm,
}: DataTableProps<T>) {
  // One source of truth for the box's value: controlled when the parent owns the
  // term (server mode, so the URL or query key can hold it), local otherwise.
  const [localTerm, setLocalTerm] = useState('');
  const controlled = searchTerm !== undefined;
  const term = controlled ? searchTerm : localTerm;
  const setTerm = (next: string) => {
    if (!controlled) setLocalTerm(next);
    onSearchChange?.(next);
  };

  const [sorting, setSorting] = useState<SortingState>(initialSort ?? []);

  const filtered = useMemo(() => {
    let rows = data;
    // In server mode the rows are already the answer: filtering them again would
    // hide matches that live on another page, and the count would describe a page
    // rather than the result.
    if (!manualPagination) {
      if (term.trim()) rows = rows.filter((row) => matchesSearch(row, searchKeys, term.trim()));
      for (const filter of filters) {
        if (!filter.value) continue;
        rows = rows.filter((row) => filter.predicate(row, filter.value));
      }
    }
    return rows;
  }, [data, term, searchKeys, filters, manualPagination]);

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
            } as ColumnDef<typeof features, T, unknown>,
          ]
        : columns,
    [columns, renderRowActions],
  );

  const table = useTable({
    features,
    data: filtered,
    columns: manualPagination
      ? // Sorting one page locally would produce an order that contradicts every
        // other page, so the headers stop offering it rather than doing something
        // subtly wrong. The server's ordering (status, then id) is the meaningful
        // one for a jobs register anyway.
        allColumns.map((column) => ({ ...column, enableSorting: false }))
      : allColumns,
    state: {
      sorting,
      ...(manualPagination && {
        pagination: { pageIndex: manualPagination.pageIndex, pageSize: manualPagination.pageSize },
      }),
    },
    onSortingChange: setSorting,
    // Sorting and slicing are the server's job in manual mode, so the row models
    // are simply not registered: registering them would slice the page again and
    // show 25 of 25.
    ...(!manualPagination && {
      sortedRowModel: createSortedRowModel(),
      paginatedRowModel: createPaginatedRowModel(),
    }),
    ...(manualPagination && { manualPagination: true }),
    initialState: { pagination: { pageIndex: 0, pageSize } },
  });

  const activeFilterCount = filters.filter((filter) => filter.value).length;
  const isFiltered = Boolean(term.trim()) || activeFilterCount > 0;
  const pageRows = table.getRowModel().rows;
  // In server mode the total is the whole result set, not the length of this page.
  const total = manualPagination ? manualPagination.rowCount : filtered.length;
  const pageIndex = manualPagination
    ? manualPagination.pageIndex
    : table.state.pagination.pageIndex;
  const rowsPerPage = manualPagination ? manualPagination.pageSize : pageSize;
  const pageCount = Math.max(1, Math.ceil(total / rowsPerPage));

  const clearAll = () => {
    setTerm('');
    for (const filter of filters) if (filter.value) filter.onChange('');
  };

  return (
    <div
      className={cn(
        'flex flex-col gap-3',
        // In fill mode the table owns the leftover height: the scroll region
        // takes `flex-1 min-h-0` and the toolbar and pagination stay put.
        fill && 'min-h-0 flex-1',
        className,
      )}
    >
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
          {isLoading
            ? 'Loading…'
            : manualPagination
              ? // `data.length` is the page, not the result, so "N of M" would be
                // nonsense here. The count alone is the honest figure.
                `${total} ${total === 1 ? 'row' : 'rows'}`
              : `${total} of ${data.length} ${total === 1 ? 'row' : 'rows'}`}
        </span>

        {actions}
      </div>

      {/* The scroll container is focusable so a keyboard user can reach a table
          that overflows, which otherwise traps them with no way to scroll. */}
      <div
        tabIndex={0}
        role="region"
        aria-label={caption}
        className={cn(
          'focus-visible:ring-ring overflow-x-auto rounded-lg border focus-visible:ring-2 focus-visible:outline-none',
          // In fill mode this is the scrolling element. `min-h-0` again: without
          // it a flex child refuses to shrink and the whole page grows instead.
          fill && 'min-h-0 flex-1 overflow-y-auto',
        )}
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

      {/*
        Pagination is rendered unconditionally, including when there is only one
        page.

        Hiding it for short tables was the wrong call: the control is also where
        the page-size selector lives, so a table with 4 rows offered no way to
        reach the control that would let you choose 10 or 100. It also made the
        footer of every register look different depending on its row count, which
        is precisely the inconsistency this component exists to remove.
      */}
      <nav
        aria-label={`${caption} pagination`}
        className="flex flex-wrap items-center justify-between gap-2 text-xs"
      >
        <span className="text-muted-foreground">
          {pageRows.length === 0
            ? 'No rows'
            : `Showing ${pageIndex * rowsPerPage + 1}–${pageIndex * rowsPerPage + pageRows.length} of ${total}`}
        </span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-muted-foreground">
            Rows
            <select
              value={String(rowsPerPage)}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (manualPagination) {
                  // Reset to the first page: staying on page 4 of a 250-row-per-page
                  // view after switching from 10 shows nothing at all.
                  manualPagination.onPageSizeChange(next);
                } else {
                  table.setPageSize(next);
                }
              }}
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
            disabled={pageIndex === 0}
            onClick={() => {
              if (manualPagination) manualPagination.onPageIndexChange(pageIndex - 1);
              else table.previousPage();
            }}
          >
            Previous
          </Button>
          <span className="min-w-16 text-center tabular-nums text-muted-foreground">
            Page {total === 0 ? 0 : pageIndex + 1} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={pageIndex + 1 >= pageCount}
            onClick={() => {
              if (manualPagination) manualPagination.onPageIndexChange(pageIndex + 1);
              else table.nextPage();
            }}
          >
            Next
          </Button>
        </div>
      </nav>
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
