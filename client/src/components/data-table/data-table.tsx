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
import { ArrowDown, ArrowUp, ChevronsUpDown, Rows3, Search, SlidersHorizontal, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
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

export type TableDensity = 'compact' | 'comfortable';

function getColumnLabel(column: { id: string; columnDef: { header?: unknown; meta?: unknown } }): string {
  const meta = column.columnDef.meta as { label?: string } | undefined;
  if (meta?.label) return meta.label;
  if (typeof column.columnDef.header === 'string') return column.columnDef.header;
  return column.id
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

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
  /** Optional contextual action button to display in empty states (e.g. "Create Job"). */
  emptyAction?: ReactNode;
  initialSort?: SortingState;
  pageSize?: number;
  /** Rendered in the toolbar, right-aligned. Typically "New ..." actions. */
  actions?: ReactNode;
  /** Renders a cell in a trailing actions column. */
  renderRowActions?: (row: T) => ReactNode;
  isLoading?: boolean;
  className?: string;

  /**
   * Controlled server-side pagination.
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

  /** Unique table id for persisting column visibility and density in localStorage. */
  tableId?: string;
  /** Initial visibility state map (columnId -> boolean). */
  initialColumnVisibility?: Record<string, boolean>;
  /** Optional row click handler for slide-over drawer peeks. */
  onRowClick?: (row: T) => void;
  /** Hide column visibility switcher if table is very small. */
  disableColumnVisibility?: boolean;
  /** Hide density switcher. */
  disableDensityToggle?: boolean;
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
  emptyAction,
  initialSort,
  pageSize = 25,
  actions,
  renderRowActions,
  isLoading = false,
  className,
  manualPagination,
  onSearchChange,
  searchTerm,
  tableId,
  initialColumnVisibility,
  onRowClick,
  disableColumnVisibility = false,
  disableDensityToggle = false,
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

  // Density state: compact (default for desktop/widescreen) or comfortable
  const [density, setDensity] = useState<TableDensity>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('openerp_table_density');
        if (saved === 'comfortable' || saved === 'compact') return saved;
      } catch {}
    }
    return 'compact';
  });

  const handleDensityChange = (next: TableDensity) => {
    setDensity(next);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('openerp_table_density', next);
      } catch {}
    }
  };

  // Column visibility state: persisted in localStorage if tableId is provided
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>(() => {
    if (tableId && typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem(`openerp_table_cols_${tableId}`);
        if (saved) return JSON.parse(saved);
      } catch {}
    }
    return initialColumnVisibility ?? {};
  });

  const handleColumnVisibilityChange = (
    updaterOrValue:
      | Record<string, boolean>
      | ((prev: Record<string, boolean>) => Record<string, boolean>),
  ) => {
    setColumnVisibility((prev) => {
      const next = typeof updaterOrValue === 'function' ? updaterOrValue(prev) : updaterOrValue;
      if (tableId && typeof window !== 'undefined') {
        try {
          localStorage.setItem(`openerp_table_cols_${tableId}`, JSON.stringify(next));
        } catch {}
      }
      return next;
    });
  };

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
              enableHiding: false,
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
      columnVisibility,
      ...(manualPagination && {
        pagination: { pageIndex: manualPagination.pageIndex, pageSize: manualPagination.pageSize },
      }),
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: handleColumnVisibilityChange,
    // Sorting and slicing are the server's job in manual mode, so the row models
    // are simply not registered: registering them would slice the page again and
    // show 25 of 25.
    ...(!manualPagination && {
      sortedRowModel: createSortedRowModel(),
      paginatedRowModel: createPaginatedRowModel(),
    }),
    ...(manualPagination && { manualPagination: true }),
    initialState: {
      pagination: { pageIndex: 0, pageSize },
      columnVisibility: initialColumnVisibility ?? {},
    },
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
        // The table owns the leftover height of whatever contains it: the
        // scroll region below takes `flex-1 min-h-0`, and the toolbar and
        // pagination stay put while the rows scroll. The parent has to give
        // this box a definite height (a flex chain) for that to mean anything.
        'flex min-h-0 flex-1 flex-col gap-3',
        className,
      )}
    >
      {/* Toolbar. `role="search"` marks it as a search region for assistive tech. */}
      <div
        role="search"
        className="flex shrink-0 flex-wrap items-center gap-2"
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

        <div className="ml-auto flex items-center gap-2">
          {!disableDensityToggle && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                handleDensityChange(density === 'compact' ? 'comfortable' : 'compact')
              }
              title={`Switch to ${density === 'compact' ? 'comfortable' : 'compact'} density`}
              className="h-8 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <Rows3 aria-hidden="true" className="size-3.5" />
              <span className="capitalize hidden sm:inline">{density}</span>
            </Button>
          )}

          {!disableColumnVisibility && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <SlidersHorizontal aria-hidden="true" className="size-3.5" />
                    <span>Columns</span>
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-52 max-h-72 overflow-y-auto">
                <div className="flex items-center justify-between px-2 py-1.5 border-b">
                  <span className="text-xs font-semibold">Toggle Columns</span>
                  <button
                    type="button"
                    onClick={() => {
                      table.resetColumnVisibility();
                      if (tableId && typeof window !== 'undefined') {
                        try {
                          localStorage.removeItem(`openerp_table_cols_${tableId}`);
                        } catch {}
                      }
                    }}
                    className="text-[11px] text-muted-foreground hover:text-primary transition-colors cursor-pointer"
                  >
                    Reset
                  </button>
                </div>
                <div className="p-1 space-y-0.5">
                  {table
                    .getAllLeafColumns()
                    .filter((column) => column.id !== '__actions' && column.getCanHide())
                    .map((column) => {
                      return (
                        <DropdownMenuCheckboxItem
                          key={column.id}
                          checked={column.getIsVisible()}
                          onCheckedChange={(checked) => column.toggleVisibility(Boolean(checked))}
                          className="text-xs cursor-pointer"
                        >
                          {getColumnLabel(column)}
                        </DropdownMenuCheckboxItem>
                      );
                    })}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/*
            Announced politely rather than shown only visually: a filter change
            that silently alters a row count is disorienting without it.
          */}
          <span aria-live="polite" className="text-xs text-muted-foreground">
            {isLoading
              ? 'Loading…'
              : manualPagination
                ? `${total} ${total === 1 ? 'row' : 'rows'}`
                : `${total} of ${data.length} ${total === 1 ? 'row' : 'rows'}`}
          </span>

          {actions}
        </div>
      </div>

      {/* The scroll container is focusable so a keyboard user can reach a table
          that overflows, which otherwise traps them with no way to scroll. */}
      <div
        tabIndex={0}
        role="region"
        aria-label={caption}
        className={cn(
          // This is the scrolling element, in both axes. `min-h-0` is what lets
          // it shrink: a flex child defaults to `min-height: auto` and would
          // push the page taller instead of ever scrolling.
          'focus-visible:ring-ring min-h-0 flex-1 overflow-auto rounded-lg border focus-visible:ring-2 focus-visible:outline-none',
          // The table paints its own surface: the sticky header has to be
          // opaque to hide the rows sliding under it, and `card`, `popover`
          // and this panel are one token in every theme, so it reads as the
          // surface it sits in - page, dashboard card or dialog alike.
          'bg-card',
        )}
      >
        <table className="w-full caption-bottom text-sm">
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
                      className={cn(
                        'sticky top-0 z-10 border-b bg-card/95 backdrop-blur-xs font-medium text-muted-foreground select-none',
                        density === 'compact' ? 'h-8 px-2.5 text-xs' : 'h-11 px-3.5 text-sm',
                        !sortable && '[&_button]:cursor-default',
                      )}
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
                  {table.getVisibleLeafColumns().map((_column, cellIndex) => (
                    <TableCell
                      key={cellIndex}
                      className={density === 'compact' ? 'py-1.5 px-2.5' : 'py-3 px-3.5'}
                    >
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : pageRows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={table.getVisibleLeafColumns().length || 1}
                  className="h-44 text-center"
                >
                  <div className="flex flex-col items-center justify-center gap-2 py-8">
                    <Empty>
                      <EmptyDescription className="text-sm text-muted-foreground">
                        {emptyMessage}
                      </EmptyDescription>
                    </Empty>
                    {isFiltered ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={clearAll}
                        className="mt-2 text-xs"
                      >
                        <X aria-hidden="true" className="size-3.5 mr-1.5" />
                        Clear filters & search
                      </Button>
                    ) : emptyAction ? (
                      <div className="mt-2">{emptyAction}</div>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((row) => (
                <TableRow
                  key={rowKey(row.original)}
                  onClick={
                    onRowClick
                      ? (event) => {
                          const target = event.target as HTMLElement;
                          if (
                            target.closest(
                              'a, button, input, select, textarea, [role="button"], [data-slot="dropdown-menu-trigger"]',
                            )
                          ) {
                            return;
                          }
                          onRowClick(row.original);
                        }
                      : undefined
                  }
                  className={cn(
                    'transition-colors',
                    onRowClick && 'cursor-pointer hover:bg-muted/50 active:bg-muted/70',
                  )}
                >
                  {row.getVisibleCells().map((cell) => {
                    // Numeric cells opt in via `meta.align`, so right-alignment
                    // and tabular figures are decided once with the column rather
                    // than re-derived at every call site.
                    const align = (cell.column.columnDef.meta as { align?: string } | undefined)
                      ?.align;
                    const value = flexRender(cell.column.columnDef.cell, cell.getContext());

                    return align === 'right' ? (
                      <NumericCell
                        key={cell.id}
                        className={cn(
                          'whitespace-nowrap',
                          density === 'compact' ? 'py-1.5 px-2.5 text-xs' : 'py-3 px-3.5 text-sm',
                        )}
                      >
                        {value}
                      </NumericCell>
                    ) : (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          density === 'compact' ? 'py-1.5 px-2.5 text-xs' : 'py-3 px-3.5 text-sm',
                        )}
                      >
                        {value}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </table>
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
        className="flex shrink-0 flex-wrap items-center justify-between gap-2 text-xs"
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
