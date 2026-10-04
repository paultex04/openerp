import { JOB_STATUSES } from '@openerp/shared';

/**
 * The 13 job statuses in pipeline order, for the stepper and kanban board.
 *
 * Re-exported straight from the shared state machine rather than redeclared, so
 * the UI can never drift from the transitions the API enforces.
 */
export { JOB_STATUSES };
