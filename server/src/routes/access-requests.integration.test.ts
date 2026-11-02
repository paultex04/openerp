import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { prisma } from '../db/client.js';
import { createTestUser, destroyTestUser, login } from '../test/fixtures.js';

let app: FastifyInstance;
let adminCookie: string;
let adminUserId: number;
let adminEmployeeId: number;

const createdUserIds: number[] = [];
const createdEmployeeIds: number[] = [];
const createdAccessRequestIds: number[] = [];

const SUFFIX = Date.now().toString(36);

beforeAll(async () => {
  const config = loadConfig();
  app = await buildApp({ config, logger: false });
  await app.ready();

  const admin = await createTestUser(['administrator']);
  adminUserId = admin.id;
  adminEmployeeId = admin.employeeId;
  adminCookie = await login(app, admin.email, admin.password);
});

afterAll(async () => {
  if (createdAccessRequestIds.length > 0) {
    await prisma.accessRequest.deleteMany({
      where: { id: { in: createdAccessRequestIds } },
    });
  }

  for (const id of createdUserIds) {
    await prisma.appUserRole.deleteMany({ where: { userId: id } });
    await prisma.appUser.delete({ where: { id } }).catch(() => {});
  }

  for (const id of createdEmployeeIds) {
    await prisma.employee.delete({ where: { id } }).catch(() => {});
  }

  if (adminUserId) {
    await destroyTestUser({ id: adminUserId, employeeId: adminEmployeeId });
  }

  await app.close();
});

describe('Access Request Workflow', () => {
  const testEmail = `requester.${SUFFIX}@contractor.co.za`;
  let accessRequestId: number;

  it('rejects an invalid access request submission (validation)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/access-requests',
      payload: {
        fullName: 'A', // too short
        email: 'invalid-email',
        phone: '123',
        department: '',
        reason: 'Short',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('submits a valid access request successfully', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/access-requests',
      payload: {
        fullName: 'Thabo Mbeki',
        email: testEmail,
        phone: '+27 82 555 1234',
        department: 'Instrumentation',
        jobTitle: 'Field Technician',
        reason: 'Assigned to the Medupi Unit 4 outage project for daily task capture.',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.id).toBeDefined();

    accessRequestId = body.id;
    createdAccessRequestIds.push(accessRequestId);
  });

  it('refuses duplicate pending request for the same email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/access-requests',
      payload: {
        fullName: 'Thabo Mbeki',
        email: testEmail,
        phone: '+27 82 555 1234',
        department: 'Instrumentation',
        reason: 'Duplicate request test.',
      },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe('REQUEST_PENDING');
  });

  it('allows the requester to check request status as Pending', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/access-requests/status?email=${encodeURIComponent(testEmail)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.found).toBe(true);
    expect(body.request.status).toBe('Pending');
    expect(body.request.email).toBe(testEmail);
    expect(body.request.fullName).toBe('Thabo Mbeki');
  });

  it('reports not found for unsubmitted email', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/access-requests/status?email=nonexistent.${SUFFIX}@contractor.co.za`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.found).toBe(false);
    expect(body.request).toBeNull();
  });

  it('requires admin permissions to list access requests', async () => {
    // Unauthenticated
    const unauth = await app.inject({
      method: 'GET',
      url: '/api/admin/access-requests',
    });
    expect(unauth.statusCode).toBe(401);

    // Authenticated admin
    const auth = await app.inject({
      method: 'GET',
      url: '/api/admin/access-requests',
      headers: { cookie: adminCookie },
    });
    expect(auth.statusCode).toBe(200);
    const body = JSON.parse(auth.payload);
    expect(Array.isArray(body.requests)).toBe(true);
    expect(body.requests.some((r: any) => r.id === accessRequestId)).toBe(true);
  });

  it('reports pending count correctly for admins', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/access-requests/pending-count',
      headers: { cookie: adminCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.count).toBeGreaterThanOrEqual(1);
  });

  it('allows admin to approve request and provision user account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/access-requests/${accessRequestId}/approve`,
      headers: { cookie: adminCookie },
      payload: {
        roleKeys: ['site_supervisor'],
        temporaryPassword: 'TempPassword123!',
        adminNotes: 'Welcome to the team. Assigned to supervisor role.',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.userId).toBeDefined();
    expect(body.temporaryPassword).toBe('TempPassword123!');

    createdUserIds.push(body.userId);
    createdEmployeeIds.push(body.employeeId);

    // Requester status should now be Approved
    const statusRes = await app.inject({
      method: 'GET',
      url: `/api/auth/access-requests/status?email=${encodeURIComponent(testEmail)}`,
    });
    const statusBody = JSON.parse(statusRes.payload);
    expect(statusBody.request.status).toBe('Approved');
    expect(statusBody.request.adminNotes).toBe('Welcome to the team. Assigned to supervisor role.');
  });

  it('allows admin to reject an access request with notes', async () => {
    const rejectEmail = `reject.${SUFFIX}@contractor.co.za`;
    const submitRes = await app.inject({
      method: 'POST',
      url: '/api/auth/access-requests',
      payload: {
        fullName: 'Kagiso Rabada',
        email: rejectEmail,
        phone: '+27 83 123 4567',
        department: 'Operations',
        reason: 'Requesting access for project viewing.',
      },
    });
    expect(submitRes.statusCode).toBe(201);
    const submitBody = JSON.parse(submitRes.payload);
    createdAccessRequestIds.push(submitBody.id);

    const rejectRes = await app.inject({
      method: 'POST',
      url: `/api/admin/access-requests/${submitBody.id}/reject`,
      headers: { cookie: adminCookie },
      payload: {
        adminNotes: 'Please request through your site manager first.',
      },
    });
    expect(rejectRes.statusCode).toBe(200);

    // Requester status check returns Rejected with explanation
    const statusRes = await app.inject({
      method: 'GET',
      url: `/api/auth/access-requests/status?email=${encodeURIComponent(rejectEmail)}`,
    });
    const statusBody = JSON.parse(statusRes.payload);
    expect(statusBody.request.status).toBe('Rejected');
    expect(statusBody.request.adminNotes).toBe('Please request through your site manager first.');
  });
});
