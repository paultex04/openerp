import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'react';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'text-foreground',
        success: 'border-transparent bg-emerald-100 text-emerald-900',
        warning: 'border-transparent bg-amber-100 text-amber-900',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** Colour-codes a job/amendment/invoice status label by its lifecycle position. */
export function statusVariant(status: string): BadgeProps['variant'] {
  const s = status.toLowerCase();
  if (s.includes('cancelled') || s.includes('terminated') || s.includes('disputed')) {
    return 'destructive';
  }
  if (s.includes('active') || s.includes('approved') || s.includes('paid')) return 'success';
  if (s.includes('draft') || s.includes('pending') || s.includes('partial')) return 'warning';
  return 'secondary';
}

export { badgeVariants };
