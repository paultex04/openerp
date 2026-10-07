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
 * So it is one page, two tables, stacked. The jobs register on top; select a row and
 * the job's details and its service-code lines appear below it. The list stays
 * visible and keeps its scroll position and filters while you work on a job, which
 * is the whole reason for the stacked layout rather than a drill-down.
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
 * ## The selected job is not URL state
 *
 * Selecting a row is a drill-down within the page, not navigation. It is kept in
 * component state rather than the query string so that paging the register does not
 * clear the job you are working on, and so the Back button still leaves the screen
 * rather than stepping back through selections.
 */

import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { api, ApiError, type JobDetail, type JobListResponse, type JobRow } from '@/lib/api';
import { DataTable, type DataTableFilter } from '@/components/data-table/data-table';
import { StatusPill } from '@/components/lifecycle/status-badge';
import { JOB_STATUSES } from '@/components/operations/statusOrder';
import { JobSummaryPanel } from '@/components/job-management/JobSummaryPanel';
import { JobServiceCodeTable } from '@/components/job-management/JobServiceCodeTable';
import { JobBillingCard } from '@/components/job-management/JobBillingCard';
import { useDebounced } from '@/hooks/use-debounced';

/**
 * A display column.
 *
 * `ColumnDef<T, unknown>` is the type `DataTable` takes, and TanStack's
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
  } as ColumnDef<T, unknown>;
}

/** Right-aligned and tabular, matching the other registers' numeric columns. */
function numericCell<T extends object>(header: string, accessor: (row: T) => ReactNode) {
  return {
    header,
    meta: { align: 'right' },
    cell: ({ row }: { row: { original: T } }) => accessor(row.original),
  } as ColumnDef<T, unknown>;
}

/** Rows fetched per request. Kept small: this is a list, not a report. */
const PAGE_SIZE = 25;

/** Debounce for the search box, in ms. */
const SEARCH_DEBOUNCE = 300;

export function JobRegister() {
  const [searchInput, setSearchInput] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);

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
  const [paging, setPaging] = useState({ key: queryKey, index: 0 });
  const pageIndex = paging.key === queryKey ? paging.index : 0;
  const goToPage = (next: number) => setPaging({ key: queryKey, index: next });

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

  const statusOptions = useMemo(
    () => [
      { value: '', label: 'All statuses' },
      ...JOB_STATUSES.map((status) => ({ value: status, label: status })),
    ],
    [],
  );

  const projectOptions = useMemo(
    () => [
      { value: '', label: 'All projects' },
      ...(projects.data?.projects ?? []).map((p) => ({ value: String(p.id), label: p.code })),
    ],
    [projects.data],
  );

  const columns = useMemo<ColumnDef<JobRow, unknown>[]>(
    () => [
      cell<JobRow>('Job', (row) => <span className="font-mono font-medium">#{row.id}</span>),
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
    [],
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
        Not `fill`: this table shares the page with the selected job's panels, and a
        table that grows to consume all remaining height would push them off-screen.
        The register is bounded by its page size instead.
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
        renderRowActions={(row) => (
          <button
            type="button"
            onClick={() => setSelectedJobId(row.id)}
            aria-pressed={selectedJobId === row.id}
            className={
              selectedJobId === row.id
                ? 'rounded-md border border-primary px-2 py-1 text-xs font-medium text-primary'
                : 'rounded-md border px-2 py-1 text-xs hover:bg-accent'
            }
          >
            {selectedJobId === row.id ? 'Selected' : 'Select'}
          </button>
        )}
      />

      {selectedJobId === null ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          Select a job above to see its details and service-code line items.
        </p>
      ) : (
        <SelectedJob jobId={selectedJobId} onClose={() => setSelectedJobId(null)} />
      )}
    </div>
  );
}

/** ------------------------------------------------------------------------- */

function SelectedJob({ jobId, onClose }: { jobId: number; onClose: () => void }) {
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
          Close
        </button>
      </div>
    );
  }

  if (!detail.data) return <p className="text-sm text-muted-foreground">Job not found.</p>;

  const { job, permissions, deliverables, summary } = detail.data;

  return (
    <div className="flex min-h-0 flex-col gap-4 border-t pt-6">
      <JobSummaryPanel
        job={job}
        permissions={permissions}
        onChanged={refreshAll}
        onClose={onClose}
      />

      <JobServiceCodeTable
        jobId={job.id}
        job={job}
        deliverables={deliverables}
        summary={summary}
        permissions={permissions}
        onChanged={refreshAll}
      />

      <JobBillingCard job={job} onChanged={refreshAll} />
    </div>
  );
}
