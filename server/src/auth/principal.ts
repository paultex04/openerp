/**
 * Resolving the authenticated principal.
 *
 * `resolvePrincipal` is the only place that turns a verified token into a
 * principal. It re-reads the user from the database on every request rather
 * than trusting role claims baked into the JWT, so that deactivating a user or
 * revoking a role takes effect immediately instead of when the token happens
 * to expire.
 */
import type { AppRoleModel as AppRole } from '../generated/prisma/models/AppRole.js';
import { prisma } from '../db/client.js';
import { effectivePermissions } from '@openerp/shared';
import type { TokenClaims } from './tokens.js';

export interface Principal {
  userId: number;
  employeeId: number;
  email: string;
  isActive: boolean;
  tokenVersion: number;
  roleKeys: string[];
  permissions: Set<string>;
  employee: {
    id: number;
    name: string;
    surname: string;
    email: string | null;
  };
}

/** Raised when a token is valid but the account can no longer be used. */
export class PrincipalError extends Error {
  constructor(
    message: string,
    readonly code: 'user_not_found' | 'user_inactive' | 'no_roles' | 'stale_token_version',
  ) {
    super(message);
    this.name = 'PrincipalError';
  }
}

export async function resolvePrincipal(claims: TokenClaims): Promise<Principal> {
  const user = await prisma.appUser.findUnique({
    where: { id: claims.userId },
    select: {
      id: true,
      employeeId: true,
      email: true,
      isActive: true,
      tokenVersion: true,
      employee: {
        select: { id: true, name: true, surname: true, email: true },
      },
      roles: {
        select: { role: { select: { key: true, name: true } } },
      },
    },
  });

  if (!user) {
    throw new PrincipalError('Account no longer exists.', 'user_not_found');
  }

  if (!user.isActive) {
    throw new PrincipalError('Account is deactivated.', 'user_inactive');
  }

  if (user.tokenVersion !== claims.tokenVersion) {
    // Password changed after this token was minted.
    throw new PrincipalError('Session is no longer valid.', 'stale_token_version');
  }

  const roleKeys = user.roles.map((r) => r.role.key);

  if (roleKeys.length === 0) {
    // An authenticated user with no roles can do nothing. Rejecting early gives
    // a clearer signal than letting every subsequent check fail with 403.
    throw new PrincipalError('Account has no roles assigned.', 'no_roles');
  }

  return {
    userId: user.id,
    employeeId: user.employeeId,
    email: user.email,
    isActive: user.isActive,
    tokenVersion: user.tokenVersion,
    roleKeys,
    permissions: effectivePermissions(roleKeys),
    employee: user.employee,
  };
}

export type RoleWithKey = Pick<AppRole, 'key' | 'name'>;
