'use client';

/**
 * Todoist-style Grouped Task List View.
 *
 * Displays tasks grouped by due date, priority, or status, with inline status toggle,
 * multi-assignee avatar stacks, subtask/checklist progress chips, and quick actions.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Calendar,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Flag,
  Folder,
  Lock,
  MoreHorizontal,
  Plus,
  Trash2,
} from 'lucide-react';
import { useState, useMemo } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import { api, ApiError, type TaskSummaryRow } from '@/lib/api';
import { avatarTint, initials } from '@/lib/avatar';
import { cn } from 'cn';

export type TaskListGroupBy = 'dueDate' | 'priority' | 'status' | 'none';

interface TaskListViewProps {
  tasks: TaskSummaryRow[];
  isLoading?: boolean;
  selectedTaskId: number | null;
  onSelectTask: (taskId: number) => void;
  groupBy?: TaskListGroupBy;
  showCompleted?: boolean;
  onQuickAdd?: () => void;
}

const PRIORITY_RING_COLORS: Record<string, string> = {
  Urgent: 'border-rose-500 hover:bg-rose-500/10 text-rose-500',
  High: 'border-amber-500 hover:bg-amber-500/10 text-amber-500',
  Medium: 'border-blue-500 hover:bg-blue-500/10 text-blue-500',
  Low: 'border-slate-400 dark:border-slate-600 hover:bg-slate-400/10 text-slate-500',
};

const PRIORITY_FLAGS: Record<string, { label: string; color: string }> = {
  Urgent: { label: 'Urgent', color: 'text-rose-500 font-bold' },
  High: { label: 'High', color: 'text-amber-500' },
  Medium: { label: 'Medium', color: 'text-blue-500' },
  Low: { label: 'Low', color: 'text-slate-400' },
};

function formatDueDateBadge(dueDate: string | null) {
  if (!dueDate) return null;
  const target = new Date(dueDate);
  if (Number.isNaN(target.getTime())) return null;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const due = new Date(target.getFullYear(), target.getMonth(), target.getDate());

  const diffMs = due.getTime() - today.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  let label = '';
  let style = 'text-muted-foreground border-border bg-muted/40';

  if (diffDays < 0) {
    label = diffDays === -1 ? 'Yesterday' : `${Math.abs(diffDays)}d overdue`;
    style = 'text-rose-600 dark:text-rose-400 border-rose-300 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 font-medium';
  } else if (diffDays === 0) {
    label = 'Today';
    style = 'text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 font-medium';
  } else if (diffDays === 1) {
    label = 'Tomorrow';
    style = 'text-blue-600 dark:text-blue-400 border-blue-300 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/40';
  } else if (diffDays < 7) {
    label = target.toLocaleDateString('en-ZA', { weekday: 'short' });
    style = 'text-purple-600 dark:text-purple-400 border-purple-300 dark:border-purple-900 bg-purple-50 dark:bg-purple-950/40';
  } else {
    label = target.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
  }

  return { label, style, isOverdue: diffDays < 0, isToday: diffDays === 0 };
}

export function TaskListView({
  tasks,
  isLoading,
  selectedTaskId,
  onSelectTask,
  groupBy = 'dueDate',
  showCompleted = true,
  onQuickAdd,
}: TaskListViewProps) {
  const queryClient = useQueryClient();
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const toggleGroupCollapse = (groupKey: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }));
  };

  // Status toggle mutation (optimistic feel)
  const toggleStatusMutation = useMutation({
    mutationFn: async ({ id, newStatus }: { id: number; newStatus: 'Todo' | 'Done' }) => {
      return api.patch(`/api/tasks/${id}`, { status: newStatus });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (err: Error) => {
      toast.add({
        title: 'Status update failed',
        description: err instanceof ApiError ? err.message : err.message,
        type: 'error',
      });
    },
  });

  // Direct status change
  const setStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      return api.patch(`/api/tasks/${id}`, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (err: Error) => {
      toast.add({
        title: 'Status update failed',
        description: err instanceof ApiError ? err.message : err.message,
        type: 'error',
      });
    },
  });

  // Direct priority change
  const setPriorityMutation = useMutation({
    mutationFn: async ({ id, priority }: { id: number; priority: string }) => {
      return api.patch(`/api/tasks/${id}`, { priority });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (err: Error) => {
      toast.add({
        title: 'Priority update failed',
        description: err instanceof ApiError ? err.message : err.message,
        type: 'error',
      });
    },
  });

  // Delete task mutation
  const deleteTaskMutation = useMutation({
    mutationFn: async (id: number) => {
      return api.delete(`/api/tasks/${id}`);
    },
    onSuccess: () => {
      toast.add({ title: 'Task deleted', type: 'success' });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (err: Error) => {
      toast.add({
        title: 'Delete failed',
        description: err instanceof ApiError ? err.message : err.message,
        type: 'error',
      });
    },
  });

  // Grouped task structure
  const groupedSections: Array<{
    key: string;
    title: string;
    tasks: TaskSummaryRow[];
    color?: string;
  }> = useMemo(() => {
    const visibleTasks = showCompleted
      ? tasks
      : tasks.filter((t) => t.status !== 'Done' && t.status !== 'Cancelled');

    if (groupBy === 'none') {
      return [{ key: 'all', title: 'All Tasks', tasks: visibleTasks }];
    }

    if (groupBy === 'priority') {
      const order = ['Urgent', 'High', 'Medium', 'Low'];
      const map: Record<string, TaskSummaryRow[]> = {
        Urgent: [],
        High: [],
        Medium: [],
        Low: [],
      };
      const completed: TaskSummaryRow[] = [];

      for (const t of visibleTasks) {
        if (t.status === 'Done' || t.status === 'Cancelled') {
          completed.push(t);
        } else {
          map[t.priority]?.push(t);
        }
      }

      const sections = order.map((p) => ({
        key: p,
        title: `${p} Priority`,
        tasks: map[p] ?? [],
      }));

      if (completed.length > 0) {
        sections.push({ key: 'Completed', title: 'Completed', tasks: completed });
      }

      return sections.filter((s) => s.tasks.length > 0);
    }

    if (groupBy === 'status') {
      const order: Array<TaskSummaryRow['status']> = [
        'Todo',
        'In Progress',
        'Blocked',
        'Done',
        'Cancelled',
      ];
      const map: Record<string, TaskSummaryRow[]> = {};
      for (const s of order) map[s] = [];

      for (const t of visibleTasks) {
        if (!map[t.status]) map[t.status] = [];
        map[t.status]!.push(t);
      }

      return order
        .map((statusKey) => ({
          key: statusKey,
          title: statusKey,
          tasks: map[statusKey] ?? [],
        }))
        .filter((s) => s.tasks.length > 0);
    }

    // Default: Group by Due Date (Todoist signature layout)
    const overdue: TaskSummaryRow[] = [];
    const today: TaskSummaryRow[] = [];
    const tomorrow: TaskSummaryRow[] = [];
    const upcoming: TaskSummaryRow[] = [];
    const noDate: TaskSummaryRow[] = [];
    const completed: TaskSummaryRow[] = [];

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const tomorrowStart = todayStart + 24 * 60 * 60 * 1000;

    for (const t of visibleTasks) {
      if (t.status === 'Done' || t.status === 'Cancelled') {
        completed.push(t);
        continue;
      }

      if (!t.dueDate) {
        noDate.push(t);
        continue;
      }

      const d = new Date(t.dueDate);
      if (Number.isNaN(d.getTime())) {
        noDate.push(t);
        continue;
      }

      const targetDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

      if (targetDay < todayStart) {
        overdue.push(t);
      } else if (targetDay === todayStart) {
        today.push(t);
      } else if (targetDay === tomorrowStart) {
        tomorrow.push(t);
      } else {
        upcoming.push(t);
      }
    }

    const sections = [
      { key: 'overdue', title: 'Overdue', tasks: overdue, color: 'text-rose-500' },
      { key: 'today', title: 'Today', tasks: today, color: 'text-amber-500' },
      { key: 'tomorrow', title: 'Tomorrow', tasks: tomorrow, color: 'text-blue-500' },
      { key: 'upcoming', title: 'Upcoming', tasks: upcoming, color: 'text-purple-500' },
      { key: 'noDate', title: 'No Due Date', tasks: noDate, color: 'text-muted-foreground' },
      { key: 'completed', title: 'Completed', tasks: completed, color: 'text-emerald-500' },
    ];

    return sections.filter((s) => s.tasks.length > 0);
  }, [tasks, groupBy, showCompleted]);

  if (isLoading) {
    return (
      <div className="space-y-3 py-6">
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="flex h-14 items-center gap-3 rounded-lg border bg-card px-4 animate-pulse"
          >
            <div className="size-5 rounded-full bg-muted" />
            <div className="h-4 flex-1 rounded bg-muted/60" />
            <div className="h-4 w-24 rounded bg-muted/40" />
          </div>
        ))}
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-16 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <CheckCircle2 className="size-6" />
        </div>
        <h3 className="mt-4 text-base font-medium">All clear!</h3>
        <p className="mt-1 text-sm text-muted-foreground max-w-sm">
          No tasks found matching your current filter. Enjoy the calm or add a new task to get
          started.
        </p>
        {onQuickAdd && (
          <Button onClick={onQuickAdd} size="sm" className="mt-4 gap-1.5">
            <Plus className="size-4" /> Add Task
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12">
      {groupedSections.map((section) => {
        const isCollapsed = collapsedGroups[section.key] ?? false;

        return (
          <section key={section.key} className="space-y-1.5">
            {/* Section Header */}
            <div className="flex items-center justify-between border-b pb-1.5 text-xs font-semibold text-muted-foreground">
              <button
                type="button"
                onClick={() => toggleGroupCollapse(section.key)}
                className="flex items-center gap-1.5 hover:text-foreground transition-colors group"
              >
                {isCollapsed ? (
                  <ChevronRight className="size-3.5 transition-transform group-hover:scale-110" />
                ) : (
                  <ChevronDown className="size-3.5 transition-transform group-hover:scale-110" />
                )}
                <span className={cn('tracking-tight font-medium', section.color)}>
                  {section.title}
                </span>
                <span className="rounded-full bg-muted px-1.5 py-0.2 text-[10px] font-normal text-muted-foreground">
                  {section.tasks.length}
                </span>
              </button>
            </div>

            {/* Section Tasks */}
            {!isCollapsed && (
              <div className="divide-y divide-border/40 rounded-lg border bg-card shadow-xs">
                {section.tasks.map((task) => {
                  const isDone = task.status === 'Done';
                  const isCancelled = task.status === 'Cancelled';
                  const isFinished = isDone || isCancelled;
                  const isSelected = selectedTaskId === task.id;
                  const dueBadge = formatDueDateBadge(task.dueDate);

                  return (
                    <div
                      key={task.id}
                      onClick={() => onSelectTask(task.id)}
                      className={cn(
                        'group relative flex items-start gap-3 p-3 text-left transition-colors cursor-pointer hover:bg-accent/30',
                        isSelected && 'bg-primary/5 ring-1 ring-primary/20',
                        isFinished && 'opacity-60 bg-muted/20',
                      )}
                    >
                      {/* Checkbox / Completion Toggle Button */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleStatusMutation.mutate({
                            id: task.id,
                            newStatus: isDone ? 'Todo' : 'Done',
                          });
                        }}
                        className={cn(
                          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border transition-all',
                          isDone
                            ? 'bg-emerald-600 border-emerald-600 text-white'
                            : PRIORITY_RING_COLORS[task.priority] ?? 'border-muted-foreground/40',
                        )}
                        aria-label={isDone ? 'Mark uncompleted' : 'Mark completed'}
                      >
                        {isDone ? (
                          <Check className="size-3 stroke-[3]" />
                        ) : (
                          <Check className="size-3 stroke-[3] opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                      </button>

                      {/* Content Area */}
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <p
                            className={cn(
                              'text-sm font-medium leading-snug break-words',
                              isFinished && 'line-through text-muted-foreground',
                            )}
                          >
                            {task.title}
                          </p>

                          {/* Private icon */}
                          {task.isPrivate && (
                            <span title="Private task">
                              <Lock className="size-3 shrink-0 text-muted-foreground" />
                            </span>
                          )}
                        </div>

                        {/* Description snippet if present */}
                        {task.description && !isFinished && (
                          <p className="line-clamp-1 text-xs text-muted-foreground">
                            {task.description}
                          </p>
                        )}

                        {/* Badges / Chips Row */}
                        <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-xs">
                          {/* Task Project Chip */}
                          {task.taskProject && (
                            <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium bg-muted/60 text-foreground">
                              <span
                                className="size-2 rounded-full"
                                style={{ backgroundColor: task.taskProject.color }}
                              />
                              {task.taskProject.name}
                            </span>
                          )}

                          {/* ERP Project Chip */}
                          {task.erpProject && (
                            <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                              <Folder className="size-3" />
                              {task.erpProject.code}
                            </span>
                          )}

                          {/* Job Chip */}
                          {task.job && (
                            <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                              Job #{task.job.workOrder ?? task.job.id}
                            </span>
                          )}

                          {/* Due Date Chip */}
                          {dueBadge && (
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]',
                                dueBadge.style,
                              )}
                            >
                              <Calendar className="size-3" />
                              {dueBadge.label}
                            </span>
                          )}

                          {/* Priority Flag */}
                          {task.priority !== 'Medium' && (
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 text-[11px]',
                                PRIORITY_FLAGS[task.priority]?.color,
                              )}
                            >
                              <Flag className="size-3" />
                              {task.priority}
                            </span>
                          )}

                          {/* Checklist Counter */}
                          {task.checklistCount > 0 && (
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 text-[11px] text-muted-foreground',
                                task.checklistDoneCount === task.checklistCount &&
                                  'text-emerald-600 dark:text-emerald-400 font-medium',
                              )}
                            >
                              <CheckSquare className="size-3" />
                              {task.checklistDoneCount}/{task.checklistCount}
                            </span>
                          )}

                          {/* Subtasks Counter */}
                          {task.subtaskCount > 0 && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                              <CornerDownRight className="size-3" />
                              {task.subtaskCount}
                            </span>
                          )}

                          {/* Tags */}
                          {task.tags &&
                            task.tags.map((tag) => (
                              <span
                                key={tag.id}
                                className="inline-flex items-center rounded-full px-2 py-0.2 text-[10px] font-medium"
                                style={{
                                  backgroundColor: `${tag.color}15`,
                                  color: tag.color,
                                }}
                              >
                                #{tag.name}
                              </span>
                            ))}
                        </div>
                      </div>

                      {/* Right section: Multi-Assignee Avatars + Row Actions */}
                      <div className="flex shrink-0 items-center gap-2 pt-0.5">
                        {/* Assignees stack */}
                        {task.assignees.length > 0 && (
                          <div className="flex -space-x-1.5 overflow-hidden">
                            {task.assignees.slice(0, 3).map((assignee) => {
                              const name = assignee.user.name || assignee.user.email;
                              return (
                                <Avatar
                                  key={assignee.id}
                                  className="size-6 border-2 border-background ring-1 ring-border text-[10px]"
                                  title={name}
                                >
                                  <AvatarFallback className={avatarTint(name)}>
                                    {initials(name)}
                                  </AvatarFallback>
                                </Avatar>
                              );
                            })}
                            {task.assignees.length > 3 && (
                              <div
                                className="flex size-6 items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] font-medium text-muted-foreground"
                                title={`${task.assignees.length - 3} more assignees`}
                              >
                                +{task.assignees.length - 3}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Quick Context Dropdown */}
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <button
                                type="button"
                                onClick={(e) => e.stopPropagation()}
                                className="flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity hover:bg-accent hover:text-foreground cursor-pointer"
                                aria-label="Task options"
                              >
                                <MoreHorizontal className="size-4" />
                              </button>
                            }
                          />
                          <DropdownMenuContent
                            align="end"
                            className="w-44"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <DropdownMenuGroup>
                              <DropdownMenuLabel>Change Status</DropdownMenuLabel>
                              <DropdownMenuItem
                                onClick={() =>
                                  setStatusMutation.mutate({ id: task.id, status: 'Todo' })
                                }
                              >
                                Todo
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  setStatusMutation.mutate({ id: task.id, status: 'In Progress' })
                                }
                              >
                                In Progress
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  setStatusMutation.mutate({ id: task.id, status: 'Blocked' })
                                }
                              >
                                Blocked
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  setStatusMutation.mutate({ id: task.id, status: 'Done' })
                                }
                              >
                                Done
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  setStatusMutation.mutate({ id: task.id, status: 'Cancelled' })
                                }
                              >
                                Cancelled
                              </DropdownMenuItem>
                            </DropdownMenuGroup>

                            <DropdownMenuSeparator />
                            <DropdownMenuGroup>
                              <DropdownMenuLabel>Change Priority</DropdownMenuLabel>
                              {(['Urgent', 'High', 'Medium', 'Low'] as const).map((p) => (
                                <DropdownMenuItem
                                  key={p}
                                  onClick={() =>
                                    setPriorityMutation.mutate({ id: task.id, priority: p })
                                  }
                                >
                                  <Flag className={cn('size-3.5 mr-1.5', PRIORITY_FLAGS[p]?.color)} />
                                  {p}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuGroup>

                            <DropdownMenuSeparator />
                            <DropdownMenuGroup>
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => {
                                  if (confirm(`Delete "${task.title}"?`)) {
                                    deleteTaskMutation.mutate(task.id);
                                  }
                                }}
                              >
                                <Trash2 className="size-3.5 mr-1.5" />
                                Delete Task
                              </DropdownMenuItem>
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
