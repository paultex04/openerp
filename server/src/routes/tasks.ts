/**
 * Work-related Task Tracking Module API (Todoist-style).
 *
 * RBAC:
 *   task.read   — view tasks, checklists, projects, tags, comments and activity
 *   task.write  — create and update tasks, assignments, checklists, comments, tags
 *   task.delete — delete tasks and projects (admin or task creator)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ROLE_ADMINISTRATOR,
  taskAssigneeSchema,
  taskChecklistItemCreateSchema,
  taskChecklistItemUpdateSchema,
  taskCommentCreateSchema,
  taskCreateSchema,
  taskPriorityFromKey,
  taskPriorityToKey,
  taskProjectCreateSchema,
  taskProjectUpdateSchema,
  taskQuerySchema,
  taskStatusFromKey,
  taskStatusToKey,
  taskTagCreateSchema,
  taskUpdateSchema,
  type PrismaTaskPriority,
  type PrismaTaskStatus,
} from '@openerp/shared';
import { prisma } from '../db/client.js';
import { HttpError } from '../auth/plugin.js';
import type { Prisma } from '../generated/prisma/client.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const itemIdParam = z.object({
  id: z.coerce.number().int().positive(),
  itemId: z.coerce.number().int().positive(),
});
const userIdParam = z.object({
  id: z.coerce.number().int().positive(),
  userId: z.coerce.number().int().positive(),
});

const USER_SUMMARY_SELECT = {
  id: true,
  email: true,
  avatarUpdatedAt: true,
  employee: { select: { name: true, surname: true } },
};

function formatUser(user: {
  id: number;
  email: string;
  avatarUpdatedAt: Date | null;
  employee: { name: string; surname: string };
}) {
  return {
    id: user.id,
    email: user.email,
    name: `${user.employee.name} ${user.employee.surname}`.trim(),
    avatarUpdatedAt: user.avatarUpdatedAt?.toISOString() ?? null,
  };
}

export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  // --- Task Projects --------------------------------------------------------

  app.get(
    '/api/task-projects',
    { preHandler: [app.authenticate, app.requirePermission('task.read')] },
    async () => {
      const projects = await prisma.taskProject.findMany({
        where: { isArchived: false },
        orderBy: [{ name: 'asc' }],
        include: {
          creator: { select: USER_SUMMARY_SELECT },
          _count: {
            select: {
              tasks: {
                where: { deletedAt: null, status: { notIn: ['DONE', 'CANCELLED'] } },
              },
            },
          },
        },
      });

      return {
        projects: projects.map((p) => ({
          ...p,
          creator: formatUser(p.creator),
          activeTaskCount: p._count.tasks,
        })),
      };
    },
  );

  app.post(
    '/api/task-projects',
    { preHandler: [app.authenticate, app.requirePermission('task.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = request.principal!;
      const body = taskProjectCreateSchema.parse(request.body);

      const created = await prisma.taskProject.create({
        data: {
          name: body.name,
          description: body.description ?? null,
          color: body.color,
          icon: body.icon,
          creatorId: principal.userId,
        },
        include: {
          creator: { select: USER_SUMMARY_SELECT },
        },
      });

      return reply.code(201).send({
        project: {
          ...created,
          creator: formatUser(created.creator),
          activeTaskCount: 0,
        },
      });
    },
  );

  app.patch(
    '/api/task-projects/:id',
    { preHandler: [app.authenticate, app.requirePermission('task.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = taskProjectUpdateSchema.parse(request.body);

      const existing = await prisma.taskProject.findUnique({ where: { id } });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', `Task project ${id} does not exist.`);

      const updated = await prisma.taskProject.update({
        where: { id },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.color !== undefined && { color: body.color }),
          ...(body.icon !== undefined && { icon: body.icon }),
          ...(body.isArchived !== undefined && { isArchived: body.isArchived }),
        },
        include: {
          creator: { select: USER_SUMMARY_SELECT },
          _count: {
            select: {
              tasks: { where: { deletedAt: null, status: { notIn: ['DONE', 'CANCELLED'] } } },
            },
          },
        },
      });

      return reply.code(200).send({
        project: {
          ...updated,
          creator: formatUser(updated.creator),
          activeTaskCount: updated._count.tasks,
        },
      });
    },
  );

  // --- Task Tags ------------------------------------------------------------

  app.get(
    '/api/task-tags',
    { preHandler: [app.authenticate, app.requirePermission('task.read')] },
    async () => {
      const tags = await prisma.taskTag.findMany({
        orderBy: { name: 'asc' },
      });
      return { tags };
    },
  );

  app.post(
    '/api/task-tags',
    { preHandler: [app.authenticate, app.requirePermission('task.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = taskTagCreateSchema.parse(request.body);

      const existing = await prisma.taskTag.findUnique({
        where: { name: body.name },
      });
      if (existing) {
        return reply.code(200).send({ tag: existing });
      }

      const created = await prisma.taskTag.create({
        data: {
          name: body.name,
          color: body.color,
        },
      });

      return reply.code(201).send({ tag: created });
    },
  );

  // --- Assignable Users Directory -------------------------------------------

  app.get(
    '/api/users/assignable',
    { preHandler: [app.authenticate, app.requirePermission('task.read')] },
    async () => {
      const users = await prisma.appUser.findMany({
        where: { isActive: true },
        select: USER_SUMMARY_SELECT,
        orderBy: [{ employee: { surname: 'asc' } }, { employee: { name: 'asc' } }],
      });

      return {
        users: users.map(formatUser),
      };
    },
  );

  // --- Tasks List & Filtering -----------------------------------------------

  app.get(
    '/api/tasks',
    { preHandler: [app.authenticate, app.requirePermission('task.read')] },
    async (request: FastifyRequest) => {
      const principal = request.principal!;
      const query = taskQuerySchema.parse(request.query ?? {});
      const isAdmin = principal.roleKeys.includes(ROLE_ADMINISTRATOR);

      // Privacy barrier: non-admins only see public tasks or tasks they created/are assigned to
      const privacyFilter = isAdmin
        ? {}
        : {
            OR: [
              { isPrivate: false },
              { creatorId: principal.userId },
              { assignees: { some: { userId: principal.userId } } },
            ],
          };

      // Due date filter computations
      let dueDateFilter: Record<string, unknown> | undefined;
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

      if (query.due === 'today') {
        dueDateFilter = { gte: startOfToday, lte: endOfToday };
      } else if (query.due === 'upcoming') {
        dueDateFilter = { gt: endOfToday };
      } else if (query.due === 'overdue') {
        dueDateFilter = { lt: startOfToday };
      } else if (query.due === 'nodate') {
        dueDateFilter = { equals: null };
      }

      const tasks = await prisma.task.findMany({
        where: {
          deletedAt: null,
          ...privacyFilter,
          ...(query.status !== undefined && {
            status: taskStatusToKey(query.status) as PrismaTaskStatus,
          }),
          ...(query.status === undefined &&
            !query.includeCompleted && {
              status: { notIn: ['DONE', 'CANCELLED'] as PrismaTaskStatus[] },
            }),
          ...(query.priority !== undefined && {
            priority: taskPriorityToKey(query.priority) as PrismaTaskPriority,
          }),
          ...(query.taskProjectId !== undefined && { taskProjectId: query.taskProjectId }),
          ...(query.erpProjectId !== undefined && { erpProjectId: query.erpProjectId }),
          ...(query.jobId !== undefined && { jobId: query.jobId }),
          ...(query.parentId !== undefined && { parentId: query.parentId }),
          ...(query.parentId === undefined && { parentId: null }), // By default list top-level tasks
          ...(query.assignedToMe && { assignees: { some: { userId: principal.userId } } }),
          ...(query.assigneeId !== undefined && {
            assignees: { some: { userId: query.assigneeId } },
          }),
          ...(dueDateFilter !== undefined && { dueDate: dueDateFilter }),
          ...(query.search && {
            OR: [
              { title: { contains: query.search, mode: 'insensitive' as const } },
              { description: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }),
        },
        orderBy: [
          { status: 'asc' },
          { sortOrder: 'asc' },
          { dueDate: 'asc' },
          { createdAt: 'desc' },
        ],
        include: {
          creator: { select: USER_SUMMARY_SELECT },
          assignees: {
            include: {
              user: { select: USER_SUMMARY_SELECT },
            },
          },
          tags: {
            include: { tag: true },
          },
          taskProject: {
            select: { id: true, name: true, color: true, icon: true },
          },
          erpProject: {
            select: { id: true, code: true, description: true },
          },
          job: {
            select: { id: true, workOrder: true },
          },
          checklists: {
            select: { id: true, isDone: true },
          },
          _count: {
            select: { subtasks: true, comments: true },
          },
        },
      });

      return {
        tasks: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          status: taskStatusFromKey(t.status),
          priority: taskPriorityFromKey(t.priority),
          dueDate: t.dueDate?.toISOString() ?? null,
          dueHasTime: t.dueHasTime,
          isPrivate: t.isPrivate,
          sortOrder: t.sortOrder,
          taskProjectId: t.taskProjectId,
          erpProjectId: t.erpProjectId,
          jobId: t.jobId,
          parentId: t.parentId,
          creator: formatUser(t.creator),
          completedAt: t.completedAt?.toISOString() ?? null,
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
          assignees: t.assignees.map((a) => ({
            id: a.id,
            userId: a.userId,
            user: formatUser(a.user),
          })),
          tags: t.tags.map((tg) => tg.tag),
          taskProject: t.taskProject,
          erpProject: t.erpProject,
          job: t.job,
          checklistCount: t.checklists.length,
          checklistDoneCount: t.checklists.filter((c) => c.isDone).length,
          subtaskCount: t._count.subtasks,
          commentCount: t._count.comments,
        })),
      };
    },
  );

  // --- Task Detail ----------------------------------------------------------

  app.get(
    '/api/tasks/:id',
    { preHandler: [app.authenticate, app.requirePermission('task.read')] },
    async (request: FastifyRequest) => {
      const { id } = idParam.parse(request.params);
      const principal = request.principal!;
      const isAdmin = principal.roleKeys.includes(ROLE_ADMINISTRATOR);

      const task = await prisma.task.findUnique({
        where: { id },
        include: {
          creator: { select: USER_SUMMARY_SELECT },
          completedBy: { select: USER_SUMMARY_SELECT },
          taskProject: { select: { id: true, name: true, color: true, icon: true } },
          erpProject: { select: { id: true, code: true, description: true } },
          job: { select: { id: true, workOrder: true } },
          parent: { select: { id: true, title: true, status: true } },
          assignees: {
            include: {
              user: { select: USER_SUMMARY_SELECT },
              assignedBy: { select: USER_SUMMARY_SELECT },
            },
          },
          tags: {
            include: { tag: true },
          },
          checklists: {
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          },
          subtasks: {
            where: { deletedAt: null },
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
            include: {
              assignees: {
                include: { user: { select: USER_SUMMARY_SELECT } },
              },
            },
          },
          comments: {
            orderBy: { createdAt: 'asc' },
            include: {
              author: { select: USER_SUMMARY_SELECT },
            },
          },
          activities: {
            orderBy: { createdAt: 'desc' },
            take: 30,
            include: {
              actor: { select: USER_SUMMARY_SELECT },
            },
          },
        },
      });

      if (!task || task.deletedAt !== null) {
        throw new HttpError(404, 'NOT_FOUND', `Task ${id} does not exist.`);
      }

      // Privacy check
      if (
        task.isPrivate &&
        !isAdmin &&
        task.creatorId !== principal.userId &&
        !task.assignees.some((a) => a.userId === principal.userId)
      ) {
        throw new HttpError(404, 'NOT_FOUND', `Task ${id} does not exist.`);
      }

      return {
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          status: taskStatusFromKey(task.status),
          priority: taskPriorityFromKey(task.priority),
          dueDate: task.dueDate?.toISOString() ?? null,
          dueHasTime: task.dueHasTime,
          isPrivate: task.isPrivate,
          sortOrder: task.sortOrder,
          taskProjectId: task.taskProjectId,
          erpProjectId: task.erpProjectId,
          jobId: task.jobId,
          parentId: task.parentId,
          creator: formatUser(task.creator),
          completedBy: task.completedBy ? formatUser(task.completedBy) : null,
          completedAt: task.completedAt?.toISOString() ?? null,
          createdAt: task.createdAt.toISOString(),
          updatedAt: task.updatedAt.toISOString(),
          taskProject: task.taskProject,
          erpProject: task.erpProject,
          job: task.job,
          parent: task.parent
            ? {
                ...task.parent,
                status: taskStatusFromKey(task.parent.status),
              }
            : null,
          assignees: task.assignees.map((a) => ({
            id: a.id,
            userId: a.userId,
            assignedAt: a.assignedAt.toISOString(),
            assignedBy: a.assignedBy ? formatUser(a.assignedBy) : null,
            user: formatUser(a.user),
          })),
          tags: task.tags.map((tg) => tg.tag),
          checklists: task.checklists.map((c) => ({
            id: c.id,
            title: c.title,
            isDone: c.isDone,
            sortOrder: c.sortOrder,
            createdAt: c.createdAt.toISOString(),
          })),
          subtasks: task.subtasks.map((st) => ({
            id: st.id,
            title: st.title,
            status: taskStatusFromKey(st.status),
            priority: taskPriorityFromKey(st.priority),
            dueDate: st.dueDate?.toISOString() ?? null,
            assignees: st.assignees.map((a) => formatUser(a.user)),
          })),
          comments: task.comments.map((cm) => ({
            id: cm.id,
            content: cm.content,
            createdAt: cm.createdAt.toISOString(),
            updatedAt: cm.updatedAt.toISOString(),
            author: formatUser(cm.author),
          })),
          activities: task.activities.map((act) => ({
            id: act.id,
            action: act.action,
            details: act.details,
            createdAt: act.createdAt.toISOString(),
            actor: formatUser(act.actor),
          })),
        },
      };
    },
  );

  // --- Create Task ----------------------------------------------------------

  app.post(
    '/api/tasks',
    { preHandler: [app.authenticate, app.requirePermission('task.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = request.principal!;
      const body = taskCreateSchema.parse(request.body);

      // Validate parent task if specified
      if (body.parentId) {
        const parent = await prisma.task.findUnique({
          where: { id: body.parentId },
          select: { id: true, deletedAt: true },
        });
        if (!parent || parent.deletedAt !== null) {
          throw new HttpError(400, 'INVALID_PARENT', `Parent task ${body.parentId} does not exist.`);
        }
      }

      const task = await prisma.$transaction(async (tx) => {
        const created = await tx.task.create({
          data: {
            title: body.title,
            description: body.description ?? null,
            status: taskStatusToKey(body.status) as PrismaTaskStatus,
            priority: taskPriorityToKey(body.priority) as PrismaTaskPriority,
            dueDate: body.dueDate ? new Date(body.dueDate) : null,
            dueHasTime: body.dueHasTime,
            isPrivate: body.isPrivate,
            sortOrder: body.sortOrder,
            taskProjectId: body.taskProjectId ?? null,
            erpProjectId: body.erpProjectId ?? null,
            jobId: body.jobId ?? null,
            parentId: body.parentId ?? null,
            creatorId: principal.userId,
            ...(body.status === 'Done' && {
              completedAt: new Date(),
              completedById: principal.userId,
            }),
          },
        });

        // Add initial assignees if provided
        if (body.assigneeIds && body.assigneeIds.length > 0) {
          const uniqueUserIds = [...new Set(body.assigneeIds)];
          for (const uid of uniqueUserIds) {
            await tx.taskAssignee.create({
              data: {
                taskId: created.id,
                userId: uid,
                assignedById: principal.userId,
              },
            });
          }
        }

        // Add initial tags if provided
        if (body.tagIds && body.tagIds.length > 0) {
          const uniqueTagIds = [...new Set(body.tagIds)];
          for (const tid of uniqueTagIds) {
            await tx.taskTagAssignment.create({
              data: {
                taskId: created.id,
                tagId: tid,
              },
            });
          }
        }

        // Record creation activity
        await tx.taskActivity.create({
          data: {
            taskId: created.id,
            actorId: principal.userId,
            action: 'CREATED',
            details: {
              title: created.title,
              status: body.status,
              priority: body.priority,
            },
          },
        });

        return created;
      });

      return reply.code(201).send({
        task: {
          ...task,
          status: taskStatusFromKey(task.status),
          priority: taskPriorityFromKey(task.priority),
          dueDate: task.dueDate?.toISOString() ?? null,
          createdAt: task.createdAt.toISOString(),
          updatedAt: task.updatedAt.toISOString(),
        },
      });
    },
  );

  // --- Update Task ----------------------------------------------------------

  app.patch(
    '/api/tasks/:id',
    { preHandler: [app.authenticate, app.requirePermission('task.write')] },
    async (request: FastifyRequest) => {
      const { id } = idParam.parse(request.params);
      const principal = request.principal!;
      const body = taskUpdateSchema.parse(request.body);

      const existing = await prisma.task.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          priority: true,
          dueDate: true,
          isPrivate: true,
          creatorId: true,
          deletedAt: true,
        },
      });

      if (!existing || existing.deletedAt !== null) {
        throw new HttpError(404, 'NOT_FOUND', `Task ${id} does not exist.`);
      }

      const activitiesToRecord: Array<{ action: string; details: Prisma.InputJsonValue }> = [];

      let completedAtUpdate = undefined;
      let completedByIdUpdate = undefined;

      if (body.status !== undefined) {
        const newPrismaStatus = taskStatusToKey(body.status) as PrismaTaskStatus;
        if (newPrismaStatus !== existing.status) {
          activitiesToRecord.push({
            action: 'STATUS_CHANGED',
            details: {
              from: taskStatusFromKey(existing.status),
              to: body.status,
            },
          });

          if (newPrismaStatus === 'DONE') {
            completedAtUpdate = new Date();
            completedByIdUpdate = principal.userId;
          } else if (existing.status === 'DONE') {
            completedAtUpdate = null;
            completedByIdUpdate = null;
          }
        }
      }

      if (body.priority !== undefined) {
        const newPrismaPriority = taskPriorityToKey(body.priority) as PrismaTaskPriority;
        if (newPrismaPriority !== existing.priority) {
          activitiesToRecord.push({
            action: 'PRIORITY_CHANGED',
            details: {
              from: taskPriorityFromKey(existing.priority),
              to: body.priority,
            },
          });
        }
      }

      const updated = await prisma.$transaction(async (tx) => {
        const task = await tx.task.update({
          where: { id },
          data: {
            ...(body.title !== undefined && { title: body.title }),
            ...(body.description !== undefined && { description: body.description }),
            ...(body.status !== undefined && {
              status: taskStatusToKey(body.status) as PrismaTaskStatus,
            }),
            ...(body.priority !== undefined && {
              priority: taskPriorityToKey(body.priority) as PrismaTaskPriority,
            }),
            ...(body.dueDate !== undefined && {
              dueDate: body.dueDate ? new Date(body.dueDate) : null,
            }),
            ...(body.dueHasTime !== undefined && { dueHasTime: body.dueHasTime }),
            ...(body.isPrivate !== undefined && { isPrivate: body.isPrivate }),
            ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
            ...(body.taskProjectId !== undefined && { taskProjectId: body.taskProjectId }),
            ...(body.erpProjectId !== undefined && { erpProjectId: body.erpProjectId }),
            ...(body.jobId !== undefined && { jobId: body.jobId }),
            ...(body.parentId !== undefined && { parentId: body.parentId }),
            ...(completedAtUpdate !== undefined && { completedAt: completedAtUpdate }),
            ...(completedByIdUpdate !== undefined && { completedById: completedByIdUpdate }),
          },
        });

        for (const act of activitiesToRecord) {
          await tx.taskActivity.create({
            data: {
              taskId: id,
              actorId: principal.userId,
              action: act.action,
              details: act.details,
            },
          });
        }

        return task;
      });

      return {
        task: {
          ...updated,
          status: taskStatusFromKey(updated.status),
          priority: taskPriorityFromKey(updated.priority),
          dueDate: updated.dueDate?.toISOString() ?? null,
          completedAt: updated.completedAt?.toISOString() ?? null,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        },
      };
    },
  );

  // --- Delete Task ----------------------------------------------------------

  app.delete(
    '/api/tasks/:id',
    { preHandler: [app.authenticate, app.requirePermission('task.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const principal = request.principal!;
      const isAdmin = principal.roleKeys.includes(ROLE_ADMINISTRATOR);

      const existing = await prisma.task.findUnique({
        where: { id },
        select: { id: true, creatorId: true },
      });

      if (!existing) {
        throw new HttpError(404, 'NOT_FOUND', `Task ${id} does not exist.`);
      }

      if (!isAdmin && existing.creatorId !== principal.userId) {
        throw new HttpError(403, 'FORBIDDEN', 'Only the task creator or an administrator can delete this task.');
      }

      await prisma.task.delete({ where: { id } });
      return reply.code(204).send();
    },
  );

  // --- Task Assignees -------------------------------------------------------

  app.post(
    '/api/tasks/:id/assignees',
    { preHandler: [app.authenticate, app.requirePermission('task.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const principal = request.principal!;
      const body = taskAssigneeSchema.parse(request.body);

      const task = await prisma.task.findUnique({
        where: { id },
        select: { id: true, deletedAt: true },
      });
      if (!task || task.deletedAt !== null) {
        throw new HttpError(404, 'NOT_FOUND', `Task ${id} does not exist.`);
      }

      for (const uid of body.userIds) {
        await prisma.taskAssignee.upsert({
          where: {
            taskId_userId: { taskId: id, userId: uid },
          },
          create: {
            taskId: id,
            userId: uid,
            assignedById: principal.userId,
          },
          update: {},
        });
      }

      await prisma.taskActivity.create({
        data: {
          taskId: id,
          actorId: principal.userId,
          action: 'ASSIGNED',
          details: { userIds: body.userIds },
        },
      });

      const updatedAssignees = await prisma.taskAssignee.findMany({
        where: { taskId: id },
        include: { user: { select: USER_SUMMARY_SELECT } },
      });

      return reply.code(200).send({
        assignees: updatedAssignees.map((a) => ({
          id: a.id,
          userId: a.userId,
          user: formatUser(a.user),
        })),
      });
    },
  );

  app.delete(
    '/api/tasks/:id/assignees/:userId',
    { preHandler: [app.authenticate, app.requirePermission('task.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, userId } = userIdParam.parse(request.params);
      const principal = request.principal!;

      await prisma.taskAssignee.deleteMany({
        where: { taskId: id, userId },
      });

      await prisma.taskActivity.create({
        data: {
          taskId: id,
          actorId: principal.userId,
          action: 'UNASSIGNED',
          details: { userId },
        },
      });

      return reply.code(204).send();
    },
  );

  // --- Checklist Items ------------------------------------------------------

  app.post(
    '/api/tasks/:id/checklist',
    { preHandler: [app.authenticate, app.requirePermission('task.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = taskChecklistItemCreateSchema.parse(request.body);

      const task = await prisma.task.findUnique({
        where: { id },
        select: { id: true, deletedAt: true },
      });
      if (!task || task.deletedAt !== null) {
        throw new HttpError(404, 'NOT_FOUND', `Task ${id} does not exist.`);
      }

      const item = await prisma.taskChecklistItem.create({
        data: {
          taskId: id,
          title: body.title,
          sortOrder: body.sortOrder,
        },
      });

      return reply.code(201).send({ item });
    },
  );

  app.patch(
    '/api/tasks/:id/checklist/:itemId',
    { preHandler: [app.authenticate, app.requirePermission('task.write')] },
    async (request: FastifyRequest) => {
      const { id, itemId } = itemIdParam.parse(request.params);
      const body = taskChecklistItemUpdateSchema.parse(request.body);

      const existing = await prisma.taskChecklistItem.findFirst({
        where: { id: itemId, taskId: id },
      });
      if (!existing) {
        throw new HttpError(404, 'NOT_FOUND', `Checklist item ${itemId} does not exist on task ${id}.`);
      }

      const updated = await prisma.taskChecklistItem.update({
        where: { id: itemId },
        data: {
          ...(body.title !== undefined && { title: body.title }),
          ...(body.isDone !== undefined && { isDone: body.isDone }),
          ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
        },
      });

      return { item: updated };
    },
  );

  app.delete(
    '/api/tasks/:id/checklist/:itemId',
    { preHandler: [app.authenticate, app.requirePermission('task.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, itemId } = itemIdParam.parse(request.params);

      await prisma.taskChecklistItem.deleteMany({
        where: { id: itemId, taskId: id },
      });

      return reply.code(204).send();
    },
  );

  // --- Comments -------------------------------------------------------------

  app.post(
    '/api/tasks/:id/comments',
    { preHandler: [app.authenticate, app.requirePermission('task.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const principal = request.principal!;
      const body = taskCommentCreateSchema.parse(request.body);

      const task = await prisma.task.findUnique({
        where: { id },
        select: { id: true, deletedAt: true },
      });
      if (!task || task.deletedAt !== null) {
        throw new HttpError(404, 'NOT_FOUND', `Task ${id} does not exist.`);
      }

      const comment = await prisma.$transaction(async (tx) => {
        const cm = await tx.taskComment.create({
          data: {
            taskId: id,
            authorId: principal.userId,
            content: body.content,
          },
          include: {
            author: { select: USER_SUMMARY_SELECT },
          },
        });

        await tx.taskActivity.create({
          data: {
            taskId: id,
            actorId: principal.userId,
            action: 'COMMENT_ADDED',
            details: { commentId: cm.id },
          },
        });

        return cm;
      });

      return reply.code(201).send({
        comment: {
          id: comment.id,
          content: comment.content,
          createdAt: comment.createdAt.toISOString(),
          updatedAt: comment.updatedAt.toISOString(),
          author: formatUser(comment.author),
        },
      });
    },
  );
}
