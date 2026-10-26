'use client';

/**
 * Todoist-style Quick-Add Command Bar.
 *
 * Allows rapid creation of tasks with inline chips for Due Date, Priority,
 * Task Project, and Multi-user Assignments.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Calendar,
  Check,
  Flag,
  Folder,
  Lock,
  Plus,
  Users,
  X,
} from 'lucide-react';
import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
  api,
  ApiError,
  type TaskProjectRow,
  type TaskUserSummary,
} from '@/lib/api';

const PRIORITIES: Array<{ label: 'Low' | 'Medium' | 'High' | 'Urgent'; color: string }> = [
  { label: 'Low', color: 'text-slate-500' },
  { label: 'Medium', color: 'text-blue-500' },
  { label: 'High', color: 'text-amber-500' },
  { label: 'Urgent', color: 'text-rose-500 font-semibold' },
];

interface TaskQuickAddProps {
  defaultProjectId?: number | null;
  projects?: TaskProjectRow[];
}

export function TaskQuickAdd({ defaultProjectId, projects = [] }: TaskQuickAddProps) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  const [isExpanded, setIsExpanded] = useState(false);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<'Low' | 'Medium' | 'High' | 'Urgent'>('Medium');
  const [dueDate, setDueDate] = useState<string>('');
  const [projectId, setProjectId] = useState<number | null>(defaultProjectId ?? null);
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([]);
  const [isPrivate, setIsPrivate] = useState(false);
  const [showAssigneePicker, setShowAssigneePicker] = useState(false);

  // Fetch assignable users
  const assignableUsers = useQuery({
    queryKey: ['assignable-users'],
    queryFn: () => api.get<{ users: TaskUserSummary[] }>('/api/users/assignable'),
  });

  const createTask = useMutation({
    mutationFn: () =>
      api.post('/api/tasks', {
        title: title.trim(),
        priority,
        dueDate: dueDate ? new Date(dueDate).toISOString() : null,
        taskProjectId: projectId,
        assigneeIds: selectedUserIds.length > 0 ? selectedUserIds : undefined,
        isPrivate,
      }),
    onSuccess: async () => {
      toast.add({ title: 'Task created', type: 'success' });
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
      setTitle('');
      setDueDate('');
      setSelectedUserIds([]);
      setShowAssigneePicker(false);
      inputRef.current?.focus();
    },
    onError: (e: Error) => {
      toast.add({
        title: 'Could not create task',
        description: e instanceof ApiError ? e.message : e.message,
        type: 'error',
      });
    },
  });

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && title.trim()) {
      e.preventDefault();
      createTask.mutate();
    } else if (e.key === 'Escape') {
      setIsExpanded(false);
    }
  };

  const setPresetDate = (daysAhead: number) => {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    const dateStr = d.toISOString().slice(0, 10);
    setDueDate(dateStr);
  };

  const toggleUser = (userId: number) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  };

  const usersList = assignableUsers.data?.users ?? [];

  return (
    <div
      className={`rounded-xl border bg-card p-3 shadow-xs transition-all ${
        isExpanded ? 'ring-2 ring-primary/20 border-primary/50' : 'hover:border-primary/40'
      }`}
    >
      <div className="flex items-center gap-2.5">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Plus className="size-4" />
        </div>
        <input
          ref={inputRef}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={() => setIsExpanded(true)}
          onKeyDown={handleKeyDown}
          placeholder="Add a new task… (e.g. Inspect switchgear on substation 4, press Enter)"
          className="w-full bg-transparent text-sm font-medium placeholder:text-muted-foreground focus:outline-none"
        />
        {title.trim() && !isExpanded && (
          <Button
            size="sm"
            onClick={() => createTask.mutate()}
            disabled={createTask.isPending}
            className="h-7 text-xs"
          >
            {createTask.isPending ? 'Adding…' : 'Add'}
          </Button>
        )}
      </div>

      {isExpanded && (
        <div className="mt-3 space-y-3 border-t pt-3 animate-in fade-in-50 duration-150">
          {/* Quick chip selectors */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {/* Due date picker / chips */}
            <div className="flex items-center gap-1 rounded-md border bg-muted/30 px-2 py-1">
              <Calendar className="size-3.5 text-muted-foreground" />
              <button
                type="button"
                onClick={() => setPresetDate(0)}
                className={`rounded px-1.5 py-0.5 ${
                  dueDate === new Date().toISOString().slice(0, 10)
                    ? 'bg-primary text-primary-foreground font-medium'
                    : 'hover:bg-muted text-muted-foreground'
                }`}
              >
                Today
              </button>
              <button
                type="button"
                onClick={() => setPresetDate(1)}
                className="rounded px-1.5 py-0.5 hover:bg-muted text-muted-foreground"
              >
                Tomorrow
              </button>
              <button
                type="button"
                onClick={() => setPresetDate(7)}
                className="rounded px-1.5 py-0.5 hover:bg-muted text-muted-foreground"
              >
                Next Week
              </button>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="bg-transparent text-xs text-foreground focus:outline-none ml-1"
              />
              {dueDate && (
                <button
                  type="button"
                  onClick={() => setDueDate('')}
                  className="text-muted-foreground hover:text-foreground ml-1"
                  title="Clear date"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>

            {/* Priority chips */}
            <div className="flex items-center gap-1 rounded-md border bg-muted/30 px-2 py-1">
              <Flag className="size-3.5 text-muted-foreground" />
              {PRIORITIES.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setPriority(p.label)}
                  className={`rounded px-1.5 py-0.5 transition-colors ${
                    priority === p.label
                      ? 'bg-primary text-primary-foreground font-medium'
                      : `hover:bg-muted ${p.color}`
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Project select */}
            {projects.length > 0 && (
              <div className="flex items-center gap-1 rounded-md border bg-muted/30 px-2 py-1">
                <Folder className="size-3.5 text-muted-foreground" />
                <select
                  value={projectId ?? ''}
                  onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}
                  className="bg-transparent text-xs text-foreground focus:outline-none"
                >
                  <option value="">No Project (Inbox)</option>
                  {projects.map((proj) => (
                    <option key={proj.id} value={proj.id}>
                      {proj.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Assignees toggle */}
            <button
              type="button"
              onClick={() => setShowAssigneePicker(!showAssigneePicker)}
              className={`flex items-center gap-1 rounded-md border px-2 py-1 transition-colors ${
                selectedUserIds.length > 0
                  ? 'border-primary/50 bg-primary/10 text-primary font-medium'
                  : 'bg-muted/30 text-muted-foreground hover:bg-muted'
              }`}
            >
              <Users className="size-3.5" />
              <span>
                {selectedUserIds.length === 0
                  ? 'Assign'
                  : `${selectedUserIds.length} Assignee${selectedUserIds.length > 1 ? 's' : ''}`}
              </span>
            </button>

            {/* Private toggle */}
            <label className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground cursor-pointer px-1">
              <input
                type="checkbox"
                checked={isPrivate}
                onChange={(e) => setIsPrivate(e.target.checked)}
                className="size-3.5 rounded text-primary focus:ring-primary"
              />
              <Lock className="size-3" />
              <span className="text-[11px]">Private</span>
            </label>
          </div>

          {/* Expanded multi-assignee selector */}
          {showAssigneePicker && (
            <div className="rounded-lg border bg-background p-2.5 shadow-sm space-y-1.5 animate-in fade-in-50">
              <p className="text-[11px] font-medium text-muted-foreground">
                Assign to multiple team members:
              </p>
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                {usersList.map((user) => {
                  const isSelected = selectedUserIds.includes(user.id);
                  return (
                    <button
                      key={user.id}
                      type="button"
                      onClick={() => toggleUser(user.id)}
                      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                        isSelected
                          ? 'border-primary bg-primary text-primary-foreground font-medium'
                          : 'border-border bg-card text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      {isSelected && <Check className="size-3" />}
                      <span>{user.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center justify-between pt-1">
            <span className="text-[11px] text-muted-foreground">
              Tip: Press <kbd className="rounded border bg-muted px-1 font-mono">Enter</kbd> to save
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setIsExpanded(false);
                  setTitle('');
                }}
                className="h-8 text-xs"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => createTask.mutate()}
                disabled={createTask.isPending || !title.trim()}
                className="h-8 text-xs gap-1.5 font-medium"
              >
                {createTask.isPending ? 'Adding…' : 'Add Task'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
