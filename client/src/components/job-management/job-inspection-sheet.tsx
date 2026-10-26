'use client';

/**
 * Job Inspection Drawer (Slide-Over Peek).
 *
 * Linear/Vercel-style slide-over sheet allowing quick inspection of job details,
 * deliverables, assigned crew, and fast stage transitions without leaving
 * your place or scroll position in the Job Register.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight,
  Briefcase,
  Calendar,
  CheckCircle2,
  Clock,
  ExternalLink,
  MapPin,
  Tag,
  User,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { toast } from '@/components/ui/toast';
import { StatusPill } from '@/components/lifecycle/status-badge';
import { useJobWorkflow } from '@/hooks/use-job-workflow';
import { api, ApiError, type JobDetail, type TransitionOption } from '@/lib/api';
import { formatDate, formatZar } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface JobInspectionSheetProps {
  jobId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onJobUpdated?: () => void;
}

export function JobInspectionSheet({
  jobId,
  open,
  onOpenChange,
  onJobUpdated,
}: JobInspectionSheetProps) {
  const queryClient = useQueryClient();
  const { label } = useJobWorkflow();

  const jobQuery = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.get<JobDetail>(`/api/jobs/${jobId}`),
    enabled: Boolean(jobId && open),
  });

  const transitionsQuery = useQuery({
    queryKey: ['job-transitions', jobId],
    queryFn: () =>
      api.get<{ from: string; transitions: TransitionOption[] }>(
        `/api/jobs/${jobId}/transitions`,
      ),
    enabled: Boolean(jobId && open),
  });

  const moveMutation = useMutation({
    mutationFn: (to: string) =>
      api.post(`/api/jobs/${jobId}/transition`, { status: to }),
    onSuccess: (_result, to) => {
      toast.add({ title: `Moved to ${label(to)}`, type: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      void queryClient.invalidateQueries({ queryKey: ['job-transitions', jobId] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      onJobUpdated?.();
    },
    onError: (error: Error) => {
      toast.add({
        title: 'Could not change status',
        description:
          error instanceof ApiError ? error.message : 'Stage transition was refused.',
        type: 'error',
      });
    },
  });

  const detail = jobQuery.data;
  const job = detail?.job;
  const deliverables = detail?.deliverables ?? [];
  const summary = detail?.summary;
  const legalTransitions = (transitionsQuery.data?.transitions ?? []).filter(
    (t) => t.allowed,
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl md:max-w-2xl overflow-y-auto p-0 flex flex-col bg-background/95 backdrop-blur-md border-l shadow-2xl"
      >
        {jobQuery.isLoading || !job ? (
          <div className="p-6 space-y-6">
            <div className="flex items-center justify-between border-b pb-4">
              <Skeleton className="h-7 w-32" />
              <Skeleton className="h-8 w-28" />
            </div>
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <>
            {/* Header */}
            <SheetHeader className="border-b p-5 pb-4 bg-card/60 sticky top-0 z-20 backdrop-blur-md">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <SheetTitle className="font-mono text-xl font-bold tracking-tight">
                      Job #{job.id}
                    </SheetTitle>
                    <StatusPill status={job.status} />
                    {job.priority && (
                      <Badge
                        variant={
                          job.priority === 'High'
                            ? 'destructive'
                            : job.priority === 'Medium'
                              ? 'warning'
                              : 'secondary'
                        }
                        className="text-[10px] uppercase font-mono px-1.5"
                      >
                        {job.priority}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {job.project.contract.client.name} · Contract{' '}
                    <span className="font-mono">{job.project.contract.number}</span>
                  </p>
                </div>

                <Link
                  href={`/operations/${job.id}`}
                  className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-medium text-foreground shadow-xs hover:bg-accent transition-colors"
                >
                  <span>Open workspace</span>
                  <ExternalLink className="size-3 text-muted-foreground" />
                </Link>
              </div>
            </SheetHeader>

            <div className="p-6 space-y-6 flex-1">
              {/* Description */}
              {job.description && (
                <div className="rounded-lg border bg-card/40 p-3.5 text-sm text-foreground/90">
                  <p className="text-xs font-semibold text-muted-foreground mb-1">
                    Scope Description
                  </p>
                  <p className="leading-relaxed">{job.description}</p>
                </div>
              )}

              {/* Fast Status Transition */}
              {legalTransitions.length > 0 && (
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3.5 space-y-2">
                  <span className="text-xs font-medium text-primary flex items-center gap-1.5">
                    <CheckCircle2 className="size-3.5" />
                    Quick Stage Transition
                  </span>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {legalTransitions.map((t) => (
                      <Button
                        key={t.to}
                        size="sm"
                        variant="outline"
                        disabled={moveMutation.isPending}
                        onClick={() => moveMutation.mutate(t.to)}
                        className="h-7 text-xs bg-background hover:bg-primary hover:text-primary-foreground transition-all"
                      >
                        Move to {label(t.to)}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {/* Facts Grid */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <FactCard
                  icon={Briefcase}
                  label="Work Order"
                  value={job.workOrder ?? '—'}
                  isMono
                />
                <FactCard
                  icon={Tag}
                  label="Purchase Order"
                  value={job.purchaseOrder ?? '—'}
                  isMono
                />
                <FactCard
                  icon={MapPin}
                  label="Area / Section"
                  value={job.area ?? '—'}
                />
                <FactCard
                  icon={User}
                  label="Supervisor"
                  value={
                    job.supervisor
                      ? `${job.supervisor.name} ${job.supervisor.surname}`
                      : 'Unassigned'
                  }
                />
                <FactCard
                  icon={Calendar}
                  label="Planned Window"
                  value={
                    job.plannedStartDate && job.plannedEndDate
                      ? `${formatDate(job.plannedStartDate)} → ${formatDate(job.plannedEndDate)}`
                      : 'Not set'
                  }
                />
                <FactCard
                  icon={Clock}
                  label="Actual Window"
                  value={
                    job.actualStartDate
                      ? `${formatDate(job.actualStartDate)} → ${job.actualEndDate ? formatDate(job.actualEndDate) : 'In progress'}`
                      : 'Not started'
                  }
                />
              </div>

              {/* Financial Snapshot */}
              {summary && (
                <div className="rounded-lg border bg-card p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Valuation & Variance (Excl. VAT)
                    </span>
                    <span
                      className={cn(
                        'text-xs font-mono font-semibold',
                        summary.valueVariance > 0
                          ? 'text-negative'
                          : summary.valueVariance < 0
                            ? 'text-positive'
                            : 'text-muted-foreground',
                      )}
                    >
                      Variance: {formatZar(summary.valueVariance)}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1 text-xs">
                    <div className="rounded bg-muted/40 p-2">
                      <p className="text-[11px] text-muted-foreground">Planned Value</p>
                      <p className="font-mono font-medium">{formatZar(summary.plannedSubtotal)}</p>
                    </div>
                    <div className="rounded bg-muted/40 p-2">
                      <p className="text-[11px] text-muted-foreground">Actual Value</p>
                      <p className="font-mono font-medium">{formatZar(summary.actualSubtotal)}</p>
                    </div>
                    <div className="rounded bg-muted/40 p-2">
                      <p className="text-[11px] text-muted-foreground">Deliverables Progress</p>
                      <p className="font-mono font-medium">
                        {summary.linesWithActuals} / {summary.lineCount} lines
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Deliverables Breakdown */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Deliverables ({deliverables.length})
                  </h3>
                  <Link
                    href={`/operations/${job.id}`}
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                  >
                    View all line items
                    <ArrowUpRight className="size-3" />
                  </Link>
                </div>

                {deliverables.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic rounded border border-dashed p-4 text-center">
                    No deliverables attached to this job yet.
                  </p>
                ) : (
                  <div className="rounded-lg border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50 border-b text-muted-foreground font-medium">
                        <tr>
                          <th className="py-2 px-3 text-left">Code</th>
                          <th className="py-2 px-3 text-left">Description</th>
                          <th className="py-2 px-3 text-right">Plan Qty</th>
                          <th className="py-2 px-3 text-right">Act Qty</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/60">
                        {deliverables.slice(0, 6).map((deliv) => (
                          <tr key={deliv.id} className="hover:bg-muted/30">
                            <td className="py-2 px-3 font-mono font-medium">
                              {deliv.code}
                            </td>
                            <td className="py-2 px-3 truncate max-w-48" title={deliv.description}>
                              {deliv.description}
                            </td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums">
                              {deliv.plannedQuantity} {deliv.uom}
                            </td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums">
                              {deliv.actualQuantity} {deliv.uom}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {deliverables.length > 6 && (
                      <div className="p-2 text-center border-t bg-muted/20 text-[11px] text-muted-foreground">
                        + {deliverables.length - 6} more deliverables
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Assigned Crew */}
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <Users className="size-3.5" />
                  Assigned Crew ({(job.assignments ?? []).length})
                </h3>
                {(job.assignments ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground italic rounded border border-dashed p-3">
                    No crew assigned yet.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {job.assignments.map((assignment) => (
                      <span
                        key={assignment.id}
                        className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-1 text-xs"
                      >
                        <User className="size-3 text-muted-foreground" />
                        <span className="font-medium">
                          {assignment.employee.name} {assignment.employee.surname}
                        </span>
                        {assignment.role && (
                          <span className="text-[10px] text-muted-foreground">
                            ({assignment.role})
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function FactCard({
  icon: Icon,
  label,
  value,
  isMono = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  isMono?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-card/60 p-2.5 space-y-1">
      <div className="flex items-center gap-1.5 text-muted-foreground text-[11px]">
        <Icon className="size-3" />
        <span>{label}</span>
      </div>
      <p
        className={cn(
          'text-xs font-medium truncate',
          isMono && 'font-mono text-[11px]',
        )}
        title={value}
      >
        {value}
      </p>
    </div>
  );
}
