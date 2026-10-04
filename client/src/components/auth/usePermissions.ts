'use client';

/**
 * Permission helpers for the client.
 *
 * The permission list comes from `/api/auth/me` and is the *same* catalogue the
 * API guard enforces (`@openerp/shared`). It exists so the UI can hide controls
 * the server would refuse; it is never treated as a security boundary.
 */
import { useQuery } from '@tanstack/react-query';
import { api, type CurrentUser } from '@/lib/api';
import type { ReactNode } from 'react';

export function useCurrentUser() {
  return useQuery({
    queryKey: ['current-user'],
    queryFn: () => api.get<CurrentUser>('/api/auth/me'),
    // A 401 simply means "not signed in", which is a normal state, not an error
    // to surface to the user.
    retry: false,
  });
}

export interface PermissionsState {
  permissions: string[];
  roles: string[];
  user: CurrentUser | null;
  loading: boolean;
  can: (permission: string) => boolean;
  canAny: (...permissions: string[]) => boolean;
  canAll: (...permissions: string[]) => boolean;
}

export function usePermissions(): PermissionsState {
  const { data, isLoading } = useCurrentUser();

  const permissions = data?.permissions ?? [];
  const set = new Set(permissions);

  return {
    permissions,
    roles: (data?.roles ?? []).map((r) => r.key),
    user: data ?? null,
    loading: isLoading,
    can: (permission: string) => set.has(permission),
    canAny: (...required: string[]) => required.some((p) => set.has(p)),
    canAll: (...required: string[]) => required.every((p) => set.has(p)),
  };
}

/**
 * Renders `children` only when the user holds every listed permission.
 *
 * Complements, rather than replaces, the API guard: the server always refuses,
 * this simply avoids showing a control that cannot succeed.
 */
export function Can({
  permissions,
  children,
  fallback = null,
}: {
  permissions: string[];
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { canAll, loading } = usePermissions();
  if (loading) return null;
  return canAll(...permissions) ? children : fallback;
}
