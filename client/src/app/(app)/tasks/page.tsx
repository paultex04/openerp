'use client';

/**
 * Tasks Management (Todoist-style Work Tracking).
 *
 * Full-featured work-related task tracker supporting multi-user assignments,
 * standalone task projects & operational ERP links, subtasks, checklists,
 * activity history, comments, and dual List/Kanban views.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays,
  CheckCircle2,
  Columns3,
  Edit2,
  Inbox,
  ListTodo,
  MoreVertical,
  Plus,
  Search,
  SlidersHorizontal,
  Sun,
  UserCheck,
  X,
} from 'lucide-react';
import { useState, useMemo } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { usePermissions } from '@/components/auth/usePermissions';
import {
  TaskCreateDialog,
} from '@/components/tasks/TaskCreateDialog';
import {
  TaskDetailSheet,
} from '@/components/tasks/TaskDetailSheet';
import {
  TaskKanbanView,
} from '@/components/tasks/TaskKanbanView';
import {
  TaskListView,
  type TaskListGroupBy,
} from '@/components/tasks/TaskListView';
import {
  TaskProjectDialog,
} from '@/components/tasks/TaskProjectDialog';
import {
  api,
  ApiError,
  type TaskProjectRow,
  type TaskSummaryRow,
} from '@/lib/api';
import { cn } from 'cn';

type StandardView = 'inbox' | 'today' | 'upcoming' | 'assignedToMe';
type ViewMode = 'list' | 'kanban';

export default function TasksPage() {
  const { canAny, loading: permissionsLoading } = usePermissions();
  const queryClient = useQueryClient();

  // Navigation state
  const [selectedView, setSelectedView] = useState<StandardView | 'project'>('inbox');
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);

  // View presentation state
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [groupBy, setGroupBy] = useState<TaskListGroupBy>('dueDate');
  const [showCompleted, setShowCompleted] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedPriority, setSelectedPriority] = useState<string | null>(null);

  // Dialog & Detail Sheet states
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState<boolean>(false);
  const [createDialogStatus, setCreateDialogStatus] = useState<
    'Todo' | 'In Progress' | 'Blocked' | 'Done' | 'Cancelled'
  >('Todo');
  const [projectDialogOpen, setProjectDialogOpen] = useState<boolean>(false);
  const [editingProject, setEditingProject] = useState<TaskProjectRow | null>(null);

  // Fetch Task Projects
  const { data: projectsData, isLoading: projectsLoading } = useQuery({
    queryKey: ['task-projects'],
    queryFn: () => api.get<{ projects: TaskProjectRow[] }>('/api/task-projects'),
    enabled: canAny('task.read'),
  });

  const projects = projectsData?.projects ?? [];
  const currentProject = projects.find((p) => p.id === selectedProjectId) ?? null;

  // Build query parameters for tasks
  const taskQueryParams = useMemo(() => {
    const params: Record<string, string | number | boolean> = {
      includeCompleted: showCompleted,
    };

    if (searchQuery.trim()) {
      params.search = searchQuery.trim();
    }

    if (selectedPriority) {
      params.priority = selectedPriority;
    }

    if (selectedView === 'project' && selectedProjectId) {
      params.taskProjectId = selectedProjectId;
    } else if (selectedView === 'today') {
      params.due = 'today';
    } else if (selectedView === 'upcoming') {
      params.due = 'upcoming';
    } else if (selectedView === 'assignedToMe') {
      params.assignedToMe = true;
    }

    return params;
  }, [selectedView, selectedProjectId, showCompleted, searchQuery, selectedPriority]);

  // Fetch Tasks
  const { data: tasksData, isLoading: tasksLoading } = useQuery({
    queryKey: ['tasks', taskQueryParams],
    queryFn: () => api.get<{ tasks: TaskSummaryRow[]; total: number }>('/api/tasks', taskQueryParams),
    enabled: canAny('task.read'),
  });

  const tasks = tasksData?.tasks ?? [];

  // Archive / Delete project mutation
  const archiveProjectMutation = useMutation({
    mutationFn: (id: number) => api.patch(`/api/task-projects/${id}`, { isArchived: true }),
    onSuccess: () => {
      toast.add({ title: 'Project archived', type: 'success' });
      queryClient.invalidateQueries({ queryKey: ['task-projects'] });
      if (selectedProjectId) {
        setSelectedProjectId(null);
        setSelectedView('inbox');
      }
    },
    onError: (err: Error) => {
      toast.add({
        title: 'Could not archive project',
        description: err instanceof ApiError ? err.message : err.message,
        type: 'error',
      });
    },
  });

  if (permissionsLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6">
        <p className="py-16 text-center text-sm text-muted-foreground">Loading permissions…</p>
      </div>
    );
  }

  if (!canAny('task.read')) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
          <p className="text-sm text-muted-foreground">Work-related task tracking and assignments.</p>
        </header>
        <Alert>
          Your account does not have access to view tasks. Ask an administrator for the{' '}
          <code className="font-mono">task.read</code> permission.
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      {/* Top Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between border-b pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {selectedView === 'project' && currentProject ? currentProject.name : (
                selectedView === 'today' ? 'Today' :
                selectedView === 'upcoming' ? 'Upcoming' :
                selectedView === 'assignedToMe' ? 'Assigned to Me' : 'Inbox'
              )}
            </h1>
            {selectedView === 'project' && currentProject && (
              <span
                className="size-3 rounded-full"
                style={{ backgroundColor: currentProject.color }}
              />
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {selectedView === 'today' && 'Tasks due today or needing immediate attention.'}
            {selectedView === 'upcoming' && 'Scheduled tasks and upcoming commitments.'}
            {selectedView === 'assignedToMe' && 'Tasks assigned to you across all projects and jobs.'}
            {selectedView === 'inbox' && 'Central capture list for all active work items.'}
            {selectedView === 'project' && (currentProject?.description || 'Custom project workspace.')}
          </p>
        </div>

        {/* View Switcher & Global Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Mode toggle (List vs Board) */}
          <div className="inline-flex rounded-lg border bg-muted/40 p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all',
                viewMode === 'list'
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <ListTodo className="size-3.5" />
              List
            </button>
            <button
              type="button"
              onClick={() => setViewMode('kanban')}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all',
                viewMode === 'kanban'
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Columns3 className="size-3.5" />
              Board
            </button>
          </div>

          {/* Group By selector (List view only) */}
          {viewMode === 'list' && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="gap-1.5 text-xs font-normal" />}>
                <SlidersHorizontal className="size-3.5 text-muted-foreground" />
                <span>Group: {groupBy === 'dueDate' ? 'Due Date' : groupBy === 'priority' ? 'Priority' : groupBy === 'status' ? 'Status' : 'None'}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Group Tasks By</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => setGroupBy('dueDate')}>Due Date</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setGroupBy('priority')}>Priority</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setGroupBy('status')}>Status</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setGroupBy('none')}>None (Flat List)</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Show completed toggle button */}
          <Button
            variant={showCompleted ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setShowCompleted(!showCompleted)}
            className="text-xs font-normal gap-1.5"
          >
            <CheckCircle2 className="size-3.5 text-muted-foreground" />
            {showCompleted ? 'Completed: Shown' : 'Completed: Hidden'}
          </Button>
        </div>
      </div>

      {/* Main Two-Column Layout */}
      <div className="grid grid-cols-1 md:grid-cols-4 lg:grid-cols-5 gap-6 items-start">
        {/* Left Sidebar Navigation */}
        <aside className="space-y-6 md:col-span-1">
          {/* Standard Navigation */}
          <nav className="space-y-1">
            <button
              type="button"
              onClick={() => {
                setSelectedView('inbox');
                setSelectedProjectId(null);
              }}
              className={cn(
                'flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                selectedView === 'inbox'
                  ? 'bg-primary/10 text-primary font-semibold'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <span className="flex items-center gap-2.5">
                <Inbox className="size-4" />
                Inbox
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setSelectedView('today');
                setSelectedProjectId(null);
              }}
              className={cn(
                'flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                selectedView === 'today'
                  ? 'bg-primary/10 text-primary font-semibold'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <span className="flex items-center gap-2.5">
                <Sun className="size-4 text-amber-500" />
                Today
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setSelectedView('upcoming');
                setSelectedProjectId(null);
              }}
              className={cn(
                'flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                selectedView === 'upcoming'
                  ? 'bg-primary/10 text-primary font-semibold'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <span className="flex items-center gap-2.5">
                <CalendarDays className="size-4 text-purple-500" />
                Upcoming
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setSelectedView('assignedToMe');
                setSelectedProjectId(null);
              }}
              className={cn(
                'flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                selectedView === 'assignedToMe'
                  ? 'bg-primary/10 text-primary font-semibold'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <span className="flex items-center gap-2.5">
                <UserCheck className="size-4 text-blue-500" />
                Assigned to Me
              </span>
            </button>
          </nav>

          {/* Task Projects Section */}
          <div className="space-y-2 border-t pt-4">
            <div className="flex items-center justify-between px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <span>Projects</span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => {
                  setEditingProject(null);
                  setProjectDialogOpen(true);
                }}
                title="Create Project"
              >
                <Plus className="size-3.5" />
              </Button>
            </div>

            <div className="space-y-0.5 max-h-60 overflow-y-auto">
              {projects.map((proj) => {
                const isSelected = selectedView === 'project' && selectedProjectId === proj.id;

                return (
                  <div
                    key={proj.id}
                    className={cn(
                      'group flex items-center justify-between rounded-lg px-3 py-1.5 text-sm transition-colors',
                      isSelected
                        ? 'bg-primary/10 text-primary font-semibold'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedView('project');
                        setSelectedProjectId(proj.id);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    >
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: proj.color }}
                      />
                      <span className="truncate">{proj.name}</span>
                    </button>

                    <div className="flex items-center gap-1">
                      {proj.activeTaskCount > 0 && (
                        <span className="rounded-full bg-muted px-1.5 py-0.2 text-[10px] text-muted-foreground font-normal">
                          {proj.activeTaskCount}
                        </span>
                      )}

                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <button
                              type="button"
                              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted-foreground hover:text-foreground transition-opacity cursor-pointer"
                              aria-label="Project options"
                            >
                              <MoreVertical className="size-3.5" />
                            </button>
                          }
                        />
                        <DropdownMenuContent align="end" className="w-36">
                          <DropdownMenuItem
                            onClick={() => {
                              setEditingProject(proj);
                              setProjectDialogOpen(true);
                            }}
                          >
                            <Edit2 className="size-3.5 mr-1.5" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => {
                              if (confirm(`Archive project "${proj.name}"?`)) {
                                archiveProjectMutation.mutate(proj.id);
                              }
                            }}
                          >
                            Archive
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                );
              })}

              {projects.length === 0 && !projectsLoading && (
                <p className="px-3 py-2 text-xs text-muted-foreground italic">
                  No projects yet. Click + to add.
                </p>
              )}
            </div>
          </div>

          {/* Priority Filters */}
          <div className="space-y-2 border-t pt-4">
            <span className="px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Priority Filter
            </span>
            <div className="flex flex-wrap gap-1 px-1">
              <Button
                variant={selectedPriority === null ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setSelectedPriority(null)}
                className="text-xs"
              >
                All
              </Button>
              {(['Urgent', 'High', 'Medium', 'Low'] as const).map((p) => (
                <Button
                  key={p}
                  variant={selectedPriority === p ? 'secondary' : 'ghost'}
                  size="xs"
                  onClick={() => setSelectedPriority(selectedPriority === p ? null : p)}
                  className="text-xs"
                >
                  {p}
                </Button>
              ))}
            </div>
          </div>
        </aside>

        {/* Main Workspace Area */}
        <main className="space-y-4 md:col-span-3 lg:col-span-4 min-w-0">
          {/* Search bar, priority filter, & primary "+ New Task" action button */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1">
              <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <Input
                placeholder="Search tasks by title, note, or #tag..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 pr-8"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              )}
            </div>

            {selectedPriority && (
              <Badge variant="secondary" className="gap-1 text-xs py-1.5 px-2.5">
                Priority: {selectedPriority}
                <button
                  type="button"
                  onClick={() => setSelectedPriority(null)}
                  className="hover:text-destructive"
                >
                  <X className="size-3" />
                </button>
              </Badge>
            )}

            {/* Prominent New Task Modal Trigger Button */}
            <Button
              onClick={() => {
                setCreateDialogStatus('Todo');
                setCreateDialogOpen(true);
              }}
              className="gap-1.5 shrink-0"
            >
              <Plus className="size-4" />
              New Task
            </Button>
          </div>

          {/* Active View Content */}
          {viewMode === 'list' ? (
            <TaskListView
              tasks={tasks}
              isLoading={tasksLoading}
              selectedTaskId={selectedTaskId}
              onSelectTask={(id) => setSelectedTaskId(id)}
              groupBy={groupBy}
              showCompleted={showCompleted}
              onQuickAdd={() => {
                setCreateDialogStatus('Todo');
                setCreateDialogOpen(true);
              }}
            />
          ) : (
            <TaskKanbanView
              tasks={tasks}
              isLoading={tasksLoading}
              selectedTaskId={selectedTaskId}
              onSelectTask={(id) => setSelectedTaskId(id)}
              onQuickAddForStatus={(colStatus) => {
                setCreateDialogStatus(colStatus);
                setCreateDialogOpen(true);
              }}
            />
          )}
        </main>
      </div>

      {/* Create Task Modal Dialog */}
      <TaskCreateDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        defaultStatus={createDialogStatus}
        defaultProjectId={selectedView === 'project' ? selectedProjectId : null}
        projects={projects}
        onCreated={(newTask) => {
          setSelectedTaskId(newTask.id);
        }}
      />

      {/* Slide-over Inspection Sheet */}
      <TaskDetailSheet
        taskId={selectedTaskId}
        open={Boolean(selectedTaskId)}
        onOpenChange={(open) => !open && setSelectedTaskId(null)}
        projects={projects}
        onSelectTask={(id) => setSelectedTaskId(id)}
      />

      {/* Create / Edit Project Dialog */}
      <TaskProjectDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
        project={editingProject}
        onSaved={(saved) => {
          setSelectedView('project');
          setSelectedProjectId(saved.id);
        }}
      />
    </div>
  );
}
