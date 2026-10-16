'use client';

/**
 * The job detail screen: one job, split into sections.
 *
 * ## Why tabs
 *
 * The screen used to stack the summary, the service-code lines and the labour &
 * margin panel in a single fixed-height column. Once the labour panel joined the
 * other two the column held more content than height, and the browser resolved the
 * overflow by letting one section's content spill over the next — the line items
 * overlapped the margin panel. Tabs remove the stacking entirely: one section is on
 * screen, and it owns its own scroll.
 *
 * ## Sections, and who may see them
 *
 *  - **Details** — identity, metadata and status. Everyone who can open the job.
 *  - **Timesheets** — the hours booked to the job, line by line. Needs
 *    `timesheet.read`, because every column is cost.
 *  - **Line items** — the scope and its measured quantities.
 *  - **Financials** — the labour-and-margin breakdown. Also `timesheet.read`.
 *
 * A tab the viewer cannot use is not shown, and a deep link to one shows a refusal
 * rather than a blank screen, the rule `/timesheets` already follows.
 *
 * The active tab lives in the URL (`?tab=`), so a section can be linked to and
 * survives a refresh. The register's own query string rides along untouched when the
 * tab changes; "back to jobs" strips the tab and lands on the right page of the list.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type JobDetail as JobDetailData } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/lifecycle/status-badge';
import { JobSummaryPanel } from '@/components/job-management/JobSummaryPanel';
import { JobServiceCodeTable } from '@/components/job-management/JobServiceCodeTable';
import { JobTimesheetsPanel } from '@/components/timesheets/job-timesheets-panel';
import { LabourMarginPanel } from '@/components/timesheets/labour-margin-panel';
import { usePermissions } from '@/components/auth/usePermissions';
import { useUrlParam } from '@/hooks/use-url-param';
import { formatPercent } from '@/lib/format';

type TabKey = 'details' | 'timesheets' | 'line-items' | 'financials';

interface TabDef {
  key: TabKey;
  label: string;
  /** Held to reveal the tab; absent means anyone who can open the job sees it. */
  permission?: string;
}

const TABS: readonly TabDef[] = [
  { key: 'details', label: 'Details' },
  { key: 'timesheets', label: 'Timesheets', permission: 'timesheet.read' },
  { key: 'line-items', label: 'Line items' },
  { key: 'financials', label: 'Financials', permission: 'timesheet.read' },
];

const TAB_KEYS = TABS.map((tab) => tab.key);

/**
 * The identity strip: which job, where it stands, who it is for.
 *
 * Kept outside the tabs so the job a user is looking at is never ambiguous when
 * they switch section — a screen of hours with no job name would be a trap.
 */
function JobIdentityHeader({ job }: { job: JobDetailData['job'] }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold">Job #{job.id}</h2>
          <StatusPill status={job.status} />
        </div>
        <p className="truncate text-sm text-muted-foreground">
          {job.project.code} · {job.project.contract.number} · {job.project.contract.client.name}
        </p>
      </div>

      {/* Commercial basis as a read-out pill, not a second editor: the amendment
          select on the Details tab is where this changes. */}
      <div className="flex flex-wrap items-center gap-2 rounded-full border bg-muted/40 px-3 py-1.5 text-xs">
        <span className="text-muted-foreground">Commercial basis</span>
        <span className="font-medium">
          {job.amendment?.amendmentNumber ?? '—'}
          {job.amendment?.status ? ` (${job.amendment.status})` : ''}
        </span>
        {job.amendmentInherited && <Badge variant="outline">inherited</Badge>}
        <span className="text-muted-foreground">
          VAT {formatPercent(job.amendment?.vatRate ?? 0)}
        </span>
      </div>
    </header>
  );
}

export function JobDetail({ jobId, onClose }: { jobId: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const [tab, setTab] = useUrlParam<TabKey>('tab', TAB_KEYS, 'details');

  const detail = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.get<JobDetailData>(`/api/jobs/${jobId}`),
  });

  // Refresh the register after any change, so a status moved or a line added shows
  // up in the list behind this screen without a manual reload.
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

  const visible = TABS.filter((def) => !def.permission || can(def.permission));
  const requested = TABS.find((def) => def.key === tab);
  // The URL is attacker-controlled, so a gated tab can be requested by someone who
  // cannot use it. Refuse that explicitly rather than rendering a blank section.
  const refuse = Boolean(requested?.permission && !can(requested.permission));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <JobIdentityHeader job={job} />

      <nav aria-label="Job sections" className="flex flex-wrap items-center gap-1">
        {visible.map((def) => (
          <Button
            key={def.key}
            size="sm"
            variant={tab === def.key ? 'default' : 'ghost'}
            aria-current={tab === def.key ? 'page' : undefined}
            onClick={() => setTab(def.key)}
          >
            {def.label}
          </Button>
        ))}
      </nav>

      {refuse ? (
        <Alert>
          You do not have permission to open “{requested?.label}”. It needs{' '}
          <code className="font-mono">{requested?.permission}</code>.
        </Alert>
      ) : (
        // One section at a time, in a region that fills the screen. Each section
        // brings its own scroller, so nothing can overlap anything else.
        <div className="flex min-h-0 flex-1 flex-col">
          {tab === 'details' && (
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <JobSummaryPanel job={job} permissions={permissions} onChanged={refreshAll} />
            </div>
          )}
          {tab === 'timesheets' && <JobTimesheetsPanel jobId={job.id} />}
          {tab === 'line-items' && (
            <JobServiceCodeTable
              jobId={job.id}
              job={job}
              deliverables={deliverables}
              summary={summary}
              permissions={permissions}
              onChanged={refreshAll}
            />
          )}
          {tab === 'financials' && (
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <LabourMarginPanel jobId={job.id} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
