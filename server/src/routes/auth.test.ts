import { describe, expect, it } from 'vitest';
import { secondsFromDuration } from './auth.js';

describe('auth utilities', () => {
  describe('secondsFromDuration', () => {
    it('converts minutes to seconds', () => {
      expect(secondsFromDuration('15m')).toBe(900);
      expect(secondsFromDuration('1m')).toBe(60);
    });

    it('converts hours to seconds', () => {
      expect(secondsFromDuration('1h')).toBe(3600);
      expect(secondsFromDuration('24h')).toBe(86400);
    });

    it('converts days to seconds', () => {
      expect(secondsFromDuration('7d')).toBe(604800);
      expect(secondsFromDuration('1d')).toBe(86400);
    });

    it('handles seconds explicitly or as plain numbers', () => {
      expect(secondsFromDuration('30s')).toBe(30);
      expect(secondsFromDuration('120')).toBe(120);
    });

    it('handles whitespace or invalid format gracefully', () => {
      expect(secondsFromDuration('  15m  ')).toBe(900);
      expect(secondsFromDuration('')).toBe(0);
      expect(secondsFromDuration('invalid')).toBe(0);
    });
  });
});
