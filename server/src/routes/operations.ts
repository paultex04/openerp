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
  aggregateTotals,
  assignmentCreateSchema,
  assignmentUpdateSchema,
  authoriseTransition,
  deliverableActualUpdateSchema,
  deliverableCreateSchema,
  deliverablePlannedUpdateSchema,
  isScopedToAssignedJobs,
  AMENDMENT_TYPE,
  CONTRACT_AMENDMENT_STATUS,
  isKnownStatus,
  jobPriorityFromKey,
  jobPriorityToKey,
  jobTransitionSchema,
  jobUpdateSchema,
  jobUpsertSchema,
  nextStatuses,
  projectUpsertSchema,
  type JobStatus,
  type JobWorkflow,
} from '@openerp/shared';
import { prisma } from '../db/client.js';
import { HttpError } from '../auth/plugin.js';
import {
  addDeliverable,
  jobEditability,
  jobVarianceSummary,
  listDeliverables,
  OperationsError,
  removeDeliverable,
  resolveJobAmendmentId,
  transitionJob,
  updateActualQuantity,
  updatePlannedQuantity,
} from '../operations/service.js';
import { loadJobWorkflow } from '../operations/workflow.js';
import { BILLABLE_JOB_KEYS, OPEN_INVOICE_KEYS } from '../billing/service.js';

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
          // Phase 7: the project form's two dependent pickers are "contract" and
          // "amendment", and the dialog seeds itself from the row. Neither
          // reference was in this projection, so both dropdowns opened blank on
          // edit and a save would have looked successful while clearing them.
          // The nested `contract`/`amendment` objects were no substitute: the form
          // needs the foreign keys themselves.
          contractId: true,
          amendmentId: true,
          contract: {
            select: { id: true, number: true, client: { select: { id: true, name: true } } },
          },
          amendment: {
            select: {
              id: true,
              amendmentNumber: true,
              amendmentType: true,
              status: true,
              vatRate: true,
            },
          },
          jobs: {
            select: { id: true, status: true, priority: true, description: true },
          },
        },
      });

      const workflow = await loadJobWorkflow();

      return {
        projects: projects.map((p) => ({
          ...serialise(p),
          amendment: p.amendment
            ? {
                ...p.amendment,
                amendmentType: AMENDMENT_TYPE.toLabel(p.amendment.amendmentType),
                status: CONTRACT_AMENDMENT_STATUS.toLabel(p.amendment.status),
                vatRate: p.amendment.vatRate.toNumber(),
              }
            : null,
          jobs: p.jobs.map((j) => ({
            ...serialise(j),
            status: j.status,
            priority: jobPriorityFromKey(j.priority),
          })),
          // Job counts per status, so the dashboard can show the pipeline at a
          // glance without a second round trip. Keyed by status key and ordered
          // by the live catalogue, so a status the administrator invented shows
          // up under its own name and a renamed one keeps its position.
          statusCounts: Object.fromEntries(
            workflow.statuses.map((status) => [
              status.key,
              p.jobs.filter((j) => j.status === status.key).length,
            ]),
          ),
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
          // Same reasoning as the list projection: the project's two dependent
          // pickers are seeded from these keys, and the nested objects below are
          // not a substitute for them.
          contractId: true,
          amendmentId: true,
          contract: {
            select: {
              id: true,
              number: true,
              client: { select: { id: true, name: true, isVatRegistered: true, vatNumber: true } },
            },
          },
          amendment: {
            select: {
              id: true,
              amendmentNumber: true,
              amendmentType: true,
              status: true,
              vatRate: true,
            },
          },
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
            status: job.status,
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
          amendment: {
            ...project.amendment,
            amendmentType: AMENDMENT_TYPE.toLabel(project.amendment.amendmentType),
            status: CONTRACT_AMENDMENT_STATUS.toLabel(project.amendment.status),
            vatRate: project.amendment.vatRate.toNumber(),
          },
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
      } else {
        // The amendment must belong to the chosen contract. Without this the
        // project can be pinned to another contract's amendment, and since rates
        // and service codes are amendment-scoped the project is then priced
        // against terms it is not covered by - with nothing in the data to say so.
        // The job-scoped equivalent is `AMENDMENT_MISMATCH` in the operations
        // service; this is the same rule applied one level up, where nothing
        // checked it at all.
        const amendment = await prisma.contractAmendment.findUnique({
          where: { id: amendmentId },
          select: { id: true, contractId: true },
        });
        if (!amendment) {
          throw new HttpError(400, 'INVALID_REFERENCE', `Amendment ${amendmentId} does not exist.`);
        }
        if (amendment.contractId !== body.contractId) {
          throw new HttpError(
            422,
            'AMENDMENT_MISMATCH',
            `Amendment ${amendmentId} belongs to contract ${amendment.contractId}, but this ` +
              `project is for contract ${body.contractId}.`,
          );
        }
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

      // `contractId` is needed even though it is not updatable: the amendment has to
      // be checked against the contract the project already belongs to.
      const existing = await prisma.project.findUnique({
        where: { id },
        select: { id: true, contractId: true },
      });
      if (!existing) throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project ${id} does not exist.`);

      // Same rule as the create path: an amendment from another contract is refused
      // rather than stored. This endpoint previously took any `amendmentId` at face
      // value, which made it possible to re-point a live project at a different
      // contract's commercial terms through the UI.
      if (body.amendmentId !== undefined) {
        const amendment = await prisma.contractAmendment.findUnique({
          where: { id: body.amendmentId },
          select: { id: true, contractId: true },
        });
        if (!amendment) {
          throw new HttpError(
            400,
            'INVALID_REFERENCE',
            `Amendment ${body.amendmentId} does not exist.`,
          );
        }
        if (amendment.contractId !== existing.contractId) {
          throw new HttpError(
            422,
            'AMENDMENT_MISMATCH',
            `Amendment ${body.amendmentId} belongs to contract ${amendment.contractId}, but ` +
              `project ${id} is for contract ${existing.contractId}.`,
          );
        }
      }

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

      const { projectId, status, assignedToMe, billable, search, page, pageSize } = z
        .object({
          projectId: z.coerce.number().int().positive().optional(),
          status: z.string().trim().min(1).optional(),
          assignedToMe: z.coerce.boolean().optional(),
          /**
           * Only jobs the billing engine would accept a new invoice for: a
           * billable status and no open invoice — the same two guards as
           * `generateDraft`. Added for the New-invoice job picker so it cannot
           * offer a job that would 409, or omit one that would succeed.
           */
          billable: z.coerce.boolean().optional(),
          /**
           * Free text over work order, purchase order, description, area, project
           * code and supervisor name.
           *
           * Searched server-side because the jobs register is the one list in the
           * application that is expected to grow without bound. Every other
           * register fetches everything and filters in the browser, which is fine
           * while the result fits in memory; a jobs table does not stay small.
           */
          search: z.string().trim().min(1).max(120).optional(),
          page: z.coerce.number().int().positive().optional(),
          pageSize: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(request.query ?? {});

      // The catalogue is data, so a status filter has to be checked against it
      // rather than against a schema enum - and checked *loudly*, because
      // silently returning an empty list would look like "no jobs" instead of
      // "no such status".
      const workflow = await loadJobWorkflow();

      if (status !== undefined && !isKnownStatus(workflow, status)) {
        throw new HttpError(422, 'INVALID_STATUS', `"${status}" is not a job status.`);
      }

      // Field supervisors are restricted to their own jobs unless they also hold
      // the general read permission.
      const scoped = !principal.permissions.has('job.read');
      const mineOnly = scoped || assignedToMe === true;

      // Every term must match somewhere, mirroring the shared DataTable's
      // `matchesSearch`. "pack sasol" narrows rather than widening to everything
      // containing either word, which is what makes a multi-word search feel
      // precise instead of useless.
      const terms = (search ?? '').toLowerCase().split(/\s+/).filter(Boolean);

      const textFilter = terms.length
        ? {
            AND: terms.map((term) => ({
              OR: [
                { workOrder: { contains: term, mode: 'insensitive' as const } },
                { purchaseOrder: { contains: term, mode: 'insensitive' as const } },
                { description: { contains: term, mode: 'insensitive' as const } },
                { area: { contains: term, mode: 'insensitive' as const } },
                { project: { code: { contains: term, mode: 'insensitive' as const } } },
                {
                  supervisor: { is: { surname: { contains: term, mode: 'insensitive' as const } } },
                },
                { supervisor: { is: { name: { contains: term, mode: 'insensitive' as const } } } },
              ],
            })),
          }
        : {};

      const where = {
        ...(projectId !== undefined && { projectId }),
        ...(billable === true && {
          status: { in: BILLABLE_JOB_KEYS as never },
          invoices: { none: { status: { in: OPEN_INVOICE_KEYS as never } } },
        }),
        ...(status !== undefined && { status }),
        ...textFilter,
        ...(mineOnly
          ? {
              OR: [
                { supervisorId: principal.employeeId },
                { assignments: { some: { employeeId: principal.employeeId } } },
              ],
            }
          : {}),
      };

      // Only count and skip when the caller actually paginates. Existing callers
      // (the /field view, smoke tests, the admin panel) expect the whole list, and
      // silently truncating their result to a default page size would be a quiet
      // data loss rather than an error.
      const take = pageSize;
      const skip = page !== undefined && take !== undefined ? (page - 1) * take : undefined;

      const [jobs, total] = await Promise.all([
        prisma.job.findMany({
          where,
          // Pipeline order comes from the catalogue's sort order, not from the
          // status text: an administrator who moves a status moves the register
          // with it. (Alphabetically, "11. Partially Invoiced" would lead.)
          orderBy: [{ statusRef: { sortOrder: 'asc' } }, { id: 'asc' }],
          ...(take !== undefined && { take }),
          ...(skip !== undefined && { skip }),
          select: {
            id: true,
            status: true,
            priority: true,
            description: true,
            workOrder: true,
            purchaseOrder: true,
            area: true,
            workOrderReceivedDate: true,
            purchaseOrderReceivedDate: true,
            plannedStartDate: true,
            plannedEndDate: true,
            actualStartDate: true,
            actualEndDate: true,
            project: {
              select: {
                id: true,
                code: true,
                year: true,
                contract: {
                  select: {
                    id: true,
                    number: true,
                    client: { select: { name: true } },
                  },
                },
              },
            },
            // The jobs register's edit dialog seeds itself from the row, so every
            // field it shows has to be in this projection - a missing column opens
            // the form blank and PATCHes nothing back.
            projectId: true,
            amendmentId: true,
            supervisorId: true,
            clientContactId: true,
            supervisor: { select: { id: true, name: true, surname: true } },
            _count: { select: { serviceCodes: true, assignments: true, invoices: true } },
          },
        }),
        prisma.job.count({ where }),
      ]);

      return {
        jobs: jobs.map((j) => ({
          ...serialise(j),
          status: j.status,
          priority: jobPriorityFromKey(j.priority),
        })),
        // Present only when the caller paginated, so an unpaginated caller is never
        // tempted to render "1-N" from a total it did not ask for.
        ...(take !== undefined && { total, page: page ?? 1, pageSize: take }),
      };
    },
  );

  /**
   * The live workflow, for the client to render statuses, labels and the
   * stepper from the same catalogue the API enforces.
   *
   * Reads an administrator can already make about any job they can see; the
   * permission check mirrors the job visibility rule (general read or assigned
   * read) rather than requiring both.
   */
  app.get(
    '/api/jobs/workflow',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const principal = request.principal!;
      const mayRead =
        principal.permissions.has('job.read') || principal.permissions.has('job.read.assigned');

      if (!mayRead) {
        throw new HttpError(
          403,
          'FORBIDDEN',
          'Missing required permission(s): job.read or job.read.assigned.',
        );
      }

      const workflow = await loadJobWorkflow();
      return { workflow };
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
              contract: {
                select: { id: true, number: true, client: { select: { id: true, name: true } } },
              },
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
        select: {
          id: true,
          amendmentNumber: true,
          amendmentType: true,
          status: true,
          vatRate: true,
        },
      });

      const workflow = await loadJobWorkflow();
      const editability = await jobEditability(id);
      const status = job.status;
      const deliverables = await listDeliverables(id);

      // Which transitions this user could actually make right now.
      const permitted = nextStatuses(workflow, status).filter((to) =>
        authoriseFor(workflow, principal.permissions, status, to),
      );

      return {
        job: {
          ...serialise(job),
          status,
          priority: jobPriorityFromKey(job.priority),
          amendmentId: effectiveAmendmentId,
          amendment: amendment
            ? {
                ...amendment,
                amendmentType: AMENDMENT_TYPE.toLabel(amendment.amendmentType),
                status: CONTRACT_AMENDMENT_STATUS.toLabel(amendment.status),
                vatRate: amendment.vatRate.toNumber(),
              }
            : null,
          amendmentInherited: inherited,
          assignments: job.assignments.map((a) => serialise(a)),
          invoices: job.invoices.map((i) => serialise(i)),
        },
        permissions: {
          canEditJob: principal.permissions.has('job.write'),
          canEditPlanned: editability.canEditPlanned,
          plannedLockReason: editability.plannedLockReason,
          canEditActuals: editability.canEditActuals,
          actualsLockReason: editability.actualsLockReason,
          canAddDeliverable: editability.canEditPlanned,
          // Phase 7: crew assignments were already enforceable server-side but
          // had no screen. Exposed here so the job card can offer the buttons it
          // is actually allowed to honour, rather than letting a request 403.
          canAssign: principal.permissions.has('job.assign'),
          availableTransitions: permitted,
          scopedToAssignedJobs: isScopedToAssignedJobs(principal.roleKeys, principal.permissions),
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
          status: job.status,
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
        select: { id: true, projectId: true },
      });
      if (!existing) throw new HttpError(404, 'JOB_NOT_FOUND', `Job ${id} does not exist.`);

      // `projectId` is accepted by the schema because the register round-trips
      // the row, but it is not writable: moving a job between projects would
      // strand its pricing (service codes are amendment-scoped and the
      // amendment follows the project) and its work orders. Echoing the current
      // value is tolerated; changing it is refused rather than silently ignored,
      // which is what it used to be. (Phase 15 Q10.)
      if (body.projectId !== undefined && body.projectId !== existing.projectId) {
        throw new HttpError(
          422,
          'JOB_PROJECT_IMMUTABLE',
          'A job cannot be moved to another project. Raise a new job under the target project.',
        );
      }

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
          status: job.status,
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
      if (isScopedToAssignedJobs(principal.roleKeys, principal.permissions)) {
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

      const workflow = await loadJobWorkflow();
      const from = job.status;

      return {
        from,
        transitions: nextStatuses(workflow, from).map((to) => {
          const check = authoriseFor(workflow, principal.permissions, from, to);
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
        orderBy: [{ statusRef: { sortOrder: 'asc' } }, { id: 'asc' }],
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

      const workflow = await loadJobWorkflow();

      const enriched = await Promise.all(
        jobs.map(async (job) => {
          const deliverables = await listDeliverables(job.id);
          const status = job.status;
          const editability = await jobEditability(job.id);
          return {
            ...serialise(job),
            status,
            permissions: {
              canEditActuals: editability.canEditActuals,
              actualsLockReason: editability.actualsLockReason,
              availableTransitions: nextStatuses(workflow, status).filter((to) =>
                authoriseFor(workflow, principal.permissions, status, to),
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
  workflow: JobWorkflow,
  permissions: Set<string>,
  from: JobStatus,
  to: JobStatus,
): { allowed: boolean; reason: string; requiredPermission?: string } {
  return authoriseTransition(workflow, from, to, permissions);
}
