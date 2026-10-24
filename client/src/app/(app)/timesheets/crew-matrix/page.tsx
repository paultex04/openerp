'use client';

/**
 * Weekly Crew Timesheet Matrix (Phase 6).
 *
 * Spreadsheet-style attendance and hours entry matrix for site supervisors and PMs.
 * Enables rapid multi-employee hours logging against an active job for the 7 days of a week
 * in a single, unified view.
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronLeft, ChevronRight, Clock, Save, Sparkles, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';
import { api, type LoggableJob, type TimesheetEmployee } from '@/lib/api';
import {
  addDays,
  currentMonday,
  formatWeek,
  weekDays,
  type WeekDay,
} from '@/components/timesheets/weeks';
import { cn } from '@/lib/utils';

interface CrewRowState {
  employeeId: number;
  name: string;
  labourType: string;
  shiftType: 'NT' | 'OT1.5' | 'DT2.0' | 'NS' | 'ST';
  hours: [number, number, number, number, number, number, number]; // Mon - Sun
}

const DEFAULT_LABOUR_TYPES = [
  'Electrician',
  'Artisan / Technician',
  'Semi-Skilled Assistant',
  'General Worker / Labourer',
  'Site Supervisor',
  'Safety Officer',
];

export default function CrewMatrixPage() {
  const queryClient = useQueryClient();
  const [periodStart, setPeriodStart] = useState<string>(currentMonday());
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // 1. Fetch available jobs for logging
  const jobsQuery = useQuery({
    queryKey: ['timesheet-jobs-matrix'],
    queryFn: () => api.get<{ jobs: LoggableJob[] }>('/api/timesheets/jobs', { limit: 100 }),
  });
  const jobs = jobsQuery.data?.jobs ?? [];

  // Default select first job when loaded
  const activeJob = useMemo(() => {
    if (selectedJobId) return jobs.find((j) => j.id === selectedJobId) ?? null;
    return jobs[0] ?? null;
  }, [jobs, selectedJobId]);

  // 2. Fetch loggable employees
  const employeesQuery = useQuery({
    queryKey: ['timesheet-employees-matrix'],
    queryFn: () =>
      api.get<{ employees: TimesheetEmployee[] }>('/api/timesheets/employees', { limit: 200 }),
  });
  const employees = employeesQuery.data?.employees ?? [];

  // Days of the active week (Mon - Sun)
  const days: WeekDay[] = useMemo(() => weekDays(periodStart), [periodStart]);

  // Local grid state: row per employee
  const [gridData, setGridData] = useState<Record<number, CrewRowState>>({});

  // Ensure row state exists for employee
  const getRowState = (emp: TimesheetEmployee): CrewRowState => {
    if (gridData[emp.id]) return gridData[emp.id]!;
    return {
      employeeId: emp.id,
      name: `${emp.name} ${emp.surname}`,
      labourType: 'Electrician',
      shiftType: 'NT',
      hours: [0, 0, 0, 0, 0, 0, 0],
    };
  };

  const updateHour = (empId: number, dayIndex: number, val: number) => {
    setGridData((prev) => {
      const emp = employees.find((e) => e.id === empId);
      const row = prev[empId] ?? {
        employeeId: empId,
        name: emp ? `${emp.name} ${emp.surname}` : `Emp #${empId}`,
        labourType: 'Electrician',
        shiftType: 'NT',
        hours: [0, 0, 0, 0, 0, 0, 0],
      };
      const newHours = [...row.hours] as [number, number, number, number, number, number, number];
      newHours[dayIndex] = Math.max(0, Math.min(24, val));
      return {
        ...prev,
        [empId]: { ...row, hours: newHours },
      };
    });
  };

  const updateLabourType = (empId: number, type: string) => {
    setGridData((prev) => {
      const current = prev[empId];
      if (!current) return prev;
      return { ...prev, [empId]: { ...current, labourType: type } };
    });
  };

  const updateShiftType = (empId: number, shift: 'NT' | 'OT1.5' | 'DT2.0') => {
    setGridData((prev) => {
      const current = prev[empId];
      if (!current) return prev;
      return { ...prev, [empId]: { ...current, shiftType: shift } };
    });
  };

  const fillStandardWeek = (empId: number) => {
    setGridData((prev) => {
      const emp = employees.find((e) => e.id === empId);
      const row = prev[empId] ?? {
        employeeId: empId,
        name: emp ? `${emp.name} ${emp.surname}` : `Emp #${empId}`,
        labourType: 'Electrician',
        shiftType: 'NT',
        hours: [0, 0, 0, 0, 0, 0, 0],
      };
      return {
        ...prev,
        [empId]: { ...row, hours: [8, 8, 8, 8, 8, 0, 0] },
      };
    });
  };

  const clearRow = (empId: number) => {
    setGridData((prev) => {
      const current = prev[empId];
      if (!current) return prev;
      return {
        ...prev,
        [empId]: { ...current, hours: [0, 0, 0, 0, 0, 0, 0] },
      };
    });
  };

  const fillAllStandard = () => {
    const updated: Record<number, CrewRowState> = { ...gridData };
    for (const emp of employees) {
      const existing = updated[emp.id] ?? {
        employeeId: emp.id,
        name: `${emp.name} ${emp.surname}`,
        labourType: 'Electrician',
        shiftType: 'NT',
        hours: [0, 0, 0, 0, 0, 0, 0],
      };
      updated[emp.id] = { ...existing, hours: [8, 8, 8, 8, 8, 0, 0] };
    }
    setGridData(updated);
    toast.add({
      title: 'Bulk Filled',
      description: 'Set 8h (Mon-Fri) for all crew members.',
      type: 'info',
    });
  };

  const clearAll = () => {
    setGridData({});
    toast.add({
      title: 'Grid Cleared',
      description: 'Reset all crew hour inputs.',
      type: 'info',
    });
  };

  // Filtered employees list
  const filteredEmployees = useMemo(() => {
    const q = employeeSearch.toLowerCase().trim();
    if (!q) return employees;
    return employees.filter(
      (e) => e.name.toLowerCase().includes(q) || e.surname.toLowerCase().includes(q),
    );
  }, [employees, employeeSearch]);

  // Daily & Grand totals
  const columnTotals = useMemo(() => {
    const totals: number[] = [0, 0, 0, 0, 0, 0, 0];
    for (const row of Object.values(gridData)) {
      for (let i = 0; i < 7; i++) {
        totals[i] = (totals[i] ?? 0) + (row.hours[i] ?? 0);
      }
    }
    const grandTotal = totals.reduce((a, b) => a + b, 0);
    return { days: totals, grandTotal };
  }, [gridData]);

  // Bulk Save Action
  const handleSaveMatrix = async () => {
    if (!activeJob) {
      toast.add({
        title: 'No Job Selected',
        description: 'Please select an active job card to book crew hours against.',
        type: 'error',
      });
      return;
    }

    const rowsToSubmit = Object.values(gridData).filter((row) => row.hours.some((h) => h > 0));

    if (rowsToSubmit.length === 0) {
      toast.add({
        title: 'No Hours Entered',
        description: 'Please enter hours for at least one crew member before saving.',
        type: 'error',
      });
      return;
    }

    setIsSaving(true);
    let entriesSaved = 0;
    let employeesUpdated = 0;

    try {
      for (const row of rowsToSubmit) {
        // 1. Ensure timesheet header exists
        const headerRes = await api.post<{ timesheet: { id: number } }>('/api/timesheets', {
          employeeId: row.employeeId,
          periodStart,
        });
        const tsId = headerRes.timesheet.id;

        // 2. Add entry for each day with hours > 0
        let empHasEntry = false;
        for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
          const hours = row.hours[dayIdx] ?? 0;
          if (hours > 0) {
            const workDate = days[dayIdx]?.date;
            if (!workDate) continue;

            await api.post(`/api/timesheets/${tsId}/entries`, {
              jobId: activeJob.id,
              workDate,
              labourType: row.labourType || 'Electrician',
              shiftType: row.shiftType || 'NT',
              hours,
            });
            entriesSaved++;
            empHasEntry = true;
          }
        }
        if (empHasEntry) employeesUpdated++;
      }

      toast.add({
        title: 'Crew Timesheets Saved',
        description: `Successfully logged ${entriesSaved} entries across ${employeesUpdated} crew members!`,
        type: 'success',
      });

      // Clear grid and invalidate cache
      setGridData({});
      void queryClient.invalidateQueries({ queryKey: ['timesheets'] });
      void queryClient.invalidateQueries({ queryKey: ['timesheet-week'] });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save crew timesheets.';
      toast.add({
        title: 'Save Failed',
        description: msg,
        type: 'error',
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 pb-12">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Link
              href="/timesheets"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
            >
              <ArrowLeft className="size-3" />
              Timesheets
            </Link>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight mt-1">
            Weekly Crew Timesheet Matrix
          </h1>
          <p className="text-xs text-muted-foreground">
            Bulk field attendance and hours recording for site supervisors and crew leads.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={fillAllStandard}>
            <Sparkles className="size-3.5 mr-1 text-primary" />
            Fill 8h All
          </Button>
          <Button variant="outline" size="sm" onClick={clearAll}>
            <Trash2 className="size-3.5 mr-1" />
            Clear
          </Button>
          <Button
            size="sm"
            onClick={handleSaveMatrix}
            disabled={isSaving || columnTotals.grandTotal === 0}
            className="flex items-center gap-1.5"
          >
            <Save className="size-4" />
            {isSaving ? 'Saving...' : `Save Matrix (${columnTotals.grandTotal}h)`}
          </Button>
        </div>
      </div>

      {/* Control Bar: Week & Job Selector */}
      <Card>
        <CardContent className="pt-4 pb-4">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {/* Week navigation */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Week Starting</label>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-9 shrink-0"
                  onClick={() => setPeriodStart((p) => addDays(p, -7))}
                  title="Previous week"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <div className="flex-1 text-center font-mono text-xs font-semibold border rounded-md h-9 flex items-center justify-center bg-muted/20 px-2">
                  {formatWeek(periodStart, addDays(periodStart, 6))}
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-9 shrink-0"
                  onClick={() => setPeriodStart((p) => addDays(p, 7))}
                  title="Next week"
                >
                  <ChevronRight className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  onClick={() => setPeriodStart(currentMonday())}
                >
                  This Week
                </Button>
              </div>
            </div>

            {/* Job picker */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Target Job Card <span className="text-destructive">*</span>
              </label>
              <select
                value={activeJob?.id ?? ''}
                onChange={(e) => setSelectedJobId(Number(e.target.value) || null)}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:ring-1 focus-visible:outline-none"
              >
                {jobs.map((job) => (
                  <option key={job.id} value={job.id}>
                    Job #{job.id} · {job.projectCode} · {job.description || 'EC&I Work'} (
                    {job.clientName})
                  </option>
                ))}
              </select>
            </div>

            {/* Crew search filter */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Filter Crew</label>
              <input
                type="text"
                placeholder="Search team member…"
                value={employeeSearch}
                onChange={(e) => setEmployeeSearch(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-xs outline-none"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Main Matrix Spreadsheet Grid */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b bg-muted/40 font-medium text-muted-foreground">
                <th className="py-2.5 px-3 min-w-[180px]">Crew Member</th>
                <th className="py-2.5 px-2 min-w-[130px]">Labour Trade</th>
                <th className="py-2.5 px-2 min-w-[80px]">Shift</th>
                {days.map((d) => (
                  <th key={d.date} className="py-2.5 px-1.5 text-center min-w-[56px]">
                    <span className="block font-semibold text-foreground">{d.weekday}</span>
                    <span className="block text-[10px] text-muted-foreground">{d.stamp}</span>
                  </th>
                ))}
                <th className="py-2.5 px-2 text-center min-w-[65px] font-semibold text-foreground">
                  Total
                </th>
                <th className="py-2.5 px-2 text-center min-w-[90px]">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {filteredEmployees.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-8 text-center text-muted-foreground">
                    No crew members found.
                  </td>
                </tr>
              ) : (
                filteredEmployees.map((emp) => {
                  const state = getRowState(emp);
                  const rowTotal = state.hours.reduce((a, b) => a + b, 0);

                  return (
                    <tr
                      key={emp.id}
                      className={cn(
                        'hover:bg-muted/20 transition-colors',
                        rowTotal > 0 && 'bg-primary/5',
                      )}
                    >
                      {/* Name */}
                      <td className="py-2 px-3">
                        <p className="font-medium text-foreground">{state.name}</p>
                        <p className="text-[10px] text-muted-foreground">ID: #{emp.id}</p>
                      </td>

                      {/* Trade / Labour Type */}
                      <td className="py-2 px-2">
                        <select
                          value={state.labourType}
                          onChange={(e) => updateLabourType(emp.id, e.target.value)}
                          className="h-7 w-full rounded border border-input bg-background px-1 text-[11px]"
                        >
                          {DEFAULT_LABOUR_TYPES.map((lt) => (
                            <option key={lt} value={lt}>
                              {lt}
                            </option>
                          ))}
                        </select>
                      </td>

                      {/* Shift Type */}
                      <td className="py-2 px-2">
                        <select
                          value={state.shiftType}
                          onChange={(e) =>
                            updateShiftType(emp.id, e.target.value as 'NT' | 'OT1.5' | 'DT2.0')
                          }
                          className="h-7 w-full rounded border border-input bg-background px-1 text-[11px] font-mono"
                        >
                          <option value="NT">NT (1.0x)</option>
                          <option value="OT1.5">OT (1.5x)</option>
                          <option value="DT2.0">DT (2.0x)</option>
                        </select>
                      </td>

                      {/* 7 Daily Hour Inputs */}
                      {state.hours.map((val, dIdx) => (
                        <td key={dIdx} className="py-2 px-1 text-center">
                          <input
                            type="number"
                            min="0"
                            max="24"
                            step="0.5"
                            value={val === 0 ? '' : val}
                            placeholder="-"
                            onChange={(e) =>
                              updateHour(
                                emp.id,
                                dIdx,
                                e.target.value === '' ? 0 : parseFloat(e.target.value) || 0,
                              )
                            }
                            className={cn(
                              'h-7 w-12 rounded border text-center font-mono text-xs tabular-nums outline-none transition-colors focus:ring-1 focus:ring-primary',
                              val > 0
                                ? 'bg-primary/10 border-primary/40 font-semibold text-primary'
                                : 'border-input bg-background text-muted-foreground',
                            )}
                          />
                        </td>
                      ))}

                      {/* Row Total */}
                      <td className="py-2 px-2 text-center font-mono font-bold text-foreground">
                        {rowTotal > 0 ? `${rowTotal}h` : '-'}
                      </td>

                      {/* Actions */}
                      <td className="py-2 px-2 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            type="button"
                            onClick={() => fillStandardWeek(emp.id)}
                            className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                            title="Fill 8h Mon-Fri"
                          >
                            8h×5
                          </button>
                          <button
                            type="button"
                            onClick={() => clearRow(emp.id)}
                            className="rounded p-1 text-muted-foreground hover:text-destructive"
                            title="Clear hours"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
            {/* Matrix Footer Totals */}
            <tfoot>
              <tr className="border-t-2 border-border bg-muted/60 font-mono font-bold text-xs text-foreground">
                <td colSpan={3} className="py-2.5 px-3">
                  TOTAL CREW HOURS
                </td>
                {columnTotals.days.map((tot, idx) => (
                  <td key={idx} className="py-2.5 px-1 text-center tabular-nums">
                    {tot > 0 ? `${tot}h` : '-'}
                  </td>
                ))}
                <td className="py-2.5 px-2 text-center tabular-nums text-primary text-sm">
                  {columnTotals.grandTotal}h
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      {/* Floating Save Summary Bar */}
      {columnTotals.grandTotal > 0 && (
        <div className="sticky bottom-4 z-20 flex items-center justify-between rounded-xl border bg-popover/95 p-3.5 shadow-xl backdrop-blur-md">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Clock className="size-4" />
            </div>
            <div>
              <p className="text-xs font-semibold">
                {columnTotals.grandTotal} Total Hours Ready for Submission
              </p>
              <p className="text-[11px] text-muted-foreground">
                Target: {activeJob?.projectCode} · Job #{activeJob?.id}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleSaveMatrix}
              disabled={isSaving}
              className="flex items-center gap-1.5"
            >
              <Save className="size-3.5" />
              {isSaving ? 'Recording Entries...' : 'Save & Submit Crew Week'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
