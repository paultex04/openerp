'use client';

/**
 * Dialog for creating or editing a standalone Task Project / List.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { api, ApiError, type TaskProjectRow } from '@/lib/api';

const COLOR_PRESETS = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#64748b', // slate
];

const ICON_PRESETS = [
  'Folder',
  'Briefcase',
  'HardHat',
  'CheckCircle',
  'Shield',
  'Tag',
  'Zap',
  'Star',
];

interface TaskProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: TaskProjectRow | null;
  onSaved?: (project: TaskProjectRow) => void;
}

export function TaskProjectDialog({
  open,
  onOpenChange,
  project,
  onSaved,
}: TaskProjectDialogProps) {
  const queryClient = useQueryClient();
  const isEditing = Boolean(project);

  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [color, setColor] = useState(project?.color ?? '#3b82f6');
  const [icon, setIcon] = useState(project?.icon ?? 'Folder');

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        color,
        icon,
      };

      if (isEditing && project) {
        return api.patch<{ project: TaskProjectRow }>(`/api/task-projects/${project.id}`, payload);
      }
      return api.post<{ project: TaskProjectRow }>('/api/task-projects', payload);
    },
    onSuccess: async (data) => {
      toast.add({
        title: isEditing ? 'Project updated' : 'Project created',
        type: 'success',
      });
      await queryClient.invalidateQueries({ queryKey: ['task-projects'] });
      onOpenChange(false);
      if (data?.project) {
        onSaved?.(data.project);
      }
    },
    onError: (e: Error) => {
      toast.add({
        title: 'Could not save project',
        description: e instanceof ApiError ? e.message : e.message,
        type: 'error',
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    saveMutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Project' : 'New Task Project'}</DialogTitle>
          <DialogDescription>
            Group tasks into dedicated workspaces or lists (e.g. Safety, Maintenance, Client Prep).
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="project-name">Project Name</FieldLabel>
            <Input
              id="project-name"
              placeholder="e.g. Substation Maintenance"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="project-desc">Description (optional)</FieldLabel>
            <Input
              id="project-desc"
              placeholder="Brief context or scope"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel>Color</FieldLabel>
            <div className="flex flex-wrap gap-2 pt-1">
              {COLOR_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setColor(preset)}
                  className={`size-6 rounded-full transition-transform ${
                    color === preset ? 'scale-125 ring-2 ring-primary ring-offset-2' : 'hover:scale-110'
                  }`}
                  style={{ backgroundColor: preset }}
                  aria-label={`Select color ${preset}`}
                />
              ))}
            </div>
          </Field>

          <Field>
            <FieldLabel>Icon</FieldLabel>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {ICON_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setIcon(preset)}
                  className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                    icon === preset
                      ? 'border-primary bg-primary/10 text-primary font-medium'
                      : 'border-border hover:bg-muted text-muted-foreground'
                  }`}
                >
                  {preset}
                </button>
              ))}
            </div>
          </Field>

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saveMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saveMutation.isPending || !name.trim()}>
              {saveMutation.isPending ? 'Saving…' : isEditing ? 'Save Changes' : 'Create Project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
