import { Badge } from '@/components/ui/badge';
import { statusVariant } from '@/lib/lifecycle-status';
import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'react';

/**
 * Status presentation helpers.
 *
 * The colour decision itself lives in `lifecycle-status.tsx`; this module only
 * handles presentation. Keeping them apart means a status can be recoloured
 * without touching a component, and no component can invent its own palette.
 */

/**
 * Text tone for a variance figure: neutral when nil, red over, green under.
 *
 * Uses the `--negative` / `--positive` tokens rather than a literal
 * `text-emerald-700 dark:text-red-700` pair. That literal was correct in exactly
 * two of the five themes and wrong in the other three, because it hardcoded the
 * light and dark ramp while the surface around it came from the active theme.
 */
export function varianceTone(value: number): string {
  if (Math.abs(value) < 0.005) return 'text-muted-foreground';
  return value > 0 ? 'text-negative' : 'text-positive';
}

/**
 * Compact status pill for use inside dense tables, where a full-size `Badge` is
 * too heavy. Still derives its colour from the shared lifecycle map, so a job
 * looks identical in the stepper, the board and the register.
 */
export function StatusPill({ status, className }: { status: string; className?: string }) {
  return (
    <Badge variant={statusVariant(status)} className={cn('px-1.5 text-[10px]', className)}>
      {status}
    </Badge>
  );
}

/** Extracts the numeric prefix (e.g. "01A") from a status label, for sorting. */
export function statusOrdinal(status: string): string {
  const match = /^(\d+[A-Z]?)/.exec(status);
  return match?.[1] ?? '99';
}

/**
 * Group heading for register sections.
 *
 * Sizing and tone live here rather than in a dozen `className` strings, which is
 * what let section headings drift apart page to page.
 */
export function SectionHeading({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn(
        'text-xs font-semibold tracking-wide text-muted-foreground uppercase',
        className,
      )}
      {...props}
    />
  );
}
