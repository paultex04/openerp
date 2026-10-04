/**
 * Billing API: the invoice register, generation from job actuals, draft edits,
 * deletion and the lifecycle transitions.
 *
 * RBAC map:
 *   invoice.read    — register and detail (every commercial role has this
 *                     except field supervisors, who have no invoice rights)
 *   invoice.write   — generate drafts, edit drafts, delete drafts
 *   invoice.submit  — Draft -> Submitted (billing clerk and QS)
 *   invoice.approve — Submitted -> Approved (billing clerk only)
 *   invoice.status  — payment, disputes, cancellation (billing clerk only)
 *
 * Transition capability beyond these coarse guards comes from the shared
 * invoice state machine inside `transitionInvoice`, mirroring the job routes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  authoriseInvoiceTransition,
  invoiceGenerateSchema,
  invoiceTransitionSchema,
  invoiceUpdateSchema,
  nextInvoiceStatuses,
  type InvoiceStatus,
} from '@openerp/shared';
import { HttpError } from '../auth/plugin.js';
import {
  deleteInvoice,
  generateDraft,
  getInvoiceDetail,
  listInvoices,
  toHttpError,
  transitionInvoice,
  updateDraft,
} from '../billing/service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

const listQuery = z.object({
  status: z.string().trim().min(1).optional(),
  jobId: z.coerce.number().int().positive().optional(),
  search: z.string().trim().min(1).optional(),
});

export async function registerInvoiceRoutes(app: FastifyInstance): Promise<void> {
  // =======================================================================
  // Register
  // =======================================================================

  app.get(
    '/api/invoices',
    { preHandler: [app.authenticate, app.requirePermission('invoice.read')] },
    async (request: FastifyRequest) => {
      const query = listQuery.parse(request.query ?? {});
      try {
        return { invoices: await listInvoices(query) };
      } catch (error) {
        toHttpError(error);
      }
    },
  );

  app.get(
    '/api/invoices/:id',
    { preHandler: [app.authenticate, app.requirePermission('invoice.read')] },
    async (request: FastifyRequest) => {
      const { id } = idParam.parse(request.params);
      const principal = request.principal!;
      try {
        return await getInvoiceDetail(id, principal.permissions);
      } catch (error) {
        toHttpError(error);
      }
    },
  );

  // =======================================================================
  // Generation
  // =======================================================================

  /**
   * Raises a draft invoice from a job's measured actuals.
   *
   * Nested under the job because the job is the commercial source: every
   * figure on the invoice is derived from that job's deliverables and
   * amendment. The response includes what was skipped (zero-actual lines) and
   * the VAT compliance verdict, so the caller sees the full basis at a glance.
   */
  app.post(
    '/api/jobs/:id/invoices',
    { preHandler: [app.authenticate, app.requirePermission('invoice.write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const body = invoiceGenerateSchema.parse(request.body ?? {});
      try {
        const outcome = await generateDraft(id, {
          deliverableIds: body.deliverableIds,
          dueDate: body.dueDate,
          notes: body.notes ?? null,
        });
        return reply.code(201).send(outcome);
      } catch (error) {
        toHttpError(error);
      }
    },
  );

  // =======================================================================
  // Draft edits and deletion
  // =======================================================================

  app.patch(
    '/api/invoices/:id',
    { preHandler: [app.authenticate, app.requirePermission('invoice.write')] },
    async (request: FastifyRequest) => {
      const { id } = idParam.parse(request.params);
      const body = invoiceUpdateSchema.parse(request.body);
      try {
        const detail = await updateDraft(id, {
          ...(body.dueDate !== undefined && { dueDate: body.dueDate }),
          ...(body.notes !== undefined && { notes: body.notes }),
        });
        return { invoice: detail.invoice, lines: detail.lines };
      } catch (error) {
        toHttpError(error);
      }
    },
  );

  /**
   * Deletes a draft or cancelled invoice with its lines.
   *
   * The capability depends on the document's state — drafts need
   * `invoice.write`, cancellations need `invoice.status` — so no single
   * `requirePermission` fits and the check happens inside, against the same
   * `canDeleteInvoice` rule the service enforces. Both roles that can reach
   * here (billing, QS-with-write) are validated against the actual document.
   */
  app.delete(
    '/api/invoices/:id',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParam.parse(request.params);
      const principal = request.principal!;

      let detail;
      try {
        detail = await getInvoiceDetail(id);
      } catch (error) {
        toHttpError(error);
      }

      const status = detail!.invoice.status as string;
      const permitted =
        (status === 'Draft' && principal.permissions.has('invoice.write')) ||
        (status === 'Cancelled' && principal.permissions.has('invoice.status'));

      if (!permitted) {
        throw new HttpError(
          403,
          'FORBIDDEN',
          `Deleting a "${status}" invoice requires ` +
            (status === 'Draft' ? '"invoice.write".' : '"invoice.status".'),
        );
      }

      try {
        await deleteInvoice(id);
      } catch (error) {
        toHttpError(error);
      }
      return reply.code(204).send();
    },
  );

  // =======================================================================
  // Transitions
  // =======================================================================

  /**
   * The transition endpoint.
   *
   * Legality is judged by the shared invoice state machine and capability by
   * the RBAC catalogue, both inside `transitionInvoice`. Approving additionally
   * settles the job's billing position (`10. Invoiced` vs
   * `11. Partially Invoiced`), which the response reports.
   */
  app.post(
    '/api/invoices/:id/transition',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const { id } = idParam.parse(request.params);
      const body = invoiceTransitionSchema.parse(request.body);
      const principal = request.principal!;
      try {
        return {
          transition: await transitionInvoice(id, body.status as InvoiceStatus, principal),
        };
      } catch (error) {
        toHttpError(error);
      }
    },
  );

  /** Legal targets from an invoice's current status, for driving the UI. */
  app.get(
    '/api/invoices/:id/transitions',
    { preHandler: [app.authenticate, app.requirePermission('invoice.read')] },
    async (request: FastifyRequest) => {
      const { id } = idParam.parse(request.params);
      const principal = request.principal!;

      let detail;
      try {
        detail = await getInvoiceDetail(id);
      } catch (error) {
        toHttpError(error);
      }

      const from = detail!.invoice.status as InvoiceStatus;
      return {
        from,
        transitions: nextInvoiceStatuses(from).map((to) => {
          const check = authoriseInvoiceTransition(from, to, principal.permissions);
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
}
