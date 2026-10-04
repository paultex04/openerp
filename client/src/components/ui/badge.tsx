import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';

const badgeVariants = cva(
  'group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a]:hover:bg-primary/80',
        secondary: 'bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80',
        destructive:
          'bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20',
        outline: 'border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground',
        ghost: 'hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50',
        link: 'text-primary underline-offset-4 hover:underline',

        // --- OpenERP lifecycle variants -------------------------------------
        // Added on top of the upstream set because the job and invoice
        // lifecycles need a colour per stage, and `destructive` alone cannot
        // express "in progress" or "awaiting approval". Declared here rather than
        // as bespoke classNames at call sites so every badge in the app agrees.
        //
        // Built from the semantic `--success` / `--warning` / `--info` tokens
        // rather than literal emerald/amber/sky ramps. Hardcoding those made the
        // badges ignore the active theme: they stayed emerald under Ember and
        // Verdant, and were unreadably dark under Midnight. Using the token for
        // the text and an alpha of the same token for the fill means one hue
        // drives both, so contrast holds in every theme, including dark ones -
        // and there is no separate `dark:` branch to keep in sync.
        //
        // The three are identical in shape on purpose. An earlier version needed
        // `dark:text-warning` because the light-theme warning sat at 3:1; the
        // token itself was darkened instead, so every variant is one rule.
        success: 'bg-success/15 text-success',
        warning: 'bg-warning/15 text-warning',
        info: 'bg-info/15 text-info',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant = 'default',
  render,
  ...props
}: useRender.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: 'span',
    props: mergeProps<'span'>(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props,
    ),
    render,
    state: {
      slot: 'badge',
      variant,
    },
  });
}

export { Badge, badgeVariants };
