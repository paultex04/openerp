'use client';

/**
 * Task Kanban Board View.
 *
 * Visual board organized into columns by Status (Todo, In Progress, Blocked, Done).
 * Allows one-click card inspection, quick status transitions, and inline creation.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Calendar,
  CheckSquare,
  CornerDownRight,
  Flag,
  Folder,
  Lock,
  MoreHorizontal,
  Plus,
} from 'lucide-react';
import { useMemo } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import { api, ApiError, type TaskSummaryRow } from '@/lib/api';
import { avatarTint, initials } from '@/lib/avatar';
import { cn } from 'cn';

interface TaskKanbanViewProps {
  tasks: TaskSummaryRow[];
  isLoading?: boolean;
  selectedTaskId: number | null;
  onSelectTask: (taskId: number) => void;
  onQuickAddForStatus?: (status: TaskSummaryRow['status']) => void;
}

const COLUMNS: Array<{
  status: TaskSummaryRow['status'];
  label: string;
  dotColor: string;
  badgeBg: string;
}> = [
  {
    status: 'Todo',
    label: 'To Do',
    dotColor: 'bg-slate-500',
    badgeBg: 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
  },
  {
    status: 'In Progress',
    label: 'In Progress',
    dotColor: 'bg-blue-500',
    badgeBg: 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200',
  },
  {
    status: 'Blocked',
    label: 'Blocked',
    dotColor: 'bg-amber-500',
    badgeBg: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200',
  },
  {
    status: 'Done',
    label: 'Done',
    dotColor: 'bg-emerald-500',
    badgeBg: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200',
  },
];

const PRIORITY_STRIPE: Record<string, string> = {
  Urgent: 'border-l-4 border-l-rose-500',
  High: 'border-l-4 border-l-amber-500',
  Medium: 'border-l-4 border-l-blue-500',
  Low: 'border-l-4 border-l-slate-300 dark:border-l-slate-700',
};

const PRIORITY_FLAGS: Record<string, { label: string; color: string }> = {
  Urgent: { label: 'Urgent', color: 'text-rose-500' },
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
  } else {
    label = target.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
  }

  return { label, style };
}

export function TaskKanbanView({
  tasks,
  isLoading,
  selectedTaskId,
  onSelectTask,
  onQuickAddForStatus,
}: TaskKanbanViewProps) {
  const queryClient = useQueryClient();

  // Move task to a different status
  const moveStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: TaskSummaryRow['status'] }) => {
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

  // Group tasks by column status
  const columnTasks = useMemo(() => {
    const map: Record<TaskSummaryRow['status'], TaskSummaryRow[]> = {
      Todo: [],
      'In Progress': [],
      Blocked: [],
      Done: [],
      Cancelled: [],
    };

    for (const task of tasks) {
      if (map[task.status]) {
        map[task.status].push(task);
      }
    }

    return map;
  }, [tasks]);

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 py-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-96 rounded-xl border bg-muted/20 animate-pulse p-4 space-y-3">
            <div className="h-6 w-24 rounded bg-muted" />
            <div className="h-28 rounded-lg bg-card border" />
            <div className="h-28 rounded-lg bg-card border" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 pb-12 items-start">
      {COLUMNS.map((col) => {
        const colList = columnTasks[col.status] ?? [];

        return (
          <div
            key={col.status}
            className="flex flex-col rounded-xl border bg-muted/20 p-2.5 min-h-[500px]"
          >
            {/* Column Header */}
            <div className="flex items-center justify-between pb-3 px-1">
              <div className="flex items-center gap-2">
                <span className={cn('size-2.5 rounded-full', col.dotColor)} />
                <h3 className="text-sm font-semibold tracking-tight">{col.label}</h3>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.2 text-[11px] font-medium',
                    col.badgeBg,
                  )}
                >
                  {colList.length}
                </span>
              </div>

              {onQuickAddForStatus && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onQuickAddForStatus(col.status)}
                  title={`Add task to ${col.label}`}
                >
                  <Plus className="size-3.5" />
                </Button>
              )}
            </div>

            {/* Cards Container */}
            <div className="flex-1 space-y-2.5 overflow-y-auto">
              {colList.map((task) => {
                const isSelected = selectedTaskId === task.id;
                const isDone = task.status === 'Done';
                const dueBadge = formatDueDateBadge(task.dueDate);

                return (
                  <div
                    key={task.id}
                    onClick={() => onSelectTask(task.id)}
                    className={cn(
                      'group relative rounded-lg border bg-card p-3 shadow-xs transition-all cursor-pointer hover:shadow-md hover:border-primary/40',
                      PRIORITY_STRIPE[task.priority],
                      isSelected && 'ring-2 ring-primary border-transparent',
                      isDone && 'opacity-70 bg-card/60',
                    )}
                  >
                    {/* Top Row: Tags/Project & Quick Menu */}
                    <div className="flex items-start justify-between gap-2 pb-1.5">
                      <div className="flex flex-wrap items-center gap-1 text-[11px]">
                        {task.taskProject && (
                          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium bg-muted text-foreground">
                            <span
                              className="size-1.5 rounded-full"
                              style={{ backgroundColor: task.taskProject.color }}
                            />
                            {task.taskProject.name}
                          </span>
                        )}
                        {task.erpProject && (
                          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                            <Folder className="size-2.5" />
                            {task.erpProject.code}
                          </span>
                        )}
                        {task.isPrivate && (
                          <span title="Private task">
                            <Lock className="size-3 text-muted-foreground" />
                          </span>
                        )}
                      </div>

                      {/* Card Actions Menu */}
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          onClick={(e) => e.stopPropagation()}
                          className="flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity hover:bg-accent hover:text-foreground"
                        >
                          <MoreHorizontal className="size-3.5" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="w-40"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <DropdownMenuLabel>Move to</DropdownMenuLabel>
                          {COLUMNS.map((targetCol) => {
                            if (targetCol.status === task.status) return null;
                            return (
                              <DropdownMenuItem
                                key={targetCol.status}
                                onClick={() =>
                                  moveStatusMutation.mutate({
                                    id: task.id,
                                    status: targetCol.status,
                                  })
                                }
                              >
                                <span
                                  className={cn('size-2 rounded-full mr-2', targetCol.dotColor)}
                                />
                                {targetCol.label}
                              </DropdownMenuItem>
                            );
                          })}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => onSelectTask(task.id)}>
                            View Details
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    {/* Task Title */}
                    <h4
                      className={cn(
                        'text-sm font-medium leading-snug line-clamp-2',
                        isDone && 'line-through text-muted-foreground',
                      )}
                    >
                      {task.title}
                    </h4>

                    {/* Task Description Preview */}
                    {task.description && !isDone && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground leading-relaxed">
                        {task.description}
                      </p>
                    )}

                    {/* Card Footer: Metadata & Assignees */}
                    <div className="mt-3 flex items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
                      <div className="flex flex-wrap items-center gap-2">
                        {/* Due Date */}
                        {dueBadge && (
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]',
                              dueBadge.style,
                            )}
                          >
                            <Calendar className="size-2.5" />
                            {dueBadge.label}
                          </span>
                        )}

                        {/* Priority Flag */}
                        {task.priority !== 'Medium' && (
                          <span
                            className={cn('inline-flex items-center gap-1 text-[11px]')}
                            title={`Priority: ${task.priority}`}
                          >
                            <Flag
                              className={cn('size-3', PRIORITY_FLAGS[task.priority]?.color)}
                            />
                          </span>
                        )}

                        {/* Checklists progress */}
                        {task.checklistCount > 0 && (
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 text-[10px]',
                              task.checklistDoneCount === task.checklistCount &&
                                'text-emerald-600 dark:text-emerald-400 font-medium',
                            )}
                          >
                            <CheckSquare className="size-2.5" />
                            {task.checklistDoneCount}/{task.checklistCount}
                          </span>
                        )}

                        {/* Subtasks */}
                        {task.subtaskCount > 0 && (
                          <span className="inline-flex items-center gap-1 text-[10px]">
                            <CornerDownRight className="size-2.5" />
                            {task.subtaskCount}
                          </span>
                        )}
                      </div>

                      {/* Assignees stack */}
                      {task.assignees.length > 0 && (
                        <div className="flex -space-x-1.5 overflow-hidden">
                          {task.assignees.slice(0, 3).map((assignee) => {
                            const name = assignee.user.name || assignee.user.email;
                            return (
                              <Avatar
                                key={assignee.id}
                                className="size-5 border-2 border-background ring-1 ring-border text-[9px]"
                                title={name}
                              >
                                <AvatarFallback className={avatarTint(name)}>
                                  {initials(name)}
                                </AvatarFallback>
                              </Avatar>
                            );
                          })}
                          {task.assignees.length > 3 && (
                            <div className="flex size-5 items-center justify-center rounded-full border-2 border-background bg-muted text-[8px] font-medium text-muted-foreground">
                              +{task.assignees.length - 3}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {colList.length === 0 && (
                <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-10 text-center text-xs text-muted-foreground">
                  <p>No tasks</p>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
