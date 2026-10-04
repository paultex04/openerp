'use client';

/**
 * Shared data-grid primitives.
 *
 * Deliberately NOT in `components/ui/table.tsx`: that file is owned by the
 * shadcn registry and is replaced wholesale by `shadcn add table --overwrite`.
 * Anything OpenERP needs on top of the upstream table belongs here, so a
 * component update cannot silently delete it.
 */
import { TableCell } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * A table cell for money and quantities: right-aligned with tabular figures so
 * columns of numbers line up vertically and can be scanned.
 *
 * Every numeric cell in the app uses this rather than `TableCell` with an
 * ad-hoc class, which is how alignment drifted before.
 */
export function NumericCell({ className, ...props }: React.ComponentProps<typeof TableCell>) {
  return <TableCell className={cn('text-right font-mono tabular-nums', className)} {...props} />;
}
