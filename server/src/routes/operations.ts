/**
 * Operations API: projects, jobs, status transitions, deliverables and
 * assignments.
 *
 * RBAC map:
 *   project.read / project.write / project.delete  — projects
 *   job.read                                      — job list and detail
 *   job.read.assigned                             — own jobs only (field supervisors)
 *   job.write / job.delete                        — job records
 *   job.assign                                    — crew assignment
 *   job.transition.*                              — status changes (state machine)
 *   deliverable.read                              — deliverable grid
 *   deliverable.write.planned                     — scope quantities
 *   deliverable.write.actual                      — field actuals
 *
 * Scope restrictions are enforced by `assertJobVisible`, so a field supervisor
 * cannot reach another supervisor's job by guessing an id.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  actualsLockReason,
  aggregateTotals,
  assignmentCreateSchema,
  assignmentUpdateSchema,
  authoriseTransition,
  canEditActuals,
  canEditPlanned,
  deliverableActualUpdateSchema,
  deliverableCreateSchema,
  deliverablePlannedUpdateSchema,
  isScopedToAssignedJobs,
  jobStatusFromKey,
  jobPriorityFromKey,
  JOB_STATUSES,
  jobPriorityToKey,
  jobStatusToKey,
  jobTransitionSchema,
  jobUpdateSchema,
  jobUpsertSchema,
  plannedLockReason,
  projectUpsertSchema,
  allNextStatuses,
  type JobStatus,
} from '@openerp/shared';
import { prisma } from '../db/client.js';
import { HttpError } from '../auth/plugin.js';
import {
  addDeliverable,
  jobVarianceSummary,
  listDeliverables,
  OperationsError,
  removeDeliverable,
  resolveJobAmendmentId,
  transitionJob,
  updateActualQuantity,
  updatePlannedQuantity,
} from '../operations/service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Serialises Dates to `YYYY-MM-DD` and Decimals to numbers. */
function serialise<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      out[key] = value.toISOString().slice(0, 10);
    } else if (value !== null && typeof value === 'object' && 'toNumber' in value) {
      out[key] = (value as { toNumber(): number }).toNumber();
    } else if (value !== null && typeof value === 'object' && 'rows' in value) {
      // Skip raw relation payloads; callers select explicitly.
      continue;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Wraps service errors into the shared HTTP envelope. */
function rethrow(error: unknown): never {
  if (error instanceof OperationsError) {
    throw new HttpError(error.statusCode, error.code, error.message);
  }
  throw error;
}

/**
 * Asserts the caller may see this job.
 *
 * A field supervisor holds `job.read.assigned` rather than `job.read`, so they
 * only see jobs they are attached to or supervise. Enforced here so no route can
 * accidentally leak a job by omitting the check.
 */
async function assertJobVisible(
  jobId: number,
  principal: { permissions: Set<string>; employeeId: number; roleKeys: string[] },
): Promise<void> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      supervisorId: true,
      assignments: { select: { employeeId: true } },
    },
  });

  if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', `Job ${jobId} does not exist.`);

  if (principal.permissions.has('job.read')) return;

  const involved =
    job.supervisorId === principal.employeeId ||
    job.assignments.some((a) => a.employeeId === principal.employeeId);

  if (!involved) {
    throw new HttpError(
      403,
      'JOB_NOT_ASSIGNED',
      `Job ${jobId} is not assigned to you. Field roles may only access their own jobs.`,
    );
  }
}

export async function registerOperationsRoutes(app: FastifyInstance): Promise<void> {
  // =======================================================================
  // Projects
  // =======================================================================

  app.get(
    '/api/projects',
    { preHandler: [app.authenticate, app.requirePermission('project.read')] },
    async (request: FastifyRequest) => {
      const { search, year } = z
        .object({
          search: z.string().trim().min(1).optional(),
          year: z.coerce.number().int().optional(),
        })
        .parse(request.query ?? {});

      const projects = await prisma.project.findMany({
        where: {
          ...(year !== undefined && { year }),
          ...(search
            ? {
                OR: [
                  { code: { contains: search, mode: 'insensitive' as const } },
                  { description: { contains: search, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        orderBy: [{ year: 'desc' }, { code: 'asc' }],
        select: {
          id: true,
          code: true,
          year: true,
          description: true,
          startDate: true,
          endDate: true,
          contract: {
            select: { id: true, number: true, client: { select: { id: true, name: true } } },
          },
          amendment: {
            select: { id: true, amendmentNumber: true, status: true, vatRate: true },
          },
          jobs: {
            select: { id: true, status: true, priority: true, description: true },
          },
        },
      });

      return {
        projects: projects.map((p) => ({
          ...serialise(p),
          amendment: {
            ...p.amendment,
            status: p.amendment.status,
            vatRate: p.amendment.vatRate.toNumber(),
          },
          // Statuses are mapped to business labels, matching /api/jobs and the
          // project detail. Leaving the raw Prisma keys here while statusCounts
          // uses labels meant the two halves of this payload disagreed with each
          // other — caught by the integration suite, not by the UI, which fetches
          // per-project detail and never reads this jobs array.
          jobs: p.jobs.map((j) => ({
            ...serialise(j),
            status: jobStatusFromKey(j.status),
            priority: jobPriorityFromKey(j.priority),
          })),
          // Job counts per status, so the dashboard can show the pipeline at a
          // glance without a second round trip.
          statusCounts: JOB_STATUSES.reduce<Record<string, number>>((acc, label) => {
            acc[label] = p.jobs.filter((j) => j.status === jobStatusToKey(label)).length;
            return acc;
          }, {}),
        })),
      };
    },
  );

  app.get(
    '/api/projects/:id',
    { preHandler: [app.authenticate, app.requirePermission('project.read')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);

      const project = await prisma.project.findUnique({
        where: { id },
        select: {
          id: true,
          code: true,
          year: true,
          description: true,
          startDate: true,
          endDate: true,
          contract: {
            select: {
              id: true,
              number: true,
              client: { select: { id: true, name: true, isVatRegistered: true, vatNumber: true } },
            },
          },
          amendment: { select: { id: true, amendmentNumber: true, status: true, vatRate: true } },
          jobs: {
            select: {
              id: true,
              status: true,
              priority: true,
              description: true,
              workOrder: true,
              purchaseOrder: true,
              plannedStartDate: true,
              plannedEndDate: true,
              actualStartDate: true,
              actualEndDate: true,
              supervisorId: true,
              _count: { select: { serviceCodes: true, assignments: true, invoices: true } },
            },
          },
        },
      });

      if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project ${id} does not exist.`);

      // Per-job financial exposure, so the dashboard can show where money sits.
      const jobs = await Promise.all(
        project.jobs.map(async (job) => {
          const variance = await jobVarianceSummary(job.id);
          return {
            ...serialise(job),
            status: jobStatusFromKey(job.status),
            priority: jobPriorityFromKey(job.priority),
            ...variance,
          };
        }),
      );

      const exposure = aggregateTotals(
        jobs.map((j) => ({
          plannedSubtotal: j.plannedSubtotal,
          actualSubtotal: j.actualSubtotal,
          valueVariance: j.valueVariance,
          plannedQuantity: 0,
          actualQuantity: 0,
          quantityVariance: 0,
          rateHasDrifted: false,
          currentRate: null,
        })),
      );

      return {
        project: {
          ...serialise(project),
          amendment: { ...project.amendment, vatRate: project.amendment.vatRate.toNumber() },
          jobs,
          exposure,
        },
      };
    },
  );

  app.post(
    '/api/projects',
    { preHandler: [app.authenticate, app.requirePermission('project.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = projectUpsertSchema.parse(request.body);

      const contract = await prisma.contract.findUnique({
        where: { id: body.contractId },
        select: { id: true },
      });
      if (!contract) {
        throw new HttpError(
          400,
          'INVALID_REFERENCE',
          `Contract ${body.contractId} does not exist.`,
        );
      }

      // Default to the contract's most recent active amendment.
      let amendmentId = body.amendmentId;
      if (amendmentId === undefined) {
        const active = await prisma.contractAmendment.findFirst({
          where: { contractId: body.contractId, status: 'ACTIVE' },
          orderBy: { effectiveDate: 'desc' },
          select: { id: true },
        });
        if (!active) {
          throw new HttpError(
            422,
            'NO_ACTIVE_AMENDMENT',
            `Contract ${body.contractId} has no active amendment to price against.`,
          );
        }
        amendmentId = active.id;
      }

      const project = await prisma.project.create({
        data: {
          contractId: body.contractId,
          amendmentId,
          code: body.code,
          year: body.year,
          startDate: body.startDate ? new Date(body.startDate) : null,
          endDate: body.endDate ? new Date(body.endDate) : null,
          description: body.description ?? null,
        },
      });

      return reply.code(201).send({ project: serialise(project) });
    },
  );

  app.patch(
    '/api/projects/:id',
    { preHandler: [app.authenticate, app.requirePermission('project.write')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = projectUpsertSchema.partial().parse(request.body);

      const existing = await prisma.project.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!existing) throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project ${id} does not exist.`);

      const project = await prisma.project.update({
        where: { id },
        data: {
          ...(body.code !== undefined && { code: body.code }),
          ...(body.year !== undefined && { year: body.year }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.startDate !== undefined && {
            startDate: body.startDate ? new Date(body.startDate) : null,
          }),
          ...(body.endDate !== undefined && {
            endDate: body.endDate ? new Date(body.endDate) : null,
          }),
          ...(body.amendmentId !== undefined && { amendmentId: body.amendmentId }),
        },
      });

      return { project: serialise(project) };
    },
  );

  app.delete(
    '/api/projects/:id',
    { preHandler: [app.authenticate, app.requirePermission('project.delete')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);

      const existing = await prisma.project.findUnique({
        where: { id },
        select: { id: true, _count: { select: { jobs: true } } },
      });
      if (!existing) throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project ${id} does not exist.`);

      if (existing._count.jobs > 0) {
        throw new HttpError(
          409,
          'CONFLICT',
          `Project ${id} still has ${existing._count.jobs} job(s). Close them out before deleting.`,
        );
      }

      await prisma.project.delete({ where: { id } });
      return reply.code(204).send();
    },
  );

  // =======================================================================
  // Jobs
  // =======================================================================

  app.get(
    '/api/jobs',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const principal = request.principal!;
      if (
        !principal.permissions.has('job.read') &&
        !principal.permissions.has('job.read.assigned')
      ) {
        throw new HttpError(403, 'FORBIDDEN', 'Missing required permission(s): job.read.');
      }

      const { projectId, status, assignedToMe } = z
        .object({
          projectId: z.coerce.number().int().positive().optional(),
          status: z.string().trim().min(1).optional(),
          assignedToMe: z.coerce.boolean().optional(),
        })
        .parse(request.query ?? {});

      // Field supervisors are restricted to their own jobs unless they also hold
      // the general read permission.
      const scoped = !principal.permissions.has('job.read');
      const mineOnly = scoped || assignedToMe === true;

      const jobs = await prisma.job.findMany({
        where: {
          ...(projectId !== undefined && { projectId }),
          ...(status !== undefined && { status: jobStatusToKey(status) as never }),
          ...(mineOnly
            ? {
                OR: [
                  { supervisorId: principal.employeeId },
                  { assignments: { some: { employeeId: principal.employeeId } } },
                ],
              }
            : {}),
        },
        orderBy: [{ status: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          status: true,
          priority: true,
          description: true,
          workOrder: true,
          purchaseOrder: true,
          area: true,
          plannedStartDate: true,
          plannedEndDate: true,
          actualStartDate: true,
          actualEndDate: true,
          project: {
            select: { id: true, code: true, year: true, contract: { select: { number: true } } },
          },
          amendmentId: true,
          supervisor: { select: { id: true, name: true, surname: true } },
          _count: { select: { serviceCodes: true, assignments: true, invoices: true } },
        },
      });

      return {
        jobs: jobs.map((j) => ({
          ...serialise(j),
          status: jobStatusFromKey(j.status),
          priority: jobPriorityFromKey(j.priority),
        })),
      };
    },
  );

  app.get(
    '/api/jobs/:id',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const principal = request.principal!;
      await assertJobVisible(id, principal);

      const job = await prisma.job.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          priority: true,
          amendmentId: true,
          description: true,
          workOrder: true,
          workOrderReceivedDate: true,
          purchaseOrder: true,
          purchaseOrderReceivedDate: true,
          area: true,
          plannedStartDate: true,
          plannedEndDate: true,
          actualStartDate: true,
          actualEndDate: true,
          project: {
            select: {
              id: true,
              code: true,
              year: true,
              amendmentId: true,
              contract: { select: { id: true, number: true, client: { select: { name: true } } } },
            },
          },
          supervisor: { select: { id: true, name: true, surname: true } },
          clientContact: { select: { id: true, name: true, email: true, mobile: true } },
          assignments: {
            include: { employee: { select: { id: true, name: true, surname: true } } },
            orderBy: { id: 'asc' },
          },
          invoices: {
            select: { id: true, invoiceNumber: true, status: true, totalWithTax: true },
            orderBy: { id: 'asc' },
          },
        },
      });

      if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', `Job ${id} does not exist.`);

      // Amendment resolution, surfaced explicitly so the UI can show which
      // commercial basis this job prices against.
      const effectiveAmendmentId = await resolveJobAmendmentId({
        amendmentId: job.amendmentId,
        projectId: job.project.id,
      });
      const inherited = job.amendmentId === null;

      const amendment = await prisma.contractAmendment.findUnique({
        where: { id: effectiveAmendmentId },
        select: { id: true, amendmentNumber: true, status: true, vatRate: true },
      });

      const status = jobStatusFromKey(job.status);
      const deliverables = await listDeliverables(id);

      // Which transitions this user could actually make right now.
      const permitted = allNextStatuses(status).filter((to) => {
        const check = authoriseFor(principal.permissions, status, to);
        return check;
      });

      return {
        job: {
          ...serialise(job),
          status,
          priority: jobPriorityFromKey(job.priority),
          amendmentId: effectiveAmendmentId,
          amendment: amendment
            ? { ...amendment, status: amendment.status, vatRate: amendment.vatRate.toNumber() }
            : null,
          amendmentInherited: inherited,
          assignments: job.assignments.map((a) => serialise(a)),
          invoices: job.invoices.map((i) => serialise(i)),
        },
        permissions: {
          canEditPlanned: canEditPlanned(status),
          plannedLockReason: plannedLockReason(status),
          canEditActuals: canEditActuals(status),
          actualsLockReason: actualsLockReason(status),
          canAddDeliverable: canEditPlanned(status),
          // Phase 7: crew assignments were already enforceable server-side but
          // had no screen. Exposed here so the job card can offer the buttons it
          // is actually allowed to honour, rather than letting a request 403.
          canAssign: principal.permissions.has('job.assign'),
          availableTransitions: permitted,
          scopedToAssignedJobs: isScopedToAssignedJobs(principal.roleKeys),
        },
        deliverables,
        summary: aggregateTotals(deliverables),
      };
    },
  );

  app.post(
    '/api/jobs',
    { preHandler: [app.authenticate, app.requirePermission('job.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = jobUpsertSchema.parse(request.body);

      const project = await prisma.project.findUnique({
        where: { id: body.projectId },
        select: { id: true, amendmentId: true },
      });
      if (!project) {
        throw new HttpError(400, 'INVALID_REFERENCE', `Project ${body.projectId} does not exist.`);
      }

      const job = await prisma.job.create({
        data: {
          projectId: body.projectId,
          // Null means "inherit the project's amendment".
          amendmentId: body.amendmentId ?? null,
          supervisorId: body.supervisorId ?? null,
          clientContactId: body.clientContactId ?? null,
          priority: jobPriorityToKey(body.priority) as never,
          workOrder: body.workOrder ?? null,
          workOrderReceivedDate: body.workOrderReceivedDate
            ? new Date(body.workOrderReceivedDate)
            : null,
          purchaseOrder: body.purchaseOrder ?? null,
          purchaseOrderReceivedDate: body.purchaseOrderReceivedDate
            ? new Date(body.purchaseOrderReceivedDate)
            : null,
          plannedStartDate: body.plannedStartDate ? new Date(body.plannedStartDate) : null,
          plannedEndDate: body.plannedEndDate ? new Date(body.plannedEndDate) : null,
          actualStartDate: body.actualStartDate ? new Date(body.actualStartDate) : null,
          actualEndDate: body.actualEndDate ? new Date(body.actualEndDate) : null,
          area: body.area ?? null,
          description: body.description ?? null,
        },
      });

      return reply.code(201).send({
        job: {
          ...serialise(job),
          status: jobStatusFromKey(job.status),
          priority: jobPriorityFromKey(job.priority),
        },
      });
    },
  );

  app.patch(
    '/api/jobs/:id',
    { preHandler: [app.authenticate, app.requirePermission('job.write')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = jobUpdateSchema.parse(request.body);

      const existing = await prisma.job.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!existing) throw new HttpError(404, 'JOB_NOT_FOUND', `Job ${id} does not exist.`);

      const job = await prisma.job.update({
        where: { id },
        data: {
          ...(body.amendmentId !== undefined && { amendmentId: body.amendmentId }),
          ...(body.supervisorId !== undefined && { supervisorId: body.supervisorId }),
          ...(body.clientContactId !== undefined && { clientContactId: body.clientContactId }),
          ...(body.priority !== undefined && {
            priority: jobPriorityToKey(body.priority) as never,
          }),
          ...(body.workOrder !== undefined && { workOrder: body.workOrder }),
          ...(body.purchaseOrder !== undefined && { purchaseOrder: body.purchaseOrder }),
          ...(body.area !== undefined && { area: body.area }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.workOrderReceivedDate !== undefined && {
            workOrderReceivedDate: body.workOrderReceivedDate
              ? new Date(body.workOrderReceivedDate)
              : null,
          }),
          ...(body.purchaseOrderReceivedDate !== undefined && {
            purchaseOrderReceivedDate: body.purchaseOrderReceivedDate
              ? new Date(body.purchaseOrderReceivedDate)
              : null,
          }),
          ...(body.plannedStartDate !== undefined && {
            plannedStartDate: body.plannedStartDate ? new Date(body.plannedStartDate) : null,
          }),
          ...(body.plannedEndDate !== undefined && {
            plannedEndDate: body.plannedEndDate ? new Date(body.plannedEndDate) : null,
          }),
          ...(body.actualStartDate !== undefined && {
            actualStartDate: body.actualStartDate ? new Date(body.actualStartDate) : null,
          }),
          ...(body.actualEndDate !== undefined && {
            actualEndDate: body.actualEndDate ? new Date(body.actualEndDate) : null,
          }),
        },
      });

      return {
        job: {
          ...serialise(job),
          status: jobStatusFromKey(job.status),
          priority: jobPriorityFromKey(job.priority),
        },
      };
    },
  );

  app.delete(
    '/api/jobs/:id',
    { preHandler: [app.authenticate, app.requirePermission('job.delete')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);

      const existing = await prisma.job.findUnique({
        where: { id },
        select: { id: true, _count: { select: { serviceCodes: true, invoices: true } } },
      });
      if (!existing) throw new HttpError(404, 'JOB_NOT_FOUND', `Job ${id} does not exist.`);

      if (existing._count.invoices > 0) {
        throw new HttpError(
          409,
          'CONFLICT',
          `Job ${id} has ${existing._count.invoices} invoice(s) raised against it and cannot be deleted.`,
        );
      }

      await prisma.job.delete({ where: { id } });
      return reply.code(204).send();
    },
  );

  // =======================================================================
  // Transitions
  // =======================================================================

  /**
   * The transition endpoint.
   *
   * Legality is judged by the shared state machine and capability by the RBAC
   * catalogue, both inside `transitionJob`. This route only maps the outcome to
   * HTTP semantics so the client can distinguish "forbidden" from "illegal".
   */
  app.post(
    '/api/jobs/:id/transition',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = jobTransitionSchema.parse(request.body);
      const principal = request.principal!;

      // A field supervisor may only move jobs assigned to them.
      if (isScopedToAssignedJobs(principal.roleKeys)) {
        await assertJobVisible(id, principal);
      }

      try {
        const outcome = await transitionJob(id, body.status as JobStatus, principal);
        return { transition: outcome };
      } catch (error) {
        rethrow(error);
      }
    },
  );

  /** Legal targets from a job's current status, for driving the UI. */
  app.get(
    '/api/jobs/:id/transitions',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const principal = request.principal!;

      const job = await prisma.job.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', `Job ${id} does not exist.`);

      const from = jobStatusFromKey(job.status);
      const all = allNextStatuses(from);

      return {
        from,
        transitions: all.map((to) => {
          const check = authoriseFor(principal.permissions, from, to);
          return {
            to,
            allowed: check.allowed,
            reason: check.reason,
            requiredPermission: check.requiredPermission,
          };
        }),
      };
    },
  );

  // =======================================================================
  // Deliverables
  // =======================================================================

  app.get(
    '/api/jobs/:id/deliverables',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const principal = request.principal!;
      await assertJobVisible(id, principal);

      if (!principal.permissions.has('deliverable.read')) {
        throw new HttpError(403, 'FORBIDDEN', 'Missing required permission(s): deliverable.read.');
      }

      try {
        const deliverables = await listDeliverables(id);
        return { deliverables, summary: aggregateTotals(deliverables) };
      } catch (error) {
        rethrow(error);
      }
    },
  );

  app.post(
    '/api/jobs/:id/deliverables',
    { preHandler: [app.authenticate, app.requirePermission('deliverable.write.planned')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = deliverableCreateSchema.parse(request.body);

      try {
        const deliverables = await addDeliverable(
          id,
          body.serviceCodeId,
          body.plannedQuantity,
          body.appliedRate,
        );
        return reply.code(201).send({ deliverables, summary: aggregateTotals(deliverables) });
      } catch (error) {
        rethrow(error);
      }
    },
  );

  /**
   * Planned quantity update.
   *
   * Separate from the actual endpoint so the server can apply the scope lock and
   * return 409 SCOPE_FROZEN with an explanation, rather than a generic refusal.
   */
  app.patch(
    '/api/job-deliverables/:id/planned',
    { preHandler: [app.authenticate, app.requirePermission('deliverable.write.planned')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = deliverablePlannedUpdateSchema.parse(request.body);

      try {
        const deliverables = await updatePlannedQuantity(id, body.plannedQuantity);
        return { deliverables, summary: aggregateTotals(deliverables) };
      } catch (error) {
        rethrow(error);
      }
    },
  );

  /** Actual quantity update — the field supervisor's primary action. */
  app.patch(
    '/api/job-deliverables/:id/actual',
    { preHandler: [app.authenticate, app.requirePermission('deliverable.write.actual')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = deliverableActualUpdateSchema.parse(request.body);

      try {
        const deliverables = await updateActualQuantity(id, body.actualQuantity);
        return { deliverables, summary: aggregateTotals(deliverables) };
      } catch (error) {
        rethrow(error);
      }
    },
  );

  app.delete(
    '/api/job-deliverables/:id',
    { preHandler: [app.authenticate, app.requirePermission('deliverable.write.planned')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      try {
        await removeDeliverable(id);
      } catch (error) {
        rethrow(error);
      }
      return reply.code(204).send();
    },
  );

  // =======================================================================
  // Assignments
  // =======================================================================

  app.get(
    '/api/jobs/:id/assignments',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      await assertJobVisible(id, request.principal!);

      const assignments = await prisma.jobAssignment.findMany({
        where: { jobId: id },
        orderBy: { id: 'asc' },
        include: { employee: { select: { id: true, name: true, surname: true, rate: true } } },
      });

      return { assignments: assignments.map((a) => serialise(a)) };
    },
  );

  app.post(
    '/api/jobs/:id/assignments',
    { preHandler: [app.authenticate, app.requirePermission('job.assign')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      // The job id comes from the path, so it is merged in rather than trusted
      // from the body.
      const body = assignmentCreateSchema.parse({
        ...(request.body as Record<string, unknown>),
        jobId: id,
      });

      const employee = await prisma.employee.findUnique({
        where: { id: body.employeeId },
        select: { id: true },
      });
      if (!employee) {
        throw new HttpError(
          400,
          'INVALID_REFERENCE',
          `Employee ${body.employeeId} does not exist.`,
        );
      }

      const assignment = await prisma.jobAssignment.create({
        data: {
          jobId: id,
          employeeId: body.employeeId,
          role: body.role ?? null,
          assignedDate: body.assignedDate ? new Date(body.assignedDate) : null,
        },
        include: { employee: { select: { id: true, name: true, surname: true } } },
      });

      return reply.code(201).send({ assignment: serialise(assignment) });
    },
  );

  app.patch(
    '/api/job-assignments/:id',
    { preHandler: [app.authenticate, app.requirePermission('job.assign')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = assignmentUpdateSchema.parse(request.body);

      const existing = await prisma.jobAssignment.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!existing) {
        throw new HttpError(404, 'ASSIGNMENT_NOT_FOUND', `Assignment ${id} does not exist.`);
      }

      const assignment = await prisma.jobAssignment.update({
        where: { id },
        data: {
          ...(body.role !== undefined && { role: body.role }),
          ...(body.assignedDate !== undefined && {
            assignedDate: body.assignedDate ? new Date(body.assignedDate) : null,
          }),
        },
        include: { employee: { select: { id: true, name: true, surname: true } } },
      });

      return { assignment: serialise(assignment) };
    },
  );

  app.delete(
    '/api/job-assignments/:id',
    { preHandler: [app.authenticate, app.requirePermission('job.assign')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const existing = await prisma.jobAssignment.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!existing) {
        throw new HttpError(404, 'ASSIGNMENT_NOT_FOUND', `Assignment ${id} does not exist.`);
      }
      await prisma.jobAssignment.delete({ where: { id } });
      return reply.code(204).send();
    },
  );

  // =======================================================================
  // Field view
  // =======================================================================

  /**
   * Everything a site supervisor needs on one screen: their jobs, their
   * deliverables, and what they are allowed to do next.
   */
  app.get(
    '/api/field/my-work',
    { preHandler: [app.authenticate, app.requirePermission('deliverable.read')] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const principal = request.principal!;

      const jobs = await prisma.job.findMany({
        where: {
          OR: [
            { supervisorId: principal.employeeId },
            { assignments: { some: { employeeId: principal.employeeId } } },
          ],
        },
        orderBy: [{ status: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          status: true,
          description: true,
          workOrder: true,
          area: true,
          actualStartDate: true,
          actualEndDate: true,
          project: { select: { code: true, contract: { select: { number: true } } } },
        },
      });

      const enriched = await Promise.all(
        jobs.map(async (job) => {
          const deliverables = await listDeliverables(job.id);
          const status = jobStatusFromKey(job.status);
          return {
            ...serialise(job),
            status,
            permissions: {
              canEditActuals: canEditActuals(status),
              actualsLockReason: actualsLockReason(status),
              availableTransitions: allNextStatuses(status).filter((to) =>
                authoriseFor(principal.permissions, status, to),
              ),
            },
            deliverables,
            summary: aggregateTotals(deliverables),
          };
        }),
      );

      return { jobs: enriched };
    },
  );
}

/** Local helper so every transition projection reads consistently. */
function authoriseFor(
  permissions: Set<string>,
  from: JobStatus,
  to: JobStatus,
): { allowed: boolean; reason: string; requiredPermission?: string } {
  return authoriseTransition(from, to, permissions);
}
