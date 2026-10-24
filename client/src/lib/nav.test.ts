import { describe, expect, it } from 'vitest';
import { breadcrumbFor, visibleSections } from './nav';

describe('navigation model', () => {
  describe('visibleSections', () => {
    it('returns empty array when user has no permissions', () => {
      const sections = visibleSections([]);
      expect(sections).toEqual([]);
    });

    it('filters out sections whose items are all unauthorized', () => {
      const sections = visibleSections(['ratemaster.read']);
      expect(sections.length).toBeGreaterThan(0);
      expect(sections.some((s) => s.key === 'commercial')).toBe(true);
      expect(sections.some((s) => s.key === 'administration')).toBe(false);
    });

    it('shows administration section when user holds admin permissions', () => {
      const sections = visibleSections(['admin.user.read', 'admin.role.read']);
      expect(sections.some((s) => s.key === 'administration')).toBe(true);
    });
  });

  describe('breadcrumbFor', () => {
    it('resolves billing root correctly', () => {
      const crumb = breadcrumbFor('/billing', '');
      expect(crumb).not.toBeNull();
      expect(crumb?.section.key).toBe('billing');
      expect(crumb?.item.label).toBe('Invoice Register');
    });

    it('resolves tab-specific items over general path items', () => {
      const crumb = breadcrumbFor('/commercial', 'tab=recipes');
      expect(crumb).not.toBeNull();
      expect(crumb?.item.href).toContain('tab=recipes');
    });

    it('normalizes detail routes under operations', () => {
      const crumb = breadcrumbFor('/operations/123', '');
      expect(crumb).not.toBeNull();
      expect(crumb?.section.key).toBe('operations');
    });

    it('returns null for unknown routes', () => {
      const crumb = breadcrumbFor('/unknown-path', '');
      expect(crumb).toBeNull();
    });
  });
});
