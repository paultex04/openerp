/**
 * The live job workflow: load, cache, invalidate.
 *
 * Since Phase 15 item 5 the statuses and transitions are administrator-editable
 * rows, so every question about a job's lifecycle ("may this move", "is this
 * stage terminal", "are planned quantities editable") has to be answered from
 * the database rather than from a constant. This module is how the server reads
 * them, and it is the only place that does.
 *
 * ## Why a cache
 *
 * The catalogue changes when an administrator edits it and at no other time.
 * Reading it costs two small indexed queries, which would ride along on every
 * job transition, every deliverable edit and every job list - so it is read once
 * per process and held. `invalidateJobWorkflow()` is called by the admin routes
 * the moment a write commits.
 *
 * The cache is process-local, and deliberately so. A stale copy can only exist
 * for the instant between an edit and the next request in the same process; the
 * failure mode - a transition judged by the catalogue as it stood a moment ago -
 * is indistinguishable from the request having arrived a moment earlier.
 *
 * ## Tests
 *
 * The integration suites mutate the catalogue through the admin API, so
 * invalidation happens on the normal path. A test that writes to
 * `job_statuses`/`job_transitions` with Prisma directly must call
 * `invalidateJobWorkflow()` itself, or it will keep reading the pre-test
 * catalogue.
 */
import type { JobWorkflow } from '@openerp/shared';
import { prisma } from '../db/client.js';

let cached: JobWorkflow | null = null;

/**
 * Reads the catalogue straight from the database, bypassing the cache.
 *
 * `statuses` comes back ordered by `sort_order` and `transitions` by id, which
 * puts cancellation last - the order the pipeline has always presented.
 */
export async function readJobWorkflow(): Promise<JobWorkflow> {
  const [statuses, transitions] = await Promise.all([
    prisma.jobStatusDefinition.findMany({ orderBy: { sortOrder: 'asc' } }),
    prisma.jobTransitionDefinition.findMany({ orderBy: { id: 'asc' } }),
  ]);

  return {
    statuses: statuses.map((status) => ({
      key: status.key,
      label: status.label,
      sortOrder: status.sortOrder,
      isTerminal: status.isTerminal,
      editablePlanned: status.editablePlanned,
      editableActuals: status.editableActuals,
    })),
    transitions: transitions.map((transition) => ({
      from: transition.fromKey,
      to: transition.toKey,
      permission: transition.permission,
      reason: transition.reason,
    })),
  };
}

/** The cached workflow, loading it on first use. */
export async function loadJobWorkflow(): Promise<JobWorkflow> {
  if (!cached) cached = await readJobWorkflow();
  return cached;
}

/** Drops the cache. Called by every admin route that writes the catalogue. */
export function invalidateJobWorkflow(): void {
  cached = null;
}
