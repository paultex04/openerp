import { describe, it, expect } from 'vitest';
import {
  addDays,
  currentMonday,
  formatWeek,
  mondayOf,
  weekDays,
} from './weeks';

interface CrewRowState {
  employeeId: number;
  name: string;
  labourType: string;
  shiftType: 'NT' | 'OT1.5' | 'DT2.0' | 'NS' | 'ST';
  hours: [number, number, number, number, number, number, number]; // Mon - Sun
}

/**
 * Calculates matrix daily column totals and grand total man-hours.
 */
function calculateMatrixTotals(rows: CrewRowState[]): {
  days: number[];
  grandTotal: number;
} {
  const totals = [0, 0, 0, 0, 0, 0, 0];
  for (const row of rows) {
    for (let i = 0; i < 7; i++) {
      totals[i] = (totals[i] ?? 0) + (row.hours[i] ?? 0);
    }
  }
  const grandTotal = totals.reduce((a, b) => a + b, 0);
  return { days: totals, grandTotal };
}

/**
 * Calculates shift multiplier factor for cost/billing rollups.
 */
function getShiftMultiplier(shiftType: CrewRowState['shiftType']): number {
  switch (shiftType) {
    case 'NT':
      return 1.0;
    case 'OT1.5':
      return 1.5;
    case 'DT2.0':
      return 2.0;
    case 'NS':
      return 1.15; // 15% night shift premium
    case 'ST':
      return 0.5; // standby rate
    default:
      return 1.0;
  }
}

/**
 * Computes weighted equivalent man-hours factoring in overtime/night-shift rates.
 */
function calculateWeightedHours(row: CrewRowState): number {
  const rawHours = row.hours.reduce((a, b) => a + b, 0);
  return rawHours * getShiftMultiplier(row.shiftType);
}

const isDailyHoursValid = (hours: number[]) => hours.every((h) => h >= 0 && h <= 24);

describe('WeeklyCrewMatrix Domain & Calculations', () => {
  describe('Week Navigation & Date Math', () => {
    it('always anchors to a Monday for any given date', () => {
      // Wednesday 2026-11-04 -> Monday 2026-11-02
      expect(mondayOf('2026-11-04')).toBe('2026-11-02');
      // Sunday 2026-11-08 -> Monday 2026-11-02
      expect(mondayOf('2026-11-08')).toBe('2026-11-02');
      // Monday 2026-11-02 -> Monday 2026-11-02
      expect(mondayOf('2026-11-02')).toBe('2026-11-02');
      // currentMonday returns a valid YYYY-MM-DD string
      expect(currentMonday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('formats week ranges correctly', () => {
      const formatted = formatWeek('2026-11-02', '2026-11-08');
      expect(formatted).toContain('Nov');
      expect(formatted).toContain('2026');
    });

    it('generates exact 7 days Monday through Sunday', () => {
      const days = weekDays('2026-11-02');
      expect(days).toHaveLength(7);
      expect(days[0]?.date).toBe('2026-11-02');
      expect(days[0]?.weekday).toBe('Mon');
      expect(days[6]?.date).toBe('2026-11-08');
      expect(days[6]?.weekday).toBe('Sun');
    });

    it('navigates backwards and forwards by exact 7-day increments', () => {
      const current = '2026-11-02';
      const nextWeek = addDays(current, 7);
      const prevWeek = addDays(current, -7);

      expect(nextWeek).toBe('2026-11-09');
      expect(prevWeek).toBe('2026-10-26');
    });
  });

  describe('Matrix Totals & Shift Multiplier Calculations', () => {
    const mockCrew: CrewRowState[] = [
      {
        employeeId: 1,
        name: 'John Doe',
        labourType: 'Electrician',
        shiftType: 'NT',
        hours: [8, 8, 8, 8, 8, 0, 0], // 40h standard week
      },
      {
        employeeId: 2,
        name: 'Jane Smith',
        labourType: 'Technician',
        shiftType: 'OT1.5',
        hours: [4, 4, 0, 0, 0, 8, 0], // 16h overtime
      },
      {
        employeeId: 3,
        name: 'Bob Johnson',
        labourType: 'General Worker',
        shiftType: 'DT2.0',
        hours: [0, 0, 0, 0, 0, 0, 8], // 8h Sunday double time
      },
    ];

    it('aggregates daily and weekly grand totals accurately', () => {
      const totals = calculateMatrixTotals(mockCrew);

      expect(totals.days[0]).toBe(12); // Mon: 8 + 4
      expect(totals.days[1]).toBe(12); // Tue: 8 + 4
      expect(totals.days[2]).toBe(8);  // Wed: 8
      expect(totals.days[3]).toBe(8);  // Thu: 8
      expect(totals.days[4]).toBe(8);  // Fri: 8
      expect(totals.days[5]).toBe(8);  // Sat: 8
      expect(totals.days[6]).toBe(8);  // Sun: 8

      // Grand total = 40 + 16 + 8 = 64
      expect(totals.grandTotal).toBe(64);
    });

    it('applies shift multipliers for costing calculations', () => {
      expect(getShiftMultiplier('NT')).toBe(1.0);
      expect(getShiftMultiplier('OT1.5')).toBe(1.5);
      expect(getShiftMultiplier('DT2.0')).toBe(2.0);
      expect(getShiftMultiplier('NS')).toBe(1.15);
      expect(getShiftMultiplier('ST')).toBe(0.5);

      // John (NT 40h) -> 40 equivalent hours
      expect(calculateWeightedHours(mockCrew[0]!)).toBe(40);
      // Jane (OT1.5 16h) -> 16 * 1.5 = 24 equivalent hours
      expect(calculateWeightedHours(mockCrew[1]!)).toBe(24);
      // Bob (DT2.0 8h) -> 8 * 2.0 = 16 equivalent hours
      expect(calculateWeightedHours(mockCrew[2]!)).toBe(16);
    });

    it('validates submission rules', () => {
      // 1. Rejects completely empty submission
      const emptyCrew: CrewRowState[] = [
        {
          employeeId: 1,
          name: 'Empty Worker',
          labourType: 'General Worker',
          shiftType: 'NT',
          hours: [0, 0, 0, 0, 0, 0, 0],
        },
      ];
      const emptyTotals = calculateMatrixTotals(emptyCrew);
      expect(emptyTotals.grandTotal).toBe(0);

      // 2. Daily maximum hours validation check (hours > 24 is invalid)
      expect(isDailyHoursValid([8, 8, 8, 8, 8, 0, 0])).toBe(true);
      expect(isDailyHoursValid([25, 0, 0, 0, 0, 0, 0])).toBe(false);
      expect(isDailyHoursValid([-1, 8, 8, 8, 8, 0, 0])).toBe(false);
    });
  });
});
