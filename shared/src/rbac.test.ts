import { describe, expect, it } from 'vitest';
import {
  effectivePermissions,
  hasPermission,
  isScopedToAssignedJobs,
  PERMISSION_KEYS,
  ROLE_ADMINISTRATOR,
  ROLE_BILLING_CLERK,
  ROLE_COMMERCIAL_QS,
  ROLE_KEYS,
  ROLE_PERMISSIONS,
  ROLE_PROJECT_MANAGER,
  ROLE_SITE_SUPERVISOR,
  ROLES,
} from './rbac.js';

describe('RBAC catalogue integrity', () => {
  it('defines exactly the five specified roles', () => {
    expect([...ROLE_KEYS].sort()).toEqual(
      [
        ROLE_ADMINISTRATOR,
        ROLE_BILLING_CLERK,
        ROLE_COMMERCIAL_QS,
        ROLE_PROJECT_MANAGER,
        ROLE_SITE_SUPERVISOR,
      ].sort(),
    );
  });

  it('gives every role a definition with a description', () => {
    for (const role of ROLES) {
      expect(role.description.length).toBeGreaterThan(20);
    }
  });

  it('grants every role only permissions that exist in the catalogue', () => {
    const known = new Set<string>(PERMISSION_KEYS);
    for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
      for (const permission of grants) {
        expect(known, `${role} grants unknown permission ${permission}`).toContain(permission);
      }
    }
  });

  it('defines grants for every declared role', () => {
    for (const role of ROLE_KEYS) {
      expect(ROLE_PERMISSIONS[role], `no grants for ${role}`).toBeDefined();
    }
  });

  it('has no duplicate permission keys', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  it('gives the administrator every permission', () => {
    expect([...(ROLE_PERMISSIONS[ROLE_ADMINISTRATOR] ?? [])].sort()).toEqual(
      [...PERMISSION_KEYS].sort(),
    );
  });
});

describe('role separation (RBAC matrix)', () => {
  it('lets QS edit rate components', () => {
    expect(hasPermission([ROLE_COMMERCIAL_QS], 'ratemaster.write')).toBe(true);
  });

  it('stops a field supervisor editing rate components', () => {
    expect(hasPermission([ROLE_SITE_SUPERVISOR], 'ratemaster.write')).toBe(false);
    expect(hasPermission([ROLE_SITE_SUPERVISOR], 'servicecode.write')).toBe(false);
  });

  it('stops a field supervisor editing planned quantities but allows actuals', () => {
    expect(hasPermission([ROLE_SITE_SUPERVISOR], 'deliverable.write.planned')).toBe(false);
    expect(hasPermission([ROLE_SITE_SUPERVISOR], 'deliverable.write.actual')).toBe(true);
  });

  it('restricts the field supervisor to assigned jobs only', () => {
    expect(hasPermission([ROLE_SITE_SUPERVISOR], 'job.read.assigned')).toBe(true);
    expect(hasPermission([ROLE_SITE_SUPERVISOR], 'job.read')).toBe(false);
    expect(isScopedToAssignedJobs([ROLE_SITE_SUPERVISOR])).toBe(true);
  });

  it('lets the PM scope jobs but not touch commercial pricing', () => {
    expect(hasPermission([ROLE_PROJECT_MANAGER], 'deliverable.write.planned')).toBe(true);
    expect(hasPermission([ROLE_PROJECT_MANAGER], 'job.transition.scope')).toBe(true);
    expect(hasPermission([ROLE_PROJECT_MANAGER], 'ratemaster.write')).toBe(false);
    expect(hasPermission([ROLE_PROJECT_MANAGER], 'contract.write')).toBe(false);
  });

  it('gives billing read-only operations plus full billing control', () => {
    expect(hasPermission([ROLE_BILLING_CLERK], 'job.read')).toBe(true);
    expect(hasPermission([ROLE_BILLING_CLERK], 'job.write')).toBe(false);
    expect(hasPermission([ROLE_BILLING_CLERK], 'deliverable.write.planned')).toBe(false);
    expect(hasPermission([ROLE_BILLING_CLERK], 'invoice.write')).toBe(true);
    expect(hasPermission([ROLE_BILLING_CLERK], 'invoice.approve')).toBe(true);
    expect(hasPermission([ROLE_BILLING_CLERK], 'job.transition.invoice')).toBe(true);
  });

  it('stops a billing clerk reaching administration', () => {
    expect(hasPermission([ROLE_BILLING_CLERK], 'admin.user.write')).toBe(false);
  });

  it('never grants invoice authority to the field supervisor', () => {
    expect(hasPermission([ROLE_SITE_SUPERVISOR], 'invoice.write')).toBe(false);
    expect(hasPermission([ROLE_SITE_SUPERVISOR], 'job.transition.invoice')).toBe(false);
  });
});

describe('multi-role union', () => {
  it('combines the permissions of every role held', () => {
    const combined = effectivePermissions([ROLE_SITE_SUPERVISOR, ROLE_BILLING_CLERK]);
    expect(combined.has('deliverable.write.actual')).toBe(true); // supervisor
    expect(combined.has('invoice.write')).toBe(true); // billing
    expect(combined.has('ratemaster.write')).toBe(false); // neither
  });

  it('widens visibility when a supervisor also holds a read-all role', () => {
    // Holding billing as well means the "assigned jobs only" restriction no
    // longer applies, because that role grants the general job.read.
    expect(isScopedToAssignedJobs([ROLE_SITE_SUPERVISOR])).toBe(true);
    expect(isScopedToAssignedJobs([ROLE_SITE_SUPERVISOR, ROLE_BILLING_CLERK])).toBe(false);
  });

  it('returns an empty set for no roles', () => {
    expect(effectivePermissions([]).size).toBe(0);
  });
});
