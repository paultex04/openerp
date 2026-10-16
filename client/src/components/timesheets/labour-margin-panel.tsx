'use client';

/**
 * Labour & margin for one job, on the job screen.
 *
 * This is the only place the two halves of the system meet: the commercial side
 * (what the job was priced at, and what has been invoiced) and the timesheet side
 * (what it cost in hours and materials). It reads `GET /api/costing/jobs/:jobId`
 * and displays; it writes nothing, which is the arrow the module is built around —
 * job management owns revenue, timesheets own hours, costing reads both.
 *
 * Rendered only for a viewer holding `timesheet.read`; a supervisor who cannot see
 * cost is not shown a panel of zeros.
 */
import { useQuery } from '@tanstack/react-query';
import { api, type JobCosting } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usePermissions } from '@/components/auth/usePermissions';
import { formatNumber, formatPercent, formatZar } from '@/lib/format';
import { cn } from '@/lib/utils';

function Figure({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs tracking-wide text-muted-foreground uppercase">{label}</span>
      <span className={cn('tabular-nums', tone ?? 'font-medium')}>{value}</span>
    </div>
  );
}

/** Over budget is the bad direction for a cost variance, so the tone is inverted. */
function costTone(variance: number): string {
  if (Math.abs(variance) < 0.005) return 'text-muted-foreground';
  return variance > 0 ? 'text-negative' : 'text-positive';
}

export function LabourMarginPanel({ jobId }: { jobId: number }) {
  const { can } = usePermissions();
  const allowed = can('timesheet.read');

  const query = useQuery({
    queryKey: ['costing', 'job', jobId],
    queryFn: () => api.get<{ job: JobCosting }>(`/api/costing/jobs/${jobId}`),
    enabled: allowed,
  });

  if (!allowed) return null;

  const costing = query.data?.job;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Labour &amp; margin</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {query.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !costing ? (
          <p className="text-sm text-muted-foreground">
            Costing is unavailable for this job right now.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Figure
                label="Hours"
                value={`${formatNumber(costing.hoursActual)} of ${formatNumber(
                  costing.hoursPlanned,
                )} planned`}
              />
              <Figure
                label="Labour cost"
                value={formatZar(costing.labourCostActual)}
                tone={costTone(costing.costVariance)}
              />
              <Figure label="Material cost" value={formatZar(costing.materialCostActual)} />
              <Figure label="Revenue (work done)" value={formatZar(costing.revenueActual)} />
              <Figure
                label="Margin"
                value={formatZar(costing.grossMargin)}
                tone={
                  costing.grossMargin < 0
                    ? 'text-negative font-medium'
                    : costing.grossMargin > 0
                      ? 'text-positive font-medium'
                      : 'text-muted-foreground'
                }
              />
              <Figure
                label="Margin %"
                value={costing.revenueActual === 0 ? '—' : formatPercent(costing.grossMarginPct)}
              />
              <Figure label="Invoiced" value={formatZar(costing.revenueInvoiced)} />
              <Figure
                label="Cost vs plan"
                value={formatZar(costing.costVariance)}
                tone={costTone(costing.costVariance)}
              />
            </div>

            {costing.byLabourType.length > 0 && (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full caption-bottom text-sm">
                  <caption className="sr-only">Labour by type: planned against actual</caption>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Labour type</TableHead>
                      <TableHead scope="col">Shift</TableHead>
                      <TableHead scope="col" className="text-right">
                        Hours planned
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        Hours actual
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        Cost planned
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        Cost actual
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        Variance
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {costing.byLabourType.map((group) => (
                      <TableRow key={`${group.labourType}-${group.shiftType}`}>
                        <TableCell className="font-medium">{group.labourType}</TableCell>
                        <TableCell>{group.shiftType}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatNumber(group.hoursPlanned)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatNumber(group.hoursActual)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatZar(group.costPlanned)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatZar(group.costActual)}
                        </TableCell>
                        <TableCell
                          className={cn('text-right tabular-nums', costTone(group.costVariance))}
                        >
                          {formatZar(group.costVariance)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
