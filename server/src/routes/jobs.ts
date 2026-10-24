/**
 * Background jobs and asynchronous task endpoints (Step 3).
 *
 * Offloads long-running reporting, invoice summaries, and data exports
 * to the PostgreSQL-backed background queue.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { sendJob, isQueueActive } from '../queue/index.js';

const exportJobSchema = z.object({
  type: z.enum(['invoices', 'timesheets', 'job-costing']),
  filters: z.record(z.string(), z.unknown()).optional(),
});

export async function registerJobRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Health and status of the background job queue.
   */
  app.get(
    '/api/jobs/status',
    { preHandler: [app.authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.code(200).send({
        active: isQueueActive(),
        engine: 'pg-boss (PostgreSQL)',
      });
    },
  );

  /**
   * Enqueues an asynchronous export task.
   */
  app.post(
    '/api/jobs/export',
    { preHandler: [app.authenticate, app.requirePermission('invoice.read')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = exportJobSchema.parse(request.body);
      const principal = request.principal!;

      const jobId = await sendJob(`export:${body.type}`, {
        type: body.type,
        filters: body.filters ?? {},
        requestedBy: principal.userId,
        requestedAt: new Date().toISOString(),
      });

      return reply.code(202).send({
        jobId,
        status: 'enqueued',
        message: `Asynchronous export task for "${body.type}" was successfully queued.`,
      });
    },
  );
}
