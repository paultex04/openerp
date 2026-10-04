import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { authPlugin, HttpError } from './auth/plugin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerClientRoutes } from './routes/contracts.js';
import { registerAmendmentRoutes } from './routes/amendments.js';
import { registerRateMasterRoutes } from './routes/rates.js';
import { registerServiceCodeRoutes } from './routes/serviceCodes.js';
import { registerOperationsRoutes } from './routes/operations.js';
import { registerInvoiceRoutes } from './routes/invoices.js';
import { prisma } from './db/client.js';
import { loadConfig, type Config } from './config.js';

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

  // ---- Liveness / readiness ---------------------------------------------
  app.get('/health', async () => ({ status: 'ok', version: '0.1.0' }));

  app.get('/health/ready', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', database: 'up' };
    } catch {
      return reply.code(503).send({ status: 'degraded', database: 'down' });
    }
  });

  // ---- Auth routes -------------------------------------------------------
  await registerAuthRoutes(app, config);

  // ---- Phase 2: commercial ----------------------------------------------
  await registerClientRoutes(app);
  await registerAmendmentRoutes(app);
  await registerRateMasterRoutes(app);
  await registerServiceCodeRoutes(app);

  // ---- Phase 3: operations ----------------------------------------------
  await registerOperationsRoutes(app);

  // ---- Phase 4: billing -------------------------------------------------
  await registerInvoiceRoutes(app);

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
