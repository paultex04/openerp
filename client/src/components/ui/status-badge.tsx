import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'react';

/**
 * Status-aware colour for a job lifecycle label.
 *
 * Shared by the stepper, kanban and detail views so a status always looks the
 * same wherever it appears.
 */
export function statusVariant(
  status: string,
): 'default' | 'secondary' | 'destructive' | 'success' | 'warning' {
  const s = status.toLowerCase();
  if (s.includes('cancel')) return 'destructive';
  if (s.includes('invoiced')) return 'success';
  if (s.includes('wip') || s.includes('actuals') || s.includes('change order')) return 'warning';
  if (s.includes('scoping') || s.includes('awaiting') || s.includes('partially'))
    return 'secondary';
  return 'default';
}

/** Text tone for a variance figure. */
export function varianceTone(value: number): string {
  if (Math.abs(value) < 0.005) return 'text-muted-foreground';
  return value > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400';
}

/** Compact status pill used inside dense tables. */
export function StatusPill({ status, className }: { status: string; className?: string }) {
  const variant = statusVariant(status);
  const tone =
    variant === 'destructive'
      ? 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100'
      : variant === 'success'
        ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100'
        : variant === 'warning'
          ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100'
          : variant === 'secondary'
            ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
            : 'bg-primary text-primary-foreground';

  return (
    <span
      className={cn(
        'inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium',
        tone,
        className,
      )}
    >
      {status}
    </span>
  );
}

/** Extracts the numeric prefix (e.g. "01A") from a status label, for sorting. */
export function statusOrdinal(status: string): string {
  const match = /^(\d+[A-Z]?)/.exec(status);
  return match?.[1] ?? '99';
}

/** Group heading styling for dashboard sections. */
export function SectionHeading({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-sm font-semibold', className)} {...props} />;
}
