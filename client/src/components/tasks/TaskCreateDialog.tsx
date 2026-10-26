'use client';

/**
 * Dialog for creating a new Task.
 *
 * Provides a clean modal interface for setting task title, notes, status,
 * priority, due date, project, multi-user assignees, and privacy settings.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Lock,
  Plus,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import {
  api,
  ApiError,
  type TaskDetailRow,
  type TaskProjectRow,
  type TaskUserSummary,
} from '@/lib/api';
import { avatarTint, initials } from '@/lib/avatar';
import { cn } from 'cn';

interface TaskCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultStatus?: 'Todo' | 'In Progress' | 'Blocked' | 'Done' | 'Cancelled';
  defaultProjectId?: number | null;
  projects?: TaskProjectRow[];
  onCreated?: (task: TaskDetailRow) => void;
}

const PRIORITIES = [
  { value: 'Low', label: 'Low', color: 'text-slate-500' },
  { value: 'Medium', label: 'Medium', color: 'text-blue-500' },
  { value: 'High', label: 'High', color: 'text-amber-500' },
  { value: 'Urgent', label: 'Urgent', color: 'text-rose-500 font-semibold' },
] as const;

const STATUSES = [
  { value: 'Todo', label: 'Todo' },
  { value: 'In Progress', label: 'In Progress' },
  { value: 'Blocked', label: 'Blocked' },
  { value: 'Done', label: 'Done' },
  { value: 'Cancelled', label: 'Cancelled' },
] as const;

export function TaskCreateDialog({
  open,
  onOpenChange,
  defaultStatus = 'Todo',
  defaultProjectId = null,
  projects = [],
  onCreated,
}: TaskCreateDialogProps) {
  const queryClient = useQueryClient();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<'Todo' | 'In Progress' | 'Blocked' | 'Done' | 'Cancelled'>(
    defaultStatus,
  );
  const [priority, setPriority] = useState<'Low' | 'Medium' | 'High' | 'Urgent'>('Medium');
  const [taskProjectId, setTaskProjectId] = useState<string>(
    defaultProjectId ? String(defaultProjectId) : '',
  );
  const [dueDate, setDueDate] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([]);

  // Sync defaults whenever the dialog opens or props change
  useEffect(() => {
    if (open) {
      setTitle('');
      setDescription('');
      setStatus(defaultStatus);
      setPriority('Medium');
      setTaskProjectId(defaultProjectId ? String(defaultProjectId) : '');
      setDueDate('');
      setIsPrivate(false);
      setSelectedUserIds([]);
    }
  }, [open, defaultStatus, defaultProjectId]);

  // Fetch assignable team members
  const { data: usersData } = useQuery({
    queryKey: ['assignable-users'],
    queryFn: () => api.get<{ users: TaskUserSummary[] }>('/api/users/assignable'),
    enabled: open,
  });

  const assignableUsers = usersData?.users ?? [];

  const toggleUserAssignment = (userId: number) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      let isoDate: string | null = null;
      if (dueDate) {
        const parsed = new Date(dueDate);
        if (!Number.isNaN(parsed.getTime())) {
          isoDate = parsed.toISOString();
        }
      }

      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        status,
        priority,
        dueDate: isoDate,
        dueHasTime: false,
        isPrivate,
        taskProjectId: taskProjectId ? Number(taskProjectId) : null,
        assigneeIds: selectedUserIds,
      };

      return api.post<{ task: TaskDetailRow }>('/api/tasks', payload);
    },
    onSuccess: (data) => {
      toast.add({ title: 'Task created', type: 'success' });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['task-projects'] });
      onOpenChange(false);
      if (data?.task) {
        onCreated?.(data.task);
      }
    },
    onError: (err: Error) => {
      toast.add({
        title: 'Could not create task',
        description: err instanceof ApiError ? err.message : err.message,
        type: 'error',
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || createMutation.isPending) return;
    createMutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="size-5 text-primary" />
            New Task
          </DialogTitle>
          <DialogDescription>
            Create a work item, assign team members, and set target dates and priority.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          {/* Title */}
          <Field>
            <FieldLabel htmlFor="task-title">
              Task Title <span className="text-destructive">*</span>
            </FieldLabel>
            <Input
              id="task-title"
              placeholder="e.g. Inspect switchgear on substation 4"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              required
            />
          </Field>

          {/* Description */}
          <Field>
            <FieldLabel htmlFor="task-description">Notes & Description</FieldLabel>
            <textarea
              id="task-description"
              rows={3}
              placeholder="Add extra context, specifications, or instructions..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </Field>

          {/* Status & Priority */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="task-status">Status</FieldLabel>
              <select
                id="task-status"
                value={status}
                onChange={(e) =>
                  setStatus(
                    e.target.value as 'Todo' | 'In Progress' | 'Blocked' | 'Done' | 'Cancelled',
                  )
                }
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field>
              <FieldLabel htmlFor="task-priority">Priority</FieldLabel>
              <select
                id="task-priority"
                value={priority}
                onChange={(e) =>
                  setPriority(e.target.value as 'Low' | 'Medium' | 'High' | 'Urgent')
                }
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {PRIORITIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {/* Project & Due Date */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="task-project">Project / Workspace</FieldLabel>
              <select
                id="task-project"
                value={taskProjectId}
                onChange={(e) => setTaskProjectId(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">None (Inbox)</option>
                {projects.map((proj) => (
                  <option key={proj.id} value={proj.id}>
                    {proj.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field>
              <FieldLabel htmlFor="task-due-date">Due Date</FieldLabel>
              <Input
                id="task-due-date"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </Field>
          </div>

          {/* Multi-user Assignees */}
          <Field>
            <FieldLabel>Assign To (Multiple Users Allowed)</FieldLabel>
            <FieldDescription>
              Select team members responsible for executing or overseeing this task.
            </FieldDescription>
            <div className="flex flex-wrap gap-1.5 pt-1 max-h-36 overflow-y-auto p-1.5 rounded-md border bg-muted/20">
              {assignableUsers.map((u) => {
                const isSelected = selectedUserIds.includes(u.id);
                const name = u.name || u.email;

                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => toggleUserAssignment(u.id)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer',
                      isSelected
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card text-foreground hover:bg-muted border-border',
                    )}
                  >
                    <Avatar className="size-4 text-[9px]">
                      <AvatarFallback className={isSelected ? 'bg-primary-foreground/20 text-primary-foreground' : avatarTint(name)}>
                        {initials(name)}
                      </AvatarFallback>
                    </Avatar>
                    <span>{name}</span>
                    {isSelected && <Check className="size-3 ml-0.5 stroke-[2.5]" />}
                  </button>
                );
              })}

              {assignableUsers.length === 0 && (
                <p className="p-2 text-xs text-muted-foreground italic">
                  No active users found.
                </p>
              )}
            </div>
          </Field>

          {/* Privacy Flag */}
          <div className="flex items-start gap-2.5 pt-1">
            <input
              type="checkbox"
              id="task-private"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
              className="mt-1 size-4 rounded border-input text-primary focus:ring-primary"
            />
            <label htmlFor="task-private" className="text-xs text-muted-foreground cursor-pointer">
              <span className="font-medium text-foreground flex items-center gap-1">
                <Lock className="size-3" /> Private task
              </span>
              When checked, this task is only visible to you, assigned users, and administrators.
            </label>
          </div>

          <DialogFooter className="pt-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!title.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? 'Creating…' : 'Create Task'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
