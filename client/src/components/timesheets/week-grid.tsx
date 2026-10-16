'use client';

/**
 * The week grid: days across, job lines down.
 *
 * One row per (job, labour type, shift). A cell is the hours recorded for that
 * combination on that day; clicking it opens the line editor for exactly that
 * cell. This is the shape the plan settled on, and it is why labour type and shift
 * are part of the row key rather than free columns: a fitter on a night shift and a
 * fitter on a normal shift are two different costs, and collapsing them would hide
 * the difference the costing engine exists to show.
 *
 * The grid is also rendered read-only for an approver, so the same component
 * answers both "what did I enter" and "what am I signing off".
 */
import { AlertTriangle } from 'lucide-react';
import { type ShiftType, type TimesheetEntryView } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription } from '@/components/ui/empty';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatNumber, formatZar } from '@/lib/format';
import { groupKey, jobLabel, weekDays } from './weeks';

export interface GridCell {
  jobId: number;
  labourType: string;
  shiftType: ShiftType;
  workDate: string;
}

interface Row {
  key: string;
  jobId: number;
  labourType: string;
  shiftType: ShiftType;
  job: TimesheetEntryView['job'];
  /** Entries keyed by work date. */
  byDate: Map<string, TimesheetEntryView[]>;
  hours: number;
  cost: number;
  unpriced: boolean;
}

export function WeekGrid({
  periodStart,
  entries,
  onCellClick,
}: {
  periodStart: string;
  entries: readonly TimesheetEntryView[];
  /** Omitted in read-only mode. */
  onCellClick?: (cell: GridCell, cellEntries: TimesheetEntryView[]) => void;
}) {
  const days = weekDays(periodStart);

  const rows = new Map<string, Row>();
  for (const entry of entries) {
    const key = groupKey(entry.jobId, entry.labourType, entry.shiftType);
    const row =
      rows.get(key) ??
      ({
        key,
        jobId: entry.jobId,
        labourType: entry.labourType,
        shiftType: entry.shiftType,
        job: entry.job,
        byDate: new Map(),
        hours: 0,
        cost: 0,
        unpriced: false,
      } satisfies Row);

    const list = row.byDate.get(entry.workDate) ?? [];
    list.push(entry);
    row.byDate.set(entry.workDate, list);
    row.hours += entry.hours;
    row.cost += entry.costAmount ?? entry.preview.costAmount;
    row.unpriced = row.unpriced || !entry.preview.priced;
    rows.set(key, row);
  }

  const ordered = [...rows.values()].sort((a, b) => {
    const left = jobLabel(a.job ?? { workOrder: null, area: null, description: null });
    const right = jobLabel(b.job ?? { workOrder: null, area: null, description: null });
    if (left !== right) return left < right ? -1 : 1;
    if (a.labourType !== b.labourType) return a.labourType < b.labourType ? -1 : 1;
    return a.shiftType < b.shiftType ? -1 : 1;
  });

  const dayTotals = days.map((day) =>
    entries
      .filter((entry) => entry.workDate === day.date)
      .reduce((sum, entry) => sum + entry.hours, 0),
  );
  const grandTotal = entries.reduce((sum, entry) => sum + entry.hours, 0);

  if (entries.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-6">
        <Empty>
          <EmptyDescription>
            No hours recorded this week. Add a line to start filling the grid.
          </EmptyDescription>
        </Empty>
      </div>
    );
  }

  return (
    <div className="min-h-0 overflow-auto rounded-lg border bg-card">
      <table className="w-full caption-bottom text-sm">
        <caption className="sr-only">Hours by job, labour type and shift, Monday to Sunday</caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="sticky left-0 z-10 bg-card">
              Job
            </TableHead>
            <TableHead scope="col">Labour</TableHead>
            <TableHead scope="col">Shift</TableHead>
            {days.map((day) => (
              <TableHead key={day.date} scope="col" className="text-right whitespace-nowrap">
                {day.weekday}
                <span className="block text-xs font-normal text-muted-foreground">{day.stamp}</span>
              </TableHead>
            ))}
            <TableHead scope="col" className="text-right">
              Hours
            </TableHead>
            <TableHead scope="col" className="text-right">
              Cost
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="sticky left-0 z-10 bg-card font-medium">
                {jobLabel(row.job ?? { workOrder: null, area: null, description: null })}
              </TableCell>
              <TableCell className="whitespace-nowrap">{row.labourType}</TableCell>
              <TableCell>
                <Badge variant="outline">{row.shiftType}</Badge>
              </TableCell>
              {days.map((day) => {
                const cellEntries = row.byDate.get(day.date) ?? [];
                const cellHours = cellEntries.reduce((sum, entry) => sum + entry.hours, 0);
                const unpriced = cellEntries.some((entry) => !entry.preview.priced);
                const label = `${jobLabel(
                  row.job ?? { workOrder: null, area: null, description: null },
                )} ${row.labourType} ${row.shiftType} on ${day.stamp}`;

                return (
                  <TableCell key={day.date} className="p-1 text-right tabular-nums">
                    {onCellClick ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={cellEntries.length ? `Edit ${label}` : `Add hours for ${label}`}
                        onClick={() =>
                          onCellClick(
                            {
                              jobId: row.jobId,
                              labourType: row.labourType,
                              shiftType: row.shiftType,
                              workDate: day.date,
                            },
                            cellEntries,
                          )
                        }
                        className="h-8 w-full justify-end gap-1 px-2 font-normal"
                      >
                        {cellEntries.length > 0 ? (
                          <>
                            {unpriced && (
                              <AlertTriangle
                                aria-hidden="true"
                                className="size-3.5 text-warning-foreground"
                              />
                            )}
                            {formatNumber(cellHours)}
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </Button>
                    ) : cellEntries.length > 0 ? (
                      <span className="pr-2">{formatNumber(cellHours)}</span>
                    ) : (
                      <span className="pr-2 text-muted-foreground">—</span>
                    )}
                  </TableCell>
                );
              })}
              <TableCell className="text-right tabular-nums">{formatNumber(row.hours)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {row.unpriced ? <Badge variant="warning">Unpriced</Badge> : formatZar(row.cost)}
              </TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell className="sticky left-0 z-10 bg-muted/50 font-medium" colSpan={3}>
              Totals
            </TableCell>
            {days.map((day, index) => {
              const total = dayTotals[index] ?? 0;
              return (
                <TableCell
                  key={day.date}
                  className="bg-muted/50 text-right tabular-nums font-medium"
                >
                  {total === 0 ? '—' : formatNumber(total)}
                </TableCell>
              );
            })}
            <TableCell className="bg-muted/50 text-right tabular-nums font-medium">
              {formatNumber(grandTotal)}
            </TableCell>
            <TableCell className="bg-muted/50" />
          </TableRow>
        </TableBody>
      </table>
    </div>
  );
}
