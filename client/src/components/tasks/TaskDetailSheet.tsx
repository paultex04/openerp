'use client';

/**
 * Task Detail Slide-Over Sheet.
 *
 * Linear/Todoist-style inspection and editing drawer for tasks.
 * Manages task attributes, multi-assignees, checklists, subtasks,
 * discussion comments, and activity history.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Calendar,
  Flag,
  History,
  Lock,
  Plus,
  Send,
  Trash2,
  Unlock,
  Users,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import {
  api,
  ApiError,
  type TaskDetailRow,
  type TaskProjectRow,
  type TaskUserSummary,
} from '@/lib/api';
import { avatarImageUrl, avatarTint, initials } from '@/lib/avatar';
import { formatDate } from '@/lib/format';
import { cn } from 'cn';

interface TaskDetailSheetProps {
  taskId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects?: TaskProjectRow[];
  onSelectTask?: (id: number) => void;
}

const STATUS_OPTIONS: Array<{
  value: 'Todo' | 'In Progress' | 'Blocked' | 'Done' | 'Cancelled';
  label: string;
  variant: 'default' | 'secondary' | 'warning' | 'success' | 'outline';
}> = [
  { value: 'Todo', label: 'Todo', variant: 'outline' },
  { value: 'In Progress', label: 'In Progress', variant: 'secondary' },
  { value: 'Blocked', label: 'Blocked', variant: 'warning' },
  { value: 'Done', label: 'Done', variant: 'success' },
  { value: 'Cancelled', label: 'Cancelled', variant: 'outline' },
];

const PRIORITY_OPTIONS: Array<{
  value: 'Low' | 'Medium' | 'High' | 'Urgent';
  label: string;
  color: string;
}> = [
  { value: 'Low', label: 'Low', color: 'text-slate-500' },
  { value: 'Medium', label: 'Medium', color: 'text-blue-500' },
  { value: 'High', label: 'High', color: 'text-amber-500' },
  { value: 'Urgent', label: 'Urgent', color: 'text-rose-500 font-bold' },
];

export function TaskDetailSheet({
  taskId,
  open,
  onOpenChange,
  projects = [],
  onSelectTask,
}: TaskDetailSheetProps) {
  const queryClient = useQueryClient();

  const taskQuery = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.get<{ task: TaskDetailRow }>(`/api/tasks/${taskId}`),
    enabled: taskId !== null && open,
  });

  const assignableUsers = useQuery({
    queryKey: ['assignable-users'],
    queryFn: () => api.get<{ users: TaskUserSummary[] }>('/api/users/assignable'),
    enabled: open,
  });

  const task = taskQuery.data?.task;

  // Local draft states
  const [newChecklistTitle, setNewChecklistTitle] = useState('');
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  const [newComment, setNewComment] = useState('');
  const [showAddAssignee, setShowAddAssignee] = useState(false);
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState('');

  // Update mutations
  const updateTask = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/tasks/${taskId}`, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (e: Error) => {
      toast.add({
        title: 'Could not update task',
        description: e instanceof ApiError ? e.message : e.message,
        type: 'error',
      });
    },
  });

  // Assignee mutations
  const addAssignee = useMutation({
    mutationFn: (userId: number) =>
      api.post(`/api/tasks/${taskId}/assignees`, { userIds: [userId] }),
    onSuccess: async () => {
      toast.add({ title: 'Assignee added', type: 'success' });
      await queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
      setShowAddAssignee(false);
    },
  });

  const removeAssignee = useMutation({
    mutationFn: (userId: number) => api.delete(`/api/tasks/${taskId}/assignees/${userId}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  // Checklist mutations
  const addChecklistItem = useMutation({
    mutationFn: (title: string) =>
      api.post(`/api/tasks/${taskId}/checklist`, { title }),
    onSuccess: async () => {
      setNewChecklistTitle('');
      await queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const toggleChecklistItem = useMutation({
    mutationFn: ({ itemId, isDone }: { itemId: number; isDone: boolean }) =>
      api.patch(`/api/tasks/${taskId}/checklist/${itemId}`, { isDone }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const deleteChecklistItem = useMutation({
    mutationFn: (itemId: number) =>
      api.delete(`/api/tasks/${taskId}/checklist/${itemId}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  // Subtask creation
  const addSubtask = useMutation({
    mutationFn: (title: string) =>
      api.post('/api/tasks', {
        title,
        parentId: taskId,
        taskProjectId: task?.taskProjectId,
      }),
    onSuccess: async () => {
      setNewSubtaskTitle('');
      toast.add({ title: 'Subtask added', type: 'success' });
      await queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  // Comment submission
  const addComment = useMutation({
    mutationFn: (content: string) =>
      api.post(`/api/tasks/${taskId}/comments`, { content }),
    onSuccess: async () => {
      setNewComment('');
      toast.add({ title: 'Comment posted', type: 'success' });
      await queryClient.invalidateQueries({ queryKey: ['task', taskId] });
    },
  });

  // Delete task
  const deleteTask = useMutation({
    mutationFn: () => api.delete(`/api/tasks/${taskId}`),
    onSuccess: async () => {
      toast.add({ title: 'Task deleted', type: 'success' });
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
      onOpenChange(false);
    },
    onError: (e: Error) => {
      toast.add({
        title: 'Could not delete task',
        description: e instanceof ApiError ? e.message : e.message,
        type: 'error',
      });
    },
  });

  if (!task) return null;

  const currentAssigneeUserIds = task.assignees.map((a) => a.userId);
  const unassignedUsers = (assignableUsers.data?.users ?? []).filter(
    (u) => !currentAssigneeUserIds.includes(u.id),
  );

  const completedChecklistCount = task.checklists.filter((c) => c.isDone).length;
  const totalChecklistCount = task.checklists.length;
  const checklistPercent =
    totalChecklistCount > 0 ? Math.round((completedChecklistCount / totalChecklistCount) * 100) : 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl md:max-w-2xl overflow-y-auto p-0 flex flex-col bg-background/95 backdrop-blur-md border-l shadow-2xl"
      >
        {/* Header */}
        <SheetHeader className="border-b p-5 pb-4 bg-card/60 sticky top-0 z-20 backdrop-blur-md">
          <SheetTitle className="sr-only">Task Details</SheetTitle>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {task.parent && (
                <button
                  type="button"
                  onClick={() => onSelectTask?.(task.parent!.id)}
                  className="font-medium text-primary hover:underline"
                >
                  Subtask of: {task.parent.title}
                </button>
              )}
              {task.taskProject && (
                <span className="flex items-center gap-1 font-medium text-foreground">
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: task.taskProject.color }}
                  />
                  {task.taskProject.name}
                </span>
              )}
              {task.isPrivate && (
                <Badge variant="outline" className="gap-1 text-[10px]">
                  <Lock className="size-2.5" />
                  Private
                </Badge>
              )}
            </div>

            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                if (confirm('Delete this task permanently?')) {
                  deleteTask.mutate();
                }
              }}
              title="Delete task"
              className="text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>

          <div className="pt-2">
            <input
              type="text"
              value={task.title}
              onChange={(e) => updateTask.mutate({ title: e.target.value })}
              className="w-full bg-transparent text-lg font-bold tracking-tight text-foreground focus:outline-none focus:ring-1 focus:ring-ring rounded-md px-1 py-0.5"
            />
          </div>

          {/* Controls Bar: Status, Priority, Due Date */}
          <div className="flex flex-wrap items-center gap-3 pt-3">
            {/* Status select */}
            <select
              value={task.status}
              onChange={(e) => updateTask.mutate({ status: e.target.value })}
              className="rounded-md border border-input bg-background px-2.5 py-1 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {STATUS_OPTIONS.map((st) => (
                <option key={st.value} value={st.value}>
                  {st.label}
                </option>
              ))}
            </select>

            {/* Priority select */}
            <div className="flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-xs">
              <Flag className="size-3.5 text-muted-foreground" />
              <select
                value={task.priority}
                onChange={(e) => updateTask.mutate({ priority: e.target.value })}
                className="bg-transparent font-medium focus:outline-none"
              >
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value} className={p.color}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Due date */}
            <div className="flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-xs text-muted-foreground">
              <Calendar className="size-3.5" />
              <input
                type="date"
                value={task.dueDate ? task.dueDate.slice(0, 10) : ''}
                onChange={(e) =>
                  updateTask.mutate({
                    dueDate: e.target.value ? new Date(e.target.value).toISOString() : null,
                  })
                }
                className="bg-transparent text-xs text-foreground focus:outline-none"
              />
            </div>

            {/* Privacy toggle */}
            <button
              type="button"
              onClick={() => updateTask.mutate({ isPrivate: !task.isPrivate })}
              className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${
                task.isPrivate
                  ? 'border-warning/50 bg-warning/10 text-warning font-medium'
                  : 'border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              {task.isPrivate ? <Lock className="size-3" /> : <Unlock className="size-3" />}
              <span>{task.isPrivate ? 'Private' : 'Public'}</span>
            </button>
          </div>

          {/* Multi-Assignee section */}
          <div className="pt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <Users className="size-3.5" />
              Assignees:
            </span>
            {task.assignees.map((assignee) => (
              <span
                key={assignee.id}
                className="flex items-center gap-1.5 rounded-full border bg-muted/40 pl-1 pr-2 py-0.5 text-xs font-medium"
              >
                <Avatar className="size-4.5">
                  <AvatarImage
                    src={avatarImageUrl(assignee.user.avatarUpdatedAt)}
                    alt={assignee.user.name}
                  />
                  <AvatarFallback
                    className={cn('text-[9px]', avatarTint(assignee.user.name))}
                  >
                    {initials(assignee.user.name)}
                  </AvatarFallback>
                </Avatar>
                <span>{assignee.user.name}</span>
                <button
                  type="button"
                  onClick={() => removeAssignee.mutate(assignee.userId)}
                  className="text-muted-foreground hover:text-destructive"
                  title="Remove assignee"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}

            {/* Add assignee button & dropdown */}
            <div className="relative">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAddAssignee(!showAddAssignee)}
                className="h-6 text-[11px] gap-1 px-2 rounded-full"
              >
                <Plus className="size-3" />
                Add
              </Button>

              {showAddAssignee && (
                <div className="absolute left-0 top-7 z-30 w-52 rounded-lg border bg-popover p-1.5 shadow-lg space-y-1">
                  <p className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Select team member
                  </p>
                  <div className="max-h-48 overflow-y-auto space-y-0.5">
                    {unassignedUsers.map((user) => (
                      <button
                        key={user.id}
                        type="button"
                        onClick={() => addAssignee.mutate(user.id)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-left hover:bg-accent"
                      >
                        <Avatar className="size-5">
                          <AvatarImage
                            src={avatarImageUrl(user.avatarUpdatedAt)}
                            alt={user.name}
                          />
                          <AvatarFallback
                            className={cn('text-[10px]', avatarTint(user.name))}
                          >
                            {initials(user.name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="truncate">{user.name}</span>
                      </button>
                    ))}
                    {unassignedUsers.length === 0 && (
                      <p className="p-2 text-center text-xs text-muted-foreground">
                        All members assigned
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </SheetHeader>

        {/* Content Tabs */}
        <div className="p-5 flex-1 flex flex-col">
          <Tabs defaultValue="details" className="flex-1 flex flex-col">
            <TabsList className="grid grid-cols-4 w-full">
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="checklists">
                Checklist ({completedChecklistCount}/{totalChecklistCount})
              </TabsTrigger>
              <TabsTrigger value="comments">
                Comments ({task.comments.length})
              </TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>

            {/* TAB 1: Details */}
            <TabsContent value="details" className="space-y-5 pt-4">
              {/* Description */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Description &amp; Notes
                  </h4>
                  {!isEditingDescription ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDescriptionDraft(task.description ?? '');
                        setIsEditingDescription(true);
                      }}
                      className="h-6 text-xs"
                    >
                      Edit
                    </Button>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setIsEditingDescription(false)}
                        className="h-6 text-xs"
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          updateTask.mutate({ description: descriptionDraft });
                          setIsEditingDescription(false);
                        }}
                        className="h-6 text-xs"
                      >
                        Save
                      </Button>
                    </div>
                  )}
                </div>

                {isEditingDescription ? (
                  <textarea
                    rows={5}
                    value={descriptionDraft}
                    onChange={(e) => setDescriptionDraft(e.target.value)}
                    placeholder="Add detailed task instructions, scope notes, or requirements…"
                    className="w-full rounded-md border border-input bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                ) : (
                  <div
                    onClick={() => {
                      setDescriptionDraft(task.description ?? '');
                      setIsEditingDescription(true);
                    }}
                    className="min-h-20 rounded-md border border-dashed p-3 text-sm cursor-pointer hover:bg-muted/30 transition-colors"
                  >
                    {task.description ? (
                      <p className="whitespace-pre-wrap text-foreground">{task.description}</p>
                    ) : (
                      <p className="text-muted-foreground italic">
                        No description provided. Click to add notes…
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Organizational Workspace / Links */}
              <div className="space-y-3 rounded-lg border p-4 bg-muted/20">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Organization &amp; Linkage
                </h4>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="text-muted-foreground block mb-1">Task Project / List</label>
                    <select
                      value={task.taskProjectId ?? ''}
                      onChange={(e) =>
                        updateTask.mutate({
                          taskProjectId: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs focus:outline-none"
                    >
                      <option value="">No Project (Inbox)</option>
                      {projects.map((proj) => (
                        <option key={proj.id} value={proj.id}>
                          {proj.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-muted-foreground block mb-1">Operational Job (Optional)</label>
                    <div className="rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-muted-foreground truncate">
                      {task.job ? `Job #${task.job.id} (${task.job.workOrder ?? 'No WO'})` : 'None linked'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Subtasks Preview */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Subtasks ({task.subtasks.length})
                  </h4>
                </div>

                <div className="space-y-1.5">
                  {task.subtasks.map((st) => (
                    <button
                      key={st.id}
                      type="button"
                      onClick={() => onSelectTask?.(st.id)}
                      className="w-full flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-xs hover:bg-accent transition-colors"
                    >
                      <span className="font-medium truncate">{st.title}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge variant="outline" className="text-[10px]">
                          {st.status}
                        </Badge>
                      </div>
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="text"
                    value={newSubtaskTitle}
                    onChange={(e) => setNewSubtaskTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newSubtaskTitle.trim()) {
                        e.preventDefault();
                        addSubtask.mutate(newSubtaskTitle.trim());
                      }
                    }}
                    placeholder="Add a subtask…"
                    className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <Button
                    size="sm"
                    onClick={() => addSubtask.mutate(newSubtaskTitle.trim())}
                    disabled={addSubtask.isPending || !newSubtaskTitle.trim()}
                    className="h-8 text-xs"
                  >
                    Add
                  </Button>
                </div>
              </div>
            </TabsContent>

            {/* TAB 2: Checklists */}
            <TabsContent value="checklists" className="space-y-4 pt-4">
              {/* Progress bar */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-muted-foreground">Completion Progress</span>
                  <span>
                    {completedChecklistCount}/{totalChecklistCount} ({checklistPercent}%)
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-300"
                    style={{ width: `${checklistPercent}%` }}
                  />
                </div>
              </div>

              {/* Items List */}
              <div className="space-y-1.5 pt-2">
                {task.checklists.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs transition-colors hover:bg-muted/30"
                  >
                    <label className="flex items-center gap-2.5 flex-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={item.isDone}
                        onChange={(e) =>
                          toggleChecklistItem.mutate({
                            itemId: item.id,
                            isDone: e.target.checked,
                          })
                        }
                        className="size-4 rounded text-primary focus:ring-primary cursor-pointer"
                      />
                      <span
                        className={
                          item.isDone
                            ? 'line-through text-muted-foreground'
                            : 'font-medium text-foreground'
                        }
                      >
                        {item.title}
                      </span>
                    </label>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => deleteChecklistItem.mutate(item.id)}
                      className="text-muted-foreground hover:text-destructive size-6"
                    >
                      <X className="size-3" />
                    </Button>
                  </div>
                ))}

                {task.checklists.length === 0 && (
                  <p className="p-6 text-center text-xs text-muted-foreground italic border rounded-md border-dashed">
                    No checklist items yet. Break this task into steps below.
                  </p>
                )}
              </div>

              {/* Add checklist input */}
              <div className="flex items-center gap-2 pt-2">
                <input
                  type="text"
                  value={newChecklistTitle}
                  onChange={(e) => setNewChecklistTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newChecklistTitle.trim()) {
                      e.preventDefault();
                      addChecklistItem.mutate(newChecklistTitle.trim());
                    }
                  }}
                  placeholder="Add a checklist item… (e.g. Test voltage drop, press Enter)"
                  className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <Button
                  size="sm"
                  onClick={() => addChecklistItem.mutate(newChecklistTitle.trim())}
                  disabled={addChecklistItem.isPending || !newChecklistTitle.trim()}
                  className="h-8 text-xs"
                >
                  Add Item
                </Button>
              </div>
            </TabsContent>

            {/* TAB 3: Comments */}
            <TabsContent value="comments" className="flex-1 flex flex-col justify-between pt-4 space-y-4">
              <div className="space-y-3 overflow-y-auto max-h-[22rem] pr-1">
                {task.comments.map((cm) => (
                  <div key={cm.id} className="flex items-start gap-2.5 rounded-lg border p-3 bg-card/60">
                    <Avatar className="size-6 shrink-0 mt-0.5">
                      <AvatarImage
                        src={avatarImageUrl(cm.author.avatarUpdatedAt)}
                        alt={cm.author.name}
                      />
                      <AvatarFallback
                        className={cn('text-[10px]', avatarTint(cm.author.name))}
                      >
                        {initials(cm.author.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="space-y-1 flex-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-foreground">{cm.author.name}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {formatDate(cm.createdAt)}
                        </span>
                      </div>
                      <p className="text-xs text-foreground whitespace-pre-wrap">{cm.content}</p>
                    </div>
                  </div>
                ))}

                {task.comments.length === 0 && (
                  <p className="py-8 text-center text-xs text-muted-foreground italic border rounded-md border-dashed">
                    No comments yet. Start a discussion with the team.
                  </p>
                )}
              </div>

              {/* Add comment input */}
              <div className="flex items-end gap-2 border-t pt-3">
                <textarea
                  rows={2}
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  placeholder="Write a comment or update…"
                  className="flex-1 rounded-md border border-input bg-background p-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <Button
                  size="sm"
                  onClick={() => addComment.mutate(newComment.trim())}
                  disabled={addComment.isPending || !newComment.trim()}
                  className="gap-1.5 h-9"
                >
                  <Send className="size-3.5" />
                  Send
                </Button>
              </div>
            </TabsContent>

            {/* TAB 4: Activity */}
            <TabsContent value="activity" className="space-y-3 pt-4">
              <div className="space-y-2 max-h-[26rem] overflow-y-auto pr-1">
                {task.activities.map((act) => (
                  <div key={act.id} className="flex items-center gap-3 text-xs border-b pb-2 last:border-0">
                    <History className="size-3.5 text-muted-foreground shrink-0" />
                    <div className="flex-1">
                      <span className="font-semibold text-foreground">{act.actor.name}</span>{' '}
                      <span className="text-muted-foreground lowercase">{act.action.replace('_', ' ')}</span>
                      {act.details && (
                        <span className="font-mono text-[11px] text-muted-foreground ml-1">
                          {JSON.stringify(act.details)}
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {formatDate(act.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  );
}
