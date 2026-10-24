import { describe, expect, it } from 'vitest';
import { avatarImageUrl, avatarTint, initials } from './avatar';

describe('avatar utilities', () => {
  describe('initials', () => {
    it('extracts two letters from a person name', () => {
      expect(initials('Bongani Dlamini')).toBe('BD');
      expect(initials('David Miller')).toBe('DM');
    });

    it('extracts from single names', () => {
      expect(initials('Sipho')).toBe('S');
    });

    it('extracts from email addresses with dot, underscore or hyphen separators', () => {
      expect(initials('david.m@contractor.co.za')).toBe('DM');
      expect(initials('sipho_z@contractor.co.za')).toBe('SZ');
      expect(initials('bongani-d@contractor.co.za')).toBe('BD');
      expect(initials('admin@contractor.co.za')).toBe('A');
    });

    it('handles empty or undefined values gracefully', () => {
      expect(initials(undefined)).toBe('?');
      expect(initials('')).toBe('?');
    });
  });

  describe('avatarTint', () => {
    it('returns a stable Tailwind class string for a given seed', () => {
      const tint1 = avatarTint('admin@contractor.co.za');
      const tint2 = avatarTint('admin@contractor.co.za');
      expect(tint1).toBe(tint2);
      expect(tint1).toContain('bg-');
      expect(tint1).toContain('text-');
    });

    it('returns fallback tint for undefined seed', () => {
      expect(avatarTint(undefined)).toBeDefined();
    });
  });

  describe('avatarImageUrl', () => {
    it('returns undefined when no updatedAt timestamp is provided', () => {
      expect(avatarImageUrl(null)).toBeUndefined();
      expect(avatarImageUrl(undefined)).toBeUndefined();
      expect(avatarImageUrl('')).toBeUndefined();
    });

    it('returns versioned cache-buster URL when updatedAt timestamp is present', () => {
      const stamp = '2026-10-24T07:00:00.000Z';
      const url = avatarImageUrl(stamp);
      expect(url).toBe(`/api/auth/me/avatar?v=${encodeURIComponent(stamp)}`);
    });
  });
});
