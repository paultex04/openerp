import { describe, expect, it } from 'vitest';
import { findMatchingRouteRule } from './route-rules';

describe('Route Rules Authorization Policies', () => {
  it('correctly maps all administrative paths to administration rule', () => {
    const ruleRoot = findMatchingRouteRule('/admin');
    expect(ruleRoot).not.toBeNull();
    expect(ruleRoot?.prefix).toBe('/admin');
    expect(ruleRoot?.name).toBe('Administration');
    expect(ruleRoot?.requiredRoles).toContain('Administrator');

    const ruleSub = findMatchingRouteRule('/admin/users');
    expect(ruleSub).not.toBeNull();
    expect(ruleSub?.prefix).toBe('/admin');
  });

  it('correctly distinguishes /timesheets/crew-matrix from /timesheets using longest prefix', () => {
    const crewRule = findMatchingRouteRule('/timesheets/crew-matrix');
    expect(crewRule).not.toBeNull();
    expect(crewRule?.prefix).toBe('/timesheets/crew-matrix');
    expect(crewRule?.name).toBe('Crew Timesheet Matrix');

    const timesheetRule = findMatchingRouteRule('/timesheets');
    expect(timesheetRule).not.toBeNull();
    expect(timesheetRule?.prefix).toBe('/timesheets');
    expect(timesheetRule?.name).toBe('Timesheets');
  });

  it('correctly identifies commercial and billing routes', () => {
    const commercialRule = findMatchingRouteRule('/commercial');
    expect(commercialRule?.name).toBe('Commercial & Contracts');
    expect(commercialRule?.anyOf).toContain('contract.read');

    const billingRule = findMatchingRouteRule('/billing');
    expect(billingRule?.name).toBe('Billing & Finance');
    expect(billingRule?.anyOf).toContain('invoice.read');
  });

  it('returns null for public/unrestricted routes like /dashboard and /profile', () => {
    expect(findMatchingRouteRule('/dashboard')).toBeNull();
    expect(findMatchingRouteRule('/profile')).toBeNull();
  });
});
