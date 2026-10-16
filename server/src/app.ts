import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { authPlugin, HttpError } from './auth/plugin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerProfileRoutes, AVATAR_MAX_BYTES } from './routes/profile.js';
import { registerClientRoutes } from './routes/contracts.js';
import { registerAmendmentRoutes } from './routes/amendments.js';
import { registerRateMasterRoutes } from './routes/rates.js';
import { registerServiceCodeRoutes } from './routes/serviceCodes.js';
import { registerOperationsRoutes } from './routes/operations.js';
import { registerInvoiceRoutes } from './routes/invoices.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAdminWorkflowRoutes } from './routes/admin-workflow.js';
import { registerOrganisationRoutes } from './routes/organisation.js';
import { registerTimesheetRoutes } from './routes/timesheets.js';
import { registerChatRoutes } from './routes/chat.js';
import { prisma } from './db/client.js';
import { loadConfig, type Config } from './config.js';
import { APP_VERSION } from './version.js';

export interface BuildAppOptions {
  config?: Config;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();

  const app = Fastify({
    logger: options.logger ?? !config.isTest,
  });

  await app.register(cors, {
    origin: config.CLIENT_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true, // required for the session cookie to travel
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    // No blanket global limiter: it would cap legitimate bulk reads (a 2 000-row
    // job list is one request) and makes thresholds arbitrary. Limits are
    // applied per route where brute force is actually a concern — currently
    // credential endpoints only. See routes/auth.ts.
    global: false,
  });

  await app.register(authPlugin, { config });

  // Multipart uploads (the profile avatar). The cap is enforced while the file
  // streams, so an oversized upload is refused before it is buffered in memory.
  await app.register(multipart, {
    limits: { fileSize: AVATAR_MAX_BYTES, files: 1, fields: 8 },
  });

  // ---- Liveness / readiness ---------------------------------------------
  app.get('/health', async () => ({ status: 'ok', version: APP_VERSION }));

  app.get('/health/ready', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', database: 'up' };
    } catch (error: unknown) {
      // Logged, because a bare 503 with no line in the log is indistinguishable
      // from a container that never started. `SELECT 1` should not fail, so when
      // it does the cause is worth seeing.
      _req.log.error({ err: error }, 'readiness probe failed');
      return reply.code(503).send({ status: 'degraded', database: 'down' });
    }
  });

  // ---- Auth routes -------------------------------------------------------
  await registerAuthRoutes(app, config);
  await registerProfileRoutes(app, config);

  // ---- Phase 2: commercial ----------------------------------------------
  await registerClientRoutes(app);
  await registerAmendmentRoutes(app);
  await registerRateMasterRoutes(app);
  await registerServiceCodeRoutes(app);

  // ---- Phase 3: operations ----------------------------------------------
  await registerOperationsRoutes(app);

  // ---- Phase 4: billing -------------------------------------------------
  await registerInvoiceRoutes(app);

  // ---- Phase 5: admin & audit -------------------------------------------
  await registerAdminRoutes(app);
  // Phase 15: the job status workflow editor.
  await registerAdminWorkflowRoutes(app);

  // ---- Phase 7: organisation master data --------------------------------
  await registerOrganisationRoutes(app);

  // ---- Phase 16: timesheets & job costing -------------------------------
  await registerTimesheetRoutes(app);

  // ---- Phase 17: internal chat ------------------------------------------
  await registerChatRoutes(app);

  // ---- Deliberately protected probe --------------------------------------
  // Phase 1 has no domain routes yet. These two routes exist so the RBAC guard
  // can be exercised end-to-end by the test suite; Phase 2+ replaces them with
  // real commercial endpoints.
  app.get(
    '/api/_probe/commercial',
    {
      preHandler: [app.authenticate, app.requirePermission('ratemaster.write')],
    },
    async (request) => ({
      ok: true,
      message: 'Commercial rate component access granted.',
      employee: request.principal!.employee,
      roles: request.principal!.roleKeys,
    }),
  );

  app.get(
    '/api/_probe/actuals',
    {
      preHandler: [app.authenticate, app.requirePermission('deliverable.write.actual')],
    },
    async (request) => ({
      ok: true,
      message: 'Field actuals entry access granted.',
      employee: request.principal!.employee,
    }),
  );

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: 'NOT_FOUND',
      message: `Route ${request.method} ${request.url} does not exist.`,
    }),
  );

  return app;
}

export { HttpError };
