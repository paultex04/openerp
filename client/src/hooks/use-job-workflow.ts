'use client';

/**
 * The live job workflow, for every piece of UI that renders or offers a status.
 *
 * Since Phase 15 item 5 the statuses and transitions are administrator-editable
 * data, so a component that wants the pipeline (the register's status filter, the
 * job detail's status dropdown, the dashboard's pipeline card) asks the server
 * rather than importing a constant. The server reads the same rows it enforces,
 * so a relabelled or reordered status shows up here without a deploy.
 *
 * ## Why a fallback
 *
 * While the query is in flight the hook returns `DEFAULT_JOB_WORKFLOW` - the
 * catalogue every database is seeded from. A flash of default labels for one
 * round trip is preferable to every consumer handling `workflow | undefined`,
 * and on a database that has never been edited the fallback *is* the answer.
 * Once the query settles, the real catalogue takes over.
 *
 * The query is cached for five minutes: the catalogue changes when one
 * administrator edits it, not per navigation. The admin panel invalidates this
 * key on every write, so its own edits are visible immediately.
 */
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_JOB_WORKFLOW, type JobStatusDefinition, type JobWorkflow } from '@openerp/shared';
import { api } from '@/lib/api';

/** Exported so writers (the admin workflow panel) can invalidate it. */
export const JOB_WORKFLOW_QUERY_KEY = ['job-workflow'] as const;

export interface JobWorkflowLookup {
  /** The catalogue. Never undefined; see "Why a fallback" above. */
  workflow: JobWorkflow;
  /** Statuses in pipeline order. */
  statuses: readonly JobStatusDefinition[];
  /** Label for a status key, falling back to the key for a status that is gone. */
  label: (key: string) => string;
  /** True while the first fetch is in flight. */
  isLoading: boolean;
}

export function useJobWorkflow(options: { enabled?: boolean } = {}): JobWorkflowLookup {
  const query = useQuery({
    queryKey: JOB_WORKFLOW_QUERY_KEY,
    queryFn: () => api.get<{ workflow: JobWorkflow }>('/api/jobs/workflow'),
    staleTime: 5 * 60_000,
    // A viewer without job access would only collect a 403; the fallback
    // catalogue still renders, and nothing they can reach offers a status.
    enabled: options.enabled ?? true,
  });

  const workflow = query.data?.workflow ?? DEFAULT_JOB_WORKFLOW;
  const statuses = workflow.statuses;

  const label = (key: string) => statuses.find((status) => status.key === key)?.label ?? key;

  return { workflow, statuses, label, isLoading: query.isLoading };
}
