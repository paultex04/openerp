/**
 * Admin API: the job status workflow.
 *
 * Phase 15 item 5 made the pipeline data. This module is the editor for it:
 * statuses (create / relabel / reorder / flag / delete) and the transitions
 * between them (create / re-permission / delete). What it writes is what the API
 * enforces and what the UI renders - the same rows, read back through
 * `operations/workflow.ts`.
 *
 * RBAC map (administrator only, like every other `admin.*` grant):
 *   admin.workflow.read   - read the catalogue
 *   admin.workflow.write  - edit statuses and transitions
 *
 * ## Guardrails
 *
 * The workflow is not free-form, and the rules are enforced here rather than
 * discovered later:
 *
 *   - **A status in use cannot be deleted.** Jobs reference it by foreign key,
 *     so the database refuses anyway; the route checks first so the administrator
 *     gets "3 jobs are in this status" instead of a constraint error.
 *   - **At least one terminal status must remain.** Terminal is the only exit;
 *     a catalogue without one lets every job move forever.
 *   - **A terminal status may not have outgoing transitions.** Otherwise
 *     "terminal" would be a lie and the transition would deadlock against the
 *     engine's terminal check.
 *   - **A transition may only require a `job.transition.*` capability.** The
 *     workflow can hand out transition rights, not invent them, so a typo cannot
 *     lock a stage behind a permission nobody holds or grant one the rest of the
 *     system does not understand.
 *   - **Sort order is unique.** "Backward" is computed from it, so two statuses
 *     sharing a position would make the answer depend on row order.
 *
 * Every write drops the workflow cache so the change takes effect on the next
 * request rather than on the next restart.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@openerp/shared';
import { prisma } from '../db/client.js';
import { HttpError } from '../auth/plugin.js';
import { invalidateJobWorkflow } from '../operations/workflow.js';

/**
 * The capabilities a transition may require.
 *
 * Derived from the shared catalogue rather than re-listed, so the dropdown the
 * admin screen offers and the check the route performs can never disagree.
 */
const TRANSITION_PERMISSIONS = PERMISSIONS.filter((permission) =>
  permission.key.startsWith('job.transition.'),
).map((permission) => ({ key: permission.key, description: permission.description }));

const TRANSITION_PERMISSION_KEYS = new Set(TRANSITION_PERMISSIONS.map((p) => p.key));

/**
 * Status keys appear in job rows, audit entries and transition edges, so the
 * character set is deliberately conservative: printable, no leading whitespace,
 * no quotes, 40 characters - the width of the column.
 */
const keySchema = z
  .string()
  .trim()
  .min(1, 'A status key is required.')
  .max(40)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/,
    'A status key may only contain letters, digits, spaces, dots, underscores and hyphens.',
  );

const labelSchema = z.string().trim().min(1, 'A label is required.').max(80);

const sortOrderSchema = z.coerce.number().int().min(0).max(9999);

const createStatusSchema = z.object({
  key: keySchema,
  label: labelSchema,
  /** Defaults to "after the last status in the pipeline". */
  sortOrder: sortOrderSchema.optional(),
  isTerminal: z.boolean().optional(),
  editablePlanned: z.boolean().optional(),
  editableActuals: z.boolean().optional(),
});

const updateStatusSchema = z
  .object({
    label: labelSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
    isTerminal: z.boolean().optional(),
    editablePlanned: z.boolean().optional(),
    editableActuals: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

const createTransitionSchema = z.object({
  from: z.string().trim().min(1).max(40),
  to: z.string().trim().min(1).max(40),
  permission: z.string().trim().min(1).max(80),
  reason: z.string().trim().min(3, 'A reason is required.').max(300),
});

const updateTransitionSchema = z
  .object({
    permission: z.string().trim().min(1).max(80).optional(),
    reason: z.string().trim().min(3).max(300).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

const keyParam = z.object({ key: z.string().trim().min(1).max(40) });
const idParam = z.object({ id: z.coerce.number().int().positive() });

/** `HttpError` for a guardrail breach; named so the code reads as intent. */
function refuse(statusCode: number, code: string, message: string): never {
  throw new HttpError(statusCode, code, message);
}

/** Shape of a status row as the admin screen consumes it. */
function serialiseStatus(status: {
  key: string;
  label: string;
  sortOrder: number;
  isTerminal: boolean;
  editablePlanned: boolean;
  editableActuals: boolean;
}) {
  return {
    key: status.key,
    label: status.label,
    sortOrder: status.sortOrder,
    isTerminal: status.isTerminal,
    editablePlanned: status.editablePlanned,
    editableActuals: status.editableActuals,
  };
}

export async function registerAdminWorkflowRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The catalogue plus what the editor needs to render it: how many jobs stand
   * on each status (the delete guardrail's input) and which capabilities a
   * transition may name.
   */
  app.get(
    '/api/admin/workflow',
    { preHandler: [app.authenticate, app.requirePermission('admin.workflow.read')] },
    async () => {
      const [statuses, transitions, counts] = await Promise.all([
        prisma.jobStatusDefinition.findMany({ orderBy: { sortOrder: 'asc' } }),
        prisma.jobTransitionDefinition.findMany({ orderBy: { id: 'asc' } }),
        prisma.job.groupBy({ by: ['status'], _count: { _all: true } }),
      ]);

      const jobCounts = new Map(counts.map((row) => [row.status, row._count._all]));

      return {
        statuses: statuses.map((status) => ({
          ...serialiseStatus(status),
          jobCount: jobCounts.get(status.key) ?? 0,
        })),
        transitions: transitions.map((transition) => ({
          id: transition.id,
          from: transition.fromKey,
          to: transition.toKey,
          permission: transition.permission,
          reason: transition.reason,
        })),
        transitionPermissions: TRANSITION_PERMISSIONS,
      };
    },
  );

  // -------------------------------------------------------------------------
  // Statuses
  // -------------------------------------------------------------------------

  app.post(
    '/api/admin/workflow/statuses',
    { preHandler: [app.authenticate, app.requirePermission('admin.workflow.write')] },
    async (request: FastifyRequest, reply) => {
      const body = createStatusSchema.parse(request.body);

      const duplicate = await prisma.jobStatusDefinition.findUnique({
        where: { key: body.key },
        select: { key: true },
      });
      if (duplicate) {
        refuse(409, 'STATUS_KEY_TAKEN', `A status with the key "${body.key}" already exists.`);
      }

      // Default: append to the pipeline. Starting from the current maximum keeps
      // "add a stage at the end" one click, which is the common case.
      const sortOrder =
        body.sortOrder ??
        ((await prisma.jobStatusDefinition.aggregate({ _max: { sortOrder: true } }))._max
          .sortOrder ?? -1) + 1;

      const orderTaken = await prisma.jobStatusDefinition.findUnique({
        where: { sortOrder },
        select: { key: true },
      });
      if (orderTaken) {
        refuse(
          409,
          'STATUS_ORDER_TAKEN',
          `Sort order ${sortOrder} is already used by "${orderTaken.key}".`,
        );
      }

      const created = await prisma.jobStatusDefinition.create({
        data: {
          key: body.key,
          label: body.label,
          sortOrder,
          isTerminal: body.isTerminal ?? false,
          editablePlanned: body.editablePlanned ?? false,
          editableActuals: body.editableActuals ?? false,
        },
      });

      invalidateJobWorkflow();
      return reply.code(201).send({ status: serialiseStatus(created) });
    },
  );

  app.patch(
    '/api/admin/workflow/statuses/:key',
    { preHandler: [app.authenticate, app.requirePermission('admin.workflow.write')] },
    async (request: FastifyRequest) => {
      const { key } = keyParam.parse(request.params);
      const body = updateStatusSchema.parse(request.body);

      const existing = await prisma.jobStatusDefinition.findUnique({ where: { key } });
      if (!existing) refuse(404, 'STATUS_NOT_FOUND', `Status "${key}" does not exist.`);

      if (body.sortOrder !== undefined && body.sortOrder !== existing.sortOrder) {
        const orderTaken = await prisma.jobStatusDefinition.findUnique({
          where: { sortOrder: body.sortOrder },
          select: { key: true },
        });
        if (orderTaken) {
          refuse(
            409,
            'STATUS_ORDER_TAKEN',
            `Sort order ${body.sortOrder} is already used by "${orderTaken.key}".`,
          );
        }
      }

      // Terminality is the only exit from the pipeline. Both halves of that
      // sentence are guardrails: a terminal status with edges would deadlock,
      // and a catalogue with no terminal status would let every job move
      // forever.
      if (body.isTerminal === true && existing.isTerminal === false) {
        const outgoing = await prisma.jobTransitionDefinition.count({ where: { fromKey: key } });
        if (outgoing > 0) {
          refuse(
            409,
            'TERMINAL_HAS_EDGES',
            `"${key}" has ${outgoing} outgoing transition(s). Remove them before making it terminal.`,
          );
        }
      }

      if (body.isTerminal === false && existing.isTerminal === true) {
        const terminals = await prisma.jobStatusDefinition.count({ where: { isTerminal: true } });
        if (terminals <= 1) {
          refuse(
            409,
            'LAST_TERMINAL_STATUS',
            'At least one terminal status must exist. Mark another status terminal first.',
          );
        }
      }

      const updated = await prisma.jobStatusDefinition.update({
        where: { key },
        data: {
          ...(body.label !== undefined && { label: body.label }),
          ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
          ...(body.isTerminal !== undefined && { isTerminal: body.isTerminal }),
          ...(body.editablePlanned !== undefined && { editablePlanned: body.editablePlanned }),
          ...(body.editableActuals !== undefined && { editableActuals: body.editableActuals }),
        },
      });

      invalidateJobWorkflow();
      return { status: serialiseStatus(updated) };
    },
  );

  app.delete(
    '/api/admin/workflow/statuses/:key',
    { preHandler: [app.authenticate, app.requirePermission('admin.workflow.write')] },
    async (request: FastifyRequest) => {
      const { key } = keyParam.parse(request.params);

      const existing = await prisma.jobStatusDefinition.findUnique({ where: { key } });
      if (!existing) refuse(404, 'STATUS_NOT_FOUND', `Status "${key}" does not exist.`);

      // The check is for the message, not for the guarantee: `job.status` is a
      // foreign key, so the delete is refused by the database even if a job
      // lands between the count and the delete.
      const jobCount = await prisma.job.count({ where: { status: key } });
      if (jobCount > 0) {
        refuse(
          409,
          'STATUS_IN_USE',
          `"${key}" cannot be deleted: ${jobCount} job(s) are in this status. ` +
            'Move them first, or keep the status and relabel it.',
        );
      }

      if (existing.isTerminal) {
        const terminals = await prisma.jobStatusDefinition.count({ where: { isTerminal: true } });
        if (terminals <= 1) {
          refuse(
            409,
            'LAST_TERMINAL_STATUS',
            'At least one terminal status must exist. Mark another status terminal first.',
          );
        }
      }

      // Its transitions go with it (schema `onDelete: Cascade`): an edge to a
      // status that no longer exists is not a workflow.
      await prisma.jobStatusDefinition.delete({ where: { key } });

      invalidateJobWorkflow();
      return { deleted: key, transitionsRemoved: true };
    },
  );

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  app.post(
    '/api/admin/workflow/transitions',
    { preHandler: [app.authenticate, app.requirePermission('admin.workflow.write')] },
    async (request: FastifyRequest, reply) => {
      const body = createTransitionSchema.parse(request.body);

      if (!TRANSITION_PERMISSION_KEYS.has(body.permission)) {
        refuse(
          422,
          'UNKNOWN_PERMISSION',
          `"${body.permission}" is not a transition capability the system understands.`,
        );
      }

      if (body.from === body.to) {
        refuse(422, 'SELF_TRANSITION', 'A status cannot transition to itself.');
      }

      const statuses = await prisma.jobStatusDefinition.findMany({
        where: { key: { in: [body.from, body.to] } },
        select: { key: true, isTerminal: true },
      });
      const from = statuses.find((status) => status.key === body.from);
      const to = statuses.find((status) => status.key === body.to);
      if (!from || !to) {
        refuse(
          422,
          'UNKNOWN_STATUS',
          `Unknown status: ${[!from && body.from, !to && body.to].filter(Boolean).join(', ')}.`,
        );
      }

      if (from.isTerminal) {
        refuse(
          422,
          'TERMINAL_SOURCE',
          `"${body.from}" is terminal and cannot have outgoing transitions.`,
        );
      }

      const duplicate = await prisma.jobTransitionDefinition.findUnique({
        where: { fromKey_toKey: { fromKey: body.from, toKey: body.to } },
        select: { id: true },
      });
      if (duplicate) {
        refuse(409, 'TRANSITION_EXISTS', `"${body.from}" can already move to "${body.to}".`);
      }

      const created = await prisma.jobTransitionDefinition.create({
        data: {
          fromKey: body.from,
          toKey: body.to,
          permission: body.permission,
          reason: body.reason,
        },
      });

      invalidateJobWorkflow();
      return reply.code(201).send({
        transition: {
          id: created.id,
          from: created.fromKey,
          to: created.toKey,
          permission: created.permission,
          reason: created.reason,
        },
      });
    },
  );

  app.patch(
    '/api/admin/workflow/transitions/:id',
    { preHandler: [app.authenticate, app.requirePermission('admin.workflow.write')] },
    async (request: FastifyRequest) => {
      const { id } = idParam.parse(request.params);
      const body = updateTransitionSchema.parse(request.body);

      const existing = await prisma.jobTransitionDefinition.findUnique({ where: { id } });
      if (!existing) refuse(404, 'TRANSITION_NOT_FOUND', `Transition ${id} does not exist.`);

      if (body.permission !== undefined && !TRANSITION_PERMISSION_KEYS.has(body.permission)) {
        refuse(
          422,
          'UNKNOWN_PERMISSION',
          `"${body.permission}" is not a transition capability the system understands.`,
        );
      }

      const updated = await prisma.jobTransitionDefinition.update({
        where: { id },
        data: {
          ...(body.permission !== undefined && { permission: body.permission }),
          ...(body.reason !== undefined && { reason: body.reason }),
        },
      });

      invalidateJobWorkflow();
      return {
        transition: {
          id: updated.id,
          from: updated.fromKey,
          to: updated.toKey,
          permission: updated.permission,
          reason: updated.reason,
        },
      };
    },
  );

  app.delete(
    '/api/admin/workflow/transitions/:id',
    { preHandler: [app.authenticate, app.requirePermission('admin.workflow.write')] },
    async (request: FastifyRequest) => {
      const { id } = idParam.parse(request.params);

      const existing = await prisma.jobTransitionDefinition.findUnique({ where: { id } });
      if (!existing) refuse(404, 'TRANSITION_NOT_FOUND', `Transition ${id} does not exist.`);

      await prisma.jobTransitionDefinition.delete({ where: { id } });

      invalidateJobWorkflow();
      return { deleted: id };
    },
  );
}
