'use client';

import type { TimesheetStatus } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { timesheetVariant } from '@/lib/lifecycle-status';

/**
 * The one place a timesheet's state is rendered, so a Draft week looks identical
 * in the grid, the approval queue and the job's labour panel. Colour comes from
 * the shared lifecycle map (`timesheetVariant`), never from a class here.
 */
export function TimesheetStatusBadge({
  status,
  className,
}: {
  status: TimesheetStatus | string;
  className?: string;
}) {
  return (
    <Badge variant={timesheetVariant(status)} className={className}>
      {status}
    </Badge>
  );
}
