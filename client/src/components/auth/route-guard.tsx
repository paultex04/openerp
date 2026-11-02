'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { usePermissions } from '@/components/auth/usePermissions';
import { AccessDenied } from '@/components/auth/access-denied';
import { Spinner } from '@/components/ui/spinner';
import { findMatchingRouteRule } from '@/lib/route-rules';

export function RouteGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { permissions, loading } = usePermissions();

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Spinner className="size-6 text-muted-foreground" />
        <span className="sr-only">Checking permissions…</span>
      </div>
    );
  }

  const rule = findMatchingRouteRule(pathname);
  if (!rule) {
    return <>{children}</>;
  }

  const hasAccess = rule.anyOf.some((p) => permissions.includes(p));
  if (!hasAccess) {
    return (
      <AccessDenied
        title={`${rule.name} Access Required`}
        message={`Your account does not have permission to access the ${rule.name} module. Contact your system administrator to request access.`}
        requiredRoles={rule.requiredRoles}
        requiredPermissions={rule.anyOf}
        returnHref="/dashboard"
        returnLabel="Return to Dashboard"
      />
    );
  }

  return <>{children}</>;
}
