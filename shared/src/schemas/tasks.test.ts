import { describe, expect, it } from 'vitest';
import {
  taskCreateSchema,
  taskProjectCreateSchema,
  taskQuerySchema,
  taskUpdateSchema,
} from './tasks';
import { taskPriorityToKey, taskPriorityFromKey, taskStatusToKey, taskStatusFromKey } from './prisma-enums';

describe('Task schemas & enums', () => {
  it('validates a complete task create payload', () => {
    const parsed = taskCreateSchema.parse({
      title: 'Inspect switchgear on substation 4',
      description: 'Check circuit breakers and oil levels.',
      status: 'In Progress',
      priority: 'Urgent',
      dueDate: '2026-11-01T10:00:00.000Z',
      dueHasTime: true,
      isPrivate: false,
      assigneeIds: [1, 2],
      tagIds: [5],
    });

    expect(parsed.title).toBe('Inspect switchgear on substation 4');
    expect(parsed.status).toBe('In Progress');

    const updated = taskUpdateSchema.parse({
      title: 'Updated title',
      status: 'Done',
    });
    expect(updated.title).toBe('Updated title');
    expect(updated.status).toBe('Done');
    expect(parsed.priority).toBe('Urgent');
    expect(parsed.assigneeIds).toEqual([1, 2]);
  });

  it('applies defaults for minimal task payload', () => {
    const parsed = taskCreateSchema.parse({
      title: 'Order replacement relays',
    });

    expect(parsed.status).toBe('Todo');
    expect(parsed.priority).toBe('Medium');
    expect(parsed.isPrivate).toBe(false);
    expect(parsed.sortOrder).toBe(0);
  });

  it('rejects empty task title', () => {
    expect(() => taskCreateSchema.parse({ title: '   ' })).toThrow();
  });

  it('validates task project creation', () => {
    const parsed = taskProjectCreateSchema.parse({
      name: 'Substation Maintenance',
      description: 'Annual servicing project tasks',
      color: '#ef4444',
      icon: 'HardHat',
    });

    expect(parsed.name).toBe('Substation Maintenance');
    expect(parsed.color).toBe('#ef4444');
    expect(parsed.icon).toBe('HardHat');
  });

  it('translates status and priority labels to/from Prisma keys correctly', () => {
    expect(taskStatusToKey('Todo')).toBe('TODO');
    expect(taskStatusToKey('In Progress')).toBe('IN_PROGRESS');
    expect(taskStatusToKey('Blocked')).toBe('BLOCKED');
    expect(taskStatusToKey('Done')).toBe('DONE');
    expect(taskStatusToKey('Cancelled')).toBe('CANCELLED');

    expect(taskStatusFromKey('IN_PROGRESS')).toBe('In Progress');
    expect(taskStatusFromKey('TODO')).toBe('Todo');

    expect(taskPriorityToKey('Low')).toBe('LOW');
    expect(taskPriorityToKey('Medium')).toBe('MEDIUM');
    expect(taskPriorityToKey('High')).toBe('HIGH');
    expect(taskPriorityToKey('Urgent')).toBe('URGENT');

    expect(taskPriorityFromKey('URGENT')).toBe('Urgent');
    expect(taskPriorityFromKey('LOW')).toBe('Low');
  });

  it('parses task query parameters with booleans and numbers', () => {
    const parsed = taskQuerySchema.parse({
      assignedToMe: 'true',
      includeCompleted: 'false',
      taskProjectId: '3',
      due: 'today',
    });

    expect(parsed.assignedToMe).toBe(true);
    expect(parsed.includeCompleted).toBe(false);
    expect(parsed.taskProjectId).toBe(3);
    expect(parsed.due).toBe('today');
  });
});
