/**
 * Bootstraps the job status workflow.
 *
 * The workflow is admin-editable data, so this seed only ever *fills an empty
 * catalogue*. It never upserts: re-running after an administrator has renamed a
 * status, moved it in the pipeline or deleted an unused one must not resurrect
 * the default, exactly as `seedRolesAndPermissions` leaves customised non-admin
 * grants alone.
 *
 * There are two ways the tables get their rows, and both end here or at
 * migration `0007_job_workflow`:
 *
 *  - a migrated database (dev, production) gets them from the migration's SQL;
 *  - a `prisma db push` database (CI) has the tables created empty, and this
 *    seed fills them.
 *
 * The two must stay identical; `shared/src/job-status.ts` is the source of truth
 * for what "identical" means, and the migration mirrors `DEFAULT_JOB_WORKFLOW`.
 */
import { DEFAULT_JOB_WORKFLOW } from '@openerp/shared';

export async function seedJobWorkflow(prisma: {
  jobStatusDefinition: {
    count(): Promise<number>;
    createMany(args: {
      data: Array<{
        key: string;
        label: string;
        sortOrder: number;
        isTerminal: boolean;
        editablePlanned: boolean;
        editableActuals: boolean;
      }>;
    }): Promise<unknown>;
  };
  jobTransitionDefinition: {
    createMany(args: {
      data: Array<{ fromKey: string; toKey: string; permission: string; reason: string }>;
    }): Promise<unknown>;
  };
}): Promise<void> {
  const existing = await prisma.jobStatusDefinition.count();
  if (existing > 0) {
    console.log(`  job workflow   ${existing} statuses present; left untouched`);
    return;
  }

  await prisma.jobStatusDefinition.createMany({
    data: DEFAULT_JOB_WORKFLOW.statuses.map((status) => ({
      key: status.key,
      label: status.label,
      sortOrder: status.sortOrder,
      isTerminal: status.isTerminal,
      editablePlanned: status.editablePlanned,
      editableActuals: status.editableActuals,
    })),
  });

  await prisma.jobTransitionDefinition.createMany({
    data: DEFAULT_JOB_WORKFLOW.transitions.map((transition) => ({
      fromKey: transition.from,
      toKey: transition.to,
      permission: transition.permission,
      reason: transition.reason,
    })),
  });

  console.log(
    `  job workflow   ${DEFAULT_JOB_WORKFLOW.statuses.length} statuses and ` +
      `${DEFAULT_JOB_WORKFLOW.transitions.length} transitions provisioned`,
  );
}
