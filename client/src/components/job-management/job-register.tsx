'use client';

/**
 * Job register: the single Operations screen.
 *
 * ## What this replaced
 *
 * Operations was three sidebar entries over one route with a `?view=` parameter:
 * a Projects Register dashboard, a Jobs Board (originally a thirteen-column kanban,
 * then a table) and a Valuation Packs deep link into a pre-filtered board. None of
 * them answered the question this screen exists for - "here is job X, what is on it
 * and what does it cost" - without a click that destroyed your place in the list.
 *
 * The register links to a separate job detail route. Its filters and pagination
 * live in the URL, and the register scroll position is restored when navigating
 * back from a job.
 *
 * ## The register searches on the server
 *
 * This is the one list that does. Every other register fetches everything and
 * filters in the browser, which is the right trade while the result fits in memory.
 * A jobs table grows with every job the company ever runs, and the Jobs Board was
 * already unusable at three jobs because thirteen statuses meant thirteen columns of
 * horizontal scroll. Search has to work before the table is big, or it does not work.
 * See `manualPagination` on `DataTable` for the all-or-nothing reasoning.
 *
 * ## Register state is URL state
 *
 * Search, filters and paging are mirrored in the URL so a job detail link can be
 * opened and the register reconstructed when navigating back to it.
 */

import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { api, ApiError, type JobDetail, type JobListResponse, type JobRow } from '@/lib/api';
import { DataTable, type DataTableFilter } from '@/components/data-table/data-table';
import { StatusPill } from '@/components/lifecycle/status-badge';
import { JobSummaryPanel } from '@/components/job-management/JobSummaryPanel';
import { JobServiceCodeTable } from '@/components/job-management/JobServiceCodeTable';
import { LabourMarginPanel } from '@/components/timesheets/labour-margin-panel';
import { useJobWorkflow } from '@/hooks/use-job-workflow';
import { useDebounced } from '@/hooks/use-debounced';

/**
 * A display column.
 *
 * `ColumnDef<any, T, unknown>` is the type `DataTable` takes, and TanStack's
 * `createColumnHelper` produces `ColumnDef<T, TValue>` with `TValue` inferred from
 * the accessor - so a `helper.accessor('id', …)` is `ColumnDef<JobRow, number>` and
 * will not assign. Building the object and casting once here is what the master-data
 * panels already do for the same reason, and it keeps the column list readable
 * without a generic argument on every cell.
 */
function cell<T extends object>(header: string, accessor: (row: T) => ReactNode) {
  return {
    header,
    cell: ({ row }: { row: { original: T } }) => accessor(row.original),
  } as unknown as ColumnDef<any, T, unknown>;
}

/** Right-aligned and tabular, matching the other registers' numeric columns. */
function numericCell<T extends object>(header: string, accessor: (row: T) => ReactNode) {
  return {
    header,
    meta: { align: 'right' },
    cell: ({ row }: { row: { original: T } }) => accessor(row.original),
  } as unknown as ColumnDef<any, T, unknown>;
}

/** Rows fetched per request. Kept small: this is a list, not a report. */
const PAGE_SIZE = 25;

/** Debounce for the search box, in ms. */
const SEARCH_DEBOUNCE = 300;

export function JobRegister() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [searchInput, setSearchInput] = useState(searchParams.get('search') ?? '');
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') ?? '');
  const [projectFilter, setProjectFilter] = useState(searchParams.get('projectId') ?? '');
  const [pageSize, setPageSize] = useState(() => {
    const value = Number(searchParams.get('pageSize'));
    return Number.isInteger(value) && value >= 1 && value <= 200 ? value : PAGE_SIZE;
  });
  const search = useDebounced(searchInput, SEARCH_DEBOUNCE);

  // The page is stored *with the query it belongs to*, rather than reset in an
  // effect when the query changes.
  //
  // The effect version has two problems. It costs an extra render on every filter
  // change, and it renders the wrong page first: change the filter on page 7, and
  // the table briefly shows page 7 of the new — usually much smaller — result set,
  // often an empty table, before the reset lands. Comparing the stored key against
  // the current one derives the answer during render, so the first frame is already
  // correct.
  const queryKey = `${search}|${statusFilter}|${projectFilter}|${pageSize}`;
  const [paging, setPaging] = useState(() => {
    const value = Number(searchParams.get('page'));
    return {
      key: queryKey,
      index: Number.isInteger(value) && value > 0 ? value - 1 : 0,
    };
  });
  const pageIndex = paging.key === queryKey ? paging.index : 0;
  const goToPage = (next: number) => setPaging({ key: queryKey, index: next });
  const registerParams = new URLSearchParams(searchParams.toString());
  for (const [key, value] of [
    ['search', search],
    ['status', statusFilter],
    ['projectId', projectFilter],
  ] as Array<[string, string]>) {
    if (value) registerParams.set(key, value);
    else registerParams.delete(key);
  }
  registerParams.set('page', String(pageIndex + 1));
  registerParams.set('pageSize', String(pageSize));
  const registerQuery = registerParams.toString();

  useEffect(() => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of [
      ['search', search],
      ['status', statusFilter],
      ['projectId', projectFilter],
    ] as Array<[string, string]>) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    next.set('page', String(pageIndex + 1));
    next.set('pageSize', String(pageSize));
    const query = next.toString();
    if (query !== searchParams.toString()) {
      router.replace(`/operations?${query}`, { scroll: false });
    }
  }, [pageIndex, pageSize, projectFilter, router, search, searchParams, statusFilter]);

  const jobs = useQuery({
    queryKey: [
      'jobs',
      'register',
      { search, status: statusFilter, projectId: projectFilter, page: pageIndex, pageSize },
    ],
    queryFn: () => {
      const params = new URLSearchParams();
      // Pagination is only sent once the user has actually paged, matching the
      // server's rule that an unpaginated request returns everything.
      params.set('page', String(pageIndex + 1));
      params.set('pageSize', String(pageSize));
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      if (projectFilter) params.set('projectId', projectFilter);
      return api.get<JobListResponse>(`/api/jobs?${params.toString()}`);
    },
    // Keep the previous page on screen while the next one loads, so the register
    // does not collapse to a skeleton every time you page.
    placeholderData: (previous) => previous,
  });

  const projects = useQuery({
    queryKey: ['projects', 'options'],
    queryFn: () => api.get<{ projects: Array<{ id: number; code: string }> }>('/api/projects'),
  });

  const rows = jobs.data?.jobs ?? [];
  const total = jobs.data?.total ?? 0;

  // The filter offers whatever the workflow currently contains - a status an
  // administrator added appears here, a deleted one disappears, and the labels
  // are the live ones. The server validates the filter against the same
  // catalogue, so there is no value here it would reject.
  const { statuses } = useJobWorkflow();
  const statusOptions = useMemo(
    () => [
      { value: '', label: 'All statuses' },
      ...statuses.map((status) => ({ value: status.key, label: status.label })),
    ],
    [statuses],
  );

  const projectOptions = useMemo(
    () => [
      { value: '', label: 'All projects' },
      ...(projects.data?.projects ?? []).map((p) => ({ value: String(p.id), label: p.code })),
    ],
    [projects.data],
  );

  const columns = useMemo<ColumnDef<any, JobRow, unknown>[]>(
    () => [
      // The job number is the doorway into the job. The old trailing "Open"
      // button was a second click target for the same destination; the number
      // is what the reader is already looking at, so it became the link and
      // the button went away. The register's query rides along so returning
      // from the job restores the same filters and page.
      cell<JobRow>('Job', (row) => (
        <Link
          href={`/operations/${row.id}?${registerQuery}`}
          className="font-mono font-medium text-primary underline-offset-4 hover:underline"
        >
          #{row.id}
        </Link>
      )),
      cell<JobRow>('Status', (row) => <StatusPill status={row.status} />),
      cell<JobRow>('Description', (row) =>
        row.description ? (
          <span className="block max-w-80 truncate" title={row.description}>
            {row.description}
          </span>
        ) : (
          <span className="text-muted-foreground">No description</span>
        ),
      ),
      cell<JobRow>('Work order', (row) => (
        <span className="font-mono text-xs">{row.workOrder ?? '—'}</span>
      )),
      cell<JobRow>('Purchase order', (row) => (
        <span className="font-mono text-xs">{row.purchaseOrder ?? '—'}</span>
      )),
      cell<JobRow>('Project', (row) => (
        <span className="font-mono text-xs">{row.project.code}</span>
      )),
      cell<JobRow>('Supervisor', (row) =>
        row.supervisor ? (
          <span className="text-xs">
            {row.supervisor.name} {row.supervisor.surname}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Unassigned</span>
        ),
      ),
      numericCell<JobRow>('Lines', (row) => (
        <span className="tabular-nums">{row._count?.serviceCodes ?? 0}</span>
      )),
    ],
    [registerQuery],
  );

  const filters: DataTableFilter<JobRow>[] = [
    {
      id: 'status',
      label: 'Status',
      value: statusFilter,
      options: statusOptions,
      onChange: setStatusFilter,
      predicate: (row, value) => row.status === value,
    },
    {
      id: 'project',
      label: 'Project',
      value: projectFilter,
      options: projectOptions,
      onChange: setProjectFilter,
      predicate: (row, value) => String(row.project.id) === value,
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Job Management</h1>
        <p className="text-sm text-muted-foreground">
          Every job, its status and its scope. Select a job to see its details and line items.
        </p>
      </header>

      {/*
        No `fill` prop any more, and no scroll juggling either: the table fills
        the page and scrolls its own rows, so returning from a job lands on the
        same filters and page without the sessionStorage hack this register used
        to need. See `DataTable` for the one behaviour every register now has.
      */}
      <DataTable<JobRow>
        data={rows}
        columns={columns}
        rowKey={(row) => row.id}
        searchKeys={[]}
        searchTerm={searchInput}
        onSearchChange={setSearchInput}
        searchPlaceholder="Search job, work order, PO, area, project or supervisor."
        filters={filters}
        caption="Jobs"
        emptyMessage="No jobs match the current search and filters."
        isLoading={jobs.isLoading}
        manualPagination={{
          pageIndex,
          pageSize,
          rowCount: total,
          onPageIndexChange: goToPage,
          onPageSizeChange: setPageSize,
        }}
      />
    </div>
  );
}

/** ------------------------------------------------------------------------- */

export function SelectedJob({ jobId, onClose }: { jobId: number; onClose: () => void }) {
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.get<JobDetail>(`/api/jobs/${jobId}`),
  });

  // Refresh the register after any change, so a status moved or a line added shows
  // up in the list above without a manual reload.
  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['job', jobId] });
    void queryClient.invalidateQueries({ queryKey: ['jobs', 'register'] });
  };

  if (detail.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading job…</p>;
  }

  if (detail.isError) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive">
          {detail.error instanceof ApiError ? detail.error.message : 'Could not load the job.'}
        </p>
        <button type="button" onClick={onClose} className="text-xs underline">
          Back to jobs
        </button>
      </div>
    );
  }

  if (!detail.data) return <p className="text-sm text-muted-foreground">Job not found.</p>;

  const { job, permissions, deliverables, summary } = detail.data;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <JobSummaryPanel job={job} permissions={permissions} onChanged={refreshAll} />

      <JobServiceCodeTable
        jobId={job.id}
        job={job}
        deliverables={deliverables}
        summary={summary}
        permissions={permissions}
        onChanged={refreshAll}
      />

      <LabourMarginPanel jobId={job.id} />
    </div>
  );
}
