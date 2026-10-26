/**
 * Request/response schemas for the Work-related Task Tracking Module.
 *
 * Shared verbatim between client forms and server routes.
 */
import { z } from 'zod';
import { taskPrioritySchema, taskStatusSchema } from './enums';

// ---------------------------------------------------------------------------
// Task Projects / Workspaces
// ---------------------------------------------------------------------------

export const taskProjectCreateSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required.').max(100),
  description: z.string().trim().optional().nullable(),
  color: z.string().trim().max(30).default('#3b82f6'),
  icon: z.string().trim().max(50).default('Folder'),
});
export type TaskProjectCreateInput = z.infer<typeof taskProjectCreateSchema>;

export const taskProjectUpdateSchema = taskProjectCreateSchema.partial().extend({
  isArchived: z.boolean().optional(),
});
export type TaskProjectUpdateInput = z.infer<typeof taskProjectUpdateSchema>;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const taskCreateSchema = z.object({
  title: z.string().trim().min(1, 'Task title is required.').max(255),
  description: z.string().trim().optional().nullable(),
  status: taskStatusSchema.default('Todo'),
  priority: taskPrioritySchema.default('Medium'),
  dueDate: z.string().optional().nullable(),
  dueHasTime: z.boolean().default(false),
  isPrivate: z.boolean().default(false),
  sortOrder: z.coerce.number().int().default(0),
  taskProjectId: z.coerce.number().int().positive().optional().nullable(),
  erpProjectId: z.coerce.number().int().positive().optional().nullable(),
  jobId: z.coerce.number().int().positive().optional().nullable(),
  parentId: z.coerce.number().int().positive().optional().nullable(),
  assigneeIds: z.array(z.coerce.number().int().positive()).optional(),
  tagIds: z.array(z.coerce.number().int().positive()).optional(),
});
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;

export const taskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().optional().nullable(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  dueDate: z.string().optional().nullable(),
  dueHasTime: z.boolean().optional(),
  isPrivate: z.boolean().optional(),
  sortOrder: z.coerce.number().int().optional(),
  taskProjectId: z.coerce.number().int().positive().optional().nullable(),
  erpProjectId: z.coerce.number().int().positive().optional().nullable(),
  jobId: z.coerce.number().int().positive().optional().nullable(),
  parentId: z.coerce.number().int().positive().optional().nullable(),
});
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;

export const taskQuerySchema = z.object({
  status: z.string().trim().optional(),
  priority: z.string().trim().optional(),
  taskProjectId: z.coerce.number().int().positive().optional(),
  erpProjectId: z.coerce.number().int().positive().optional(),
  jobId: z.coerce.number().int().positive().optional(),
  assigneeId: z.coerce.number().int().positive().optional(),
  assignedToMe: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  due: z.enum(['today', 'upcoming', 'overdue', 'nodate']).optional(),
  search: z.string().trim().optional(),
  includeCompleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  parentId: z.coerce.number().int().positive().optional().nullable(),
});
export type TaskQueryInput = z.infer<typeof taskQuerySchema>;

// ---------------------------------------------------------------------------
// Assignees
// ---------------------------------------------------------------------------

export const taskAssigneeSchema = z.object({
  userIds: z.array(z.coerce.number().int().positive()).min(1, 'Select at least one user.'),
});
export type TaskAssigneeInput = z.infer<typeof taskAssigneeSchema>;

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

export const taskChecklistItemCreateSchema = z.object({
  title: z.string().trim().min(1, 'Item title is required.').max(255),
  sortOrder: z.coerce.number().int().default(0),
});
export type TaskChecklistItemCreateInput = z.infer<typeof taskChecklistItemCreateSchema>;

export const taskChecklistItemUpdateSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  isDone: z.boolean().optional(),
  sortOrder: z.coerce.number().int().optional(),
});
export type TaskChecklistItemUpdateInput = z.infer<typeof taskChecklistItemUpdateSchema>;

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export const taskCommentCreateSchema = z.object({
  content: z.string().trim().min(1, 'Comment cannot be empty.'),
});
export type TaskCommentCreateInput = z.infer<typeof taskCommentCreateSchema>;

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export const taskTagCreateSchema = z.object({
  name: z.string().trim().min(1, 'Tag name is required.').max(50),
  color: z.string().trim().max(30).default('#64748b'),
});
export type TaskTagCreateInput = z.infer<typeof taskTagCreateSchema>;
