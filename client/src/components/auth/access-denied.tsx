'use client';

import { ArrowLeft, Home, Lock, ShieldAlert, UserRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { usePermissions } from '@/components/auth/usePermissions';
import { cn } from '@/lib/utils';

export interface AccessDeniedProps {
  /** Main heading on the card (default: "Access Restricted") */
  title?: string;
  /** Explanatory message explaining why the route/module is gated */
  message?: string;
  /** Role names required for access (e.g. ['Administrator', 'Commercial / QS']) */
  requiredRoles?: readonly string[];
  /** Permission keys required for access (e.g. ['invoice.read']) */
  requiredPermissions?: readonly string[];
  /** Destination for the primary return button (default: "/dashboard") */
  returnHref?: string;
  /** Label for the primary return button (default: "Return to Dashboard") */
  returnLabel?: string;
  /** Whether to show the secondary "Go Back" button (default: true) */
  showBackButton?: boolean;
  /** Optional incident code or request ID */
  incidentRef?: string;
  /** Optional container class name override */
  className?: string;
}

function humanizeRole(roleKey: string): string {
  const ACRONYMS = new Set(['qs', 'ecn', 'ie']);
  return roleKey
    .split('_')
    .map((part) =>
      ACRONYMS.has(part.toLowerCase()) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(' ');
}

export function AccessDenied({
  title = 'Access Restricted',
  message = 'You do not have the required permissions or roles to access this area.',
  requiredRoles,
  requiredPermissions,
  returnHref = '/dashboard',
  returnLabel = 'Return to Dashboard',
  showBackButton = true,
  incidentRef,
  className,
}: AccessDeniedProps) {
  const router = useRouter();
  const { user, roles } = usePermissions();

  const userEmail = user?.user.email;
  const currentRoleLabels =
    user?.roles?.map((r) => r.name).filter(Boolean) ??
    roles.map(humanizeRole);

  const handleReturn = () => {
    router.push(returnHref);
  };

  const handleBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
    } else {
      router.push(returnHref);
    }
  };

  return (
    <div
      role="region"
      aria-label="Access Restricted"
      className={cn(
        'flex min-h-[75vh] w-full items-center justify-center p-4 sm:p-8 animate-in fade-in-50 duration-200',
        className,
      )}
    >
      <div className="relative w-full max-w-lg rounded-3xl border border-border/80 bg-card/85 backdrop-blur-xl p-7 sm:p-9 shadow-2xl overflow-hidden text-center space-y-6">
        {/* Specular highlight matching error.tsx aesthetic */}
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-500/60 to-transparent" />

        {/* Security badge icon */}
        <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/20 shadow-sm">
          <ShieldAlert className="size-7" />
        </div>

        {/* Header copy */}
        <div className="space-y-2">
          <h2 className="text-xl font-bold tracking-tight text-foreground">{title}</h2>
          <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed max-w-md mx-auto">
            {message}
          </p>
        </div>

        {/* Access Diagnostics / Account Context */}
        <div className="rounded-2xl border border-border/70 bg-muted/40 p-4 text-left space-y-3">
          {/* Current Account */}
          <div className="flex items-center justify-between text-xs border-b border-border/50 pb-2.5">
            <span className="text-muted-foreground font-medium flex items-center gap-1.5">
              <UserRound className="size-3.5" />
              Current Account
            </span>
            <span className="font-mono font-medium text-foreground truncate max-w-[220px]">
              {userEmail || 'Active Session'}
            </span>
          </div>

          {/* Current Roles */}
          <div className="space-y-1.5 text-xs">
            <span className="text-muted-foreground font-medium">Your Active Roles</span>
            <div className="flex flex-wrap gap-1.5">
              {currentRoleLabels.length > 0 ? (
                currentRoleLabels.map((role) => (
                  <span
                    key={role}
                    className="inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground"
                  >
                    {role}
                  </span>
                ))
              ) : (
                <span className="text-muted-foreground italic text-[11px]">No roles assigned</span>
              )}
            </div>
          </div>

          {/* Access Requirements (when declared) */}
          {((requiredRoles && requiredRoles.length > 0) ||
            (requiredPermissions && requiredPermissions.length > 0)) && (
            <div className="space-y-1.5 text-xs border-t border-border/50 pt-2.5">
              <span className="text-muted-foreground font-medium flex items-center gap-1.5">
                <Lock className="size-3.5 text-amber-600 dark:text-amber-400" />
                Required Access
              </span>
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {requiredRoles?.map((r) => (
                  <span
                    key={r}
                    className="inline-flex items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
                  >
                    Role: {r}
                  </span>
                ))}
                {requiredPermissions?.map((p) => (
                  <code
                    key={p}
                    className="inline-flex items-center rounded-md border border-border/80 bg-background/80 px-2 py-0.5 font-mono text-[11px] text-foreground"
                  >
                    {p}
                  </code>
                ))}
              </div>
            </div>
          )}

          {/* Incident / Diagnostic Ref */}
          {incidentRef && (
            <div className="border-t border-border/50 pt-2 text-[10.5px] font-mono text-muted-foreground">
              Incident Ref: <span className="text-primary font-medium">{incidentRef}</span>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
          <Button
            type="button"
            variant="default"
            size="default"
            onClick={handleReturn}
            className="flex-1 cursor-pointer gap-2 text-xs font-semibold rounded-xl"
          >
            <Home className="size-4" />
            {returnLabel}
          </Button>

          {showBackButton && (
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={handleBack}
              className="flex-1 cursor-pointer gap-2 text-xs font-medium rounded-xl border-border/80"
            >
              <ArrowLeft className="size-4" />
              Go Back
            </Button>
          )}
        </div>

        {/* Support Footnote */}
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Need access to this module? Contact your system administrator to adjust your role assignments.
        </p>
      </div>
    </div>
  );
}
