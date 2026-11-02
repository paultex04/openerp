import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createTestUser, destroyTestUser, login } from '../test/fixtures.js';

let app: FastifyInstance;
let adminCookie: string;
let adminUser: { id: number; employeeId: number; email: string };
let workerCookie: string;
let workerUser: { id: number; employeeId: number; email: string };

beforeAll(async () => {
  const config = loadConfig();
  app = await buildApp({ config, logger: false });
  await app.ready();

  const admin = await createTestUser(['administrator']);
  adminUser = { id: admin.id, employeeId: admin.employeeId, email: admin.email };
  adminCookie = await login(app, admin.email, admin.password);

  const worker = await createTestUser(['site_supervisor']);
  workerUser = { id: worker.id, employeeId: worker.employeeId, email: worker.email };
  workerCookie = await login(app, worker.email, worker.password);
});

afterAll(async () => {
  if (adminUser) await destroyTestUser(adminUser);
  if (workerUser) await destroyTestUser(workerUser);
  await app.close();
});

describe('System Diagnostics API (/api/admin/diagnostics)', () => {
  it('refuses unauthenticated requests with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/diagnostics',
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses non-admin users with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/diagnostics',
      headers: { cookie: workerCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns comprehensive system diagnostics for administrators', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/diagnostics',
      headers: { cookie: adminCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Core envelope
    expect(body).toHaveProperty('timestamp');
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('uptimeSeconds');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(body).toHaveProperty('nodeVersion');
    expect(body).toHaveProperty('platform');

    // Memory
    expect(body.memory).toHaveProperty('rssMb');
    expect(body.memory).toHaveProperty('heapUsedMb');
    expect(body.memory).toHaveProperty('heapTotalMb');
    expect(body.memory.heapUsedMb).toBeGreaterThan(0);

    // Database
    expect(body.database).toHaveProperty('status');
    expect(body.database.status).toBe('healthy');
    expect(body.database).toHaveProperty('latencyMs');
    expect(body.database).toHaveProperty('version');
    expect(body.database.pool).toHaveProperty('totalCount');
    expect(body.database.pool).toHaveProperty('maxConnections');
    expect(body.database.pool.maxConnections).toBe(25);

    // Storage
    expect(body.storage).toHaveProperty('status');
    expect(body.storage).toHaveProperty('active');
    expect(body.storage).toHaveProperty('bucket');

    // Queue
    expect(body.queue).toHaveProperty('status');
    expect(body.queue).toHaveProperty('activeJobs');
    expect(body.queue).toHaveProperty('completedJobs');
    expect(body.queue).toHaveProperty('failedJobs');

    // Audit
    expect(body.audit).toHaveProperty('failuresCount');
  });
});
