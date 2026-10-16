/**
 * Week arithmetic for the timesheet grid.
 *
 * Everything is UTC and ISO `YYYY-MM-DD`, matching the server. A timesheet header
 * is one row per (employee, Monday), and `periodEnd` is always Monday + 6, so the
 * only date this module has to understand is the Monday of a week.
 */

/** `2026-03-02` from any Date, in UTC. */
export function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** The Monday of the week containing `date`. */
export function mondayOf(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  const sinceMonday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - sinceMonday);
  return isoDate(value);
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return isoDate(value);
}

/** Monday of the current week. */
export function currentMonday(): string {
  return mondayOf(isoDate(new Date()));
}

export interface WeekDay {
  /** ISO date, e.g. `2026-03-02`. */
  date: string;
  /** `Mon`. */
  weekday: string;
  /** `2 Mar`. */
  stamp: string;
}

/** The seven days of a week, Monday first. */
export function weekDays(periodStart: string): WeekDay[] {
  const weekdayFormat = new Intl.DateTimeFormat('en-ZA', { weekday: 'short', timeZone: 'UTC' });
  const stampFormat = new Intl.DateTimeFormat('en-ZA', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

  return Array.from({ length: 7 }, (_unused, index) => {
    const date = addDays(periodStart, index);
    const value = new Date(`${date}T00:00:00.000Z`);
    return {
      date,
      weekday: weekdayFormat.format(value),
      stamp: stampFormat.format(value),
    };
  });
}

/** `2 Mar – 8 Mar 2026`. */
export function formatWeek(periodStart: string, periodEnd: string): string {
  const format = new Intl.DateTimeFormat('en-ZA', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const start = format.format(new Date(`${periodStart}T00:00:00.000Z`));
  const end = format.format(new Date(`${periodEnd}T00:00:00.000Z`));
  return `${start} – ${end}`;
}

/** `Mon 2 Mar` — the label for one day, used in the entry dialog's date picker. */
export function formatDay(date: string): string {
  const format = new Intl.DateTimeFormat('en-ZA', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  return format.format(new Date(`${date}T00:00:00.000Z`));
}

/** The stable key a grid row gathers by: one row per job, labour type and shift. */
export function groupKey(jobId: number, labourType: string, shiftType: string): string {
  return `${jobId}\u0000${labourType}\u0000${shiftType}`;
}

/** A job line's display name: work order if there is one, else the area/description. */
export function jobLabel(job: {
  workOrder: string | null;
  area: string | null;
  description: string | null;
}): string {
  return job.workOrder ?? job.area ?? job.description ?? 'Unnamed job';
}

export const SHIFT_TYPES = ['NT', 'OT1.5', 'DT2.0', 'NS', 'ST'] as const;
