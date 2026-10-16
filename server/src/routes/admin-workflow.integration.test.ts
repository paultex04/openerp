/**
 * Phase 15 item 5 acceptance gates: the admin-editable job workflow.
 *
 *   1. The catalogue endpoints are administrator-only; the read-only workflow
 *      endpoint answers to anyone who can read a job, and nobody else.
 *   2. The catalogue the API serves is the catalogue it enforces - the same rows
 *      drive the job transition endpoint, the lock reasons and the count buckets.
 *   3. Statuses can be created, relabelled, reordered, flagged and deleted, and
 *      the guardrails refuse the destructive cases: a status in use, the last
 *      terminal status, a terminal status with exits, duplicate keys or orders.
 *   4. Transitions can be created, re-permissioned and deleted, and a created edge
 *      takes effect on the very next request (proving the server's workflow cache
 *      is dropped on write, not on restart).
 *   5. The capability named on an edge is what is checked: moving the same edge to
 *      a different permission changes who may do it.
 *
 * Everything this suite creates it destroys. Default statuses are read and
 * probed but never modified by a passing test (the guardrail tests that touch
 * them are refusals, which write nothing).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { prisma } from '../db/client.js';
import {
  TEST_PASSWORD,
  createTestUser,
  destroyTestUser,
  login,
  seededContractWithAmendment,
} from '../test/fixtures.js';
import { invalidateJobWorkflow } from '../operations/workflow.js';

let app: FastifyInstance;

const createdUsers: Array<{ id: number; employeeId: number }> = [];
const cookies = new Map<string, string>();

/** Fixtures swept in `afterAll`, in this key order (jobs, then statuses, then projects). */
const fixtureJobs: number[] = [];
const fixtureProjects: string[] = [];
const fixtureStatusKeys: string[] = [];
const fixtureTransitionIds: number[] = [];

/** Unique per run, so a leaked fixture from a crashed run cannot collide. */
const SUFFIX = Date.now().toString(36);
let keyCounter = 0;

/** A status key that belongs to this suite, e.g. "QA 12 abc123". */
function testStatusKey(label: string): string {
  keyCounter += 1;
  return `QA${keyCounter} ${label} ${SUFFIX}`;
}

beforeAll(async () => {
  app = await buildApp({ config: loadConfig(), logger: false });
  await app.ready();
  // This file's process starts with an empty cache, but a previous test file in
  // the same process (vitest isolation off) could in principle have filled it.
  invalidateJobWorkflow();
});

afterAll(async () => {
  // Transitions go first only to keep the sweep readable; deleting a status
  // would cascade its edges anyway. Every step is guarded so one failure cannot
  // strand the rows after it.
  for (const id of fixtureTransitionIds) {
    await prisma.jobTransitionDefinition.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const id of fixtureJobs) {
    await prisma.job.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const key of fixtureStatusKeys) {
    await prisma.jobTransitionDefinition
      .deleteMany({ where: { OR: [{ fromKey: key }, { toKey: key }] } })
      .catch(() => undefined);
    await prisma.jobStatusDefinition.deleteMany({ where: { key } }).catch(() => undefined);
  }
  for (const code of fixtureProjects) {
    await prisma.project.deleteMany({ where: { code } }).catch(() => undefined);
  }
  for (const user of createdUsers) {
    await destroyTestUser(user).catch(() => undefined);
  }
  invalidateJobWorkflow();
  await app.close();
  await prisma.$disconnect();
});

async function sessionFor(role: string): Promise<string> {
  const cached = cookies.get(role);
  if (cached) return cached;

  const user = await createTestUser(role ? [role] : []);
  createdUsers.push(user);
  const cookie = await login(app, user.email, TEST_PASSWORD);
  cookies.set(role, cookie);
  return cookie;
}

/** A throwaway project, so job fixtures never touch the seeded one. */
async function makeProject(): Promise<number> {
  const { contractId, amendmentId } = await seededContractWithAmendment();
  const code = `QA-PRJ-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  const project = await prisma.project.create({
    data: {
      contractId,
      amendmentId,
      code,
      year: 2026,
      description: 'Phase 15 workflow test fixture project',
    },
    select: { id: true },
  });
  fixtureProjects.push(code);
  return project.id;
}

async function makeJob(projectId: number, status = '01. Scoping'): Promise<number> {
  const job = await prisma.job.create({
    data: {
      projectId,
      status,
      description: 'Phase 15 workflow test fixture job',
    },
    select: { id: true },
  });
  fixtureJobs.push(job.id);
  return job.id;
}

/** Creates a status through the API and tracks it for cleanup. */
async function createStatus(cookie: string, body: Record<string, unknown>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/workflow/statuses',
    headers: { cookie },
    payload: body,
  });
  if (response.statusCode === 201) fixtureStatusKeys.push(response.json().status.key as string);
  return response;
}

/** Creates a transition through the API and tracks it for cleanup. */
async function createTransition(cookie: string, body: Record<string, unknown>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/workflow/transitions',
    headers: { cookie },
    payload: body,
  });
  if (response.statusCode === 201)
    fixtureTransitionIds.push(response.json().transition.id as number);
  return response;
}

// ===========================================================================

describe('Gate 1: who may see and edit the workflow', () => {
  const adminRoutes: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string]> = [
    ['GET', '/api/admin/workflow'],
    ['POST', '/api/admin/workflow/statuses'],
    ['PATCH', '/api/admin/workflow/statuses/01.%20Scoping'],
    ['DELETE', '/api/admin/workflow/statuses/01.%20Scoping'],
    ['POST', '/api/admin/workflow/transitions'],
    ['PATCH', '/api/admin/workflow/transitions/1'],
    ['DELETE', '/api/admin/workflow/transitions/1'],
  ];

  for (const [method, url] of adminRoutes) {
    it(`${method} ${url} requires a session`, async () => {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(401);
    });
  }

  it('refuses a non-administrator on every admin workflow route', async () => {
    const cookie = await sessionFor('project_manager');

    for (const [method, url] of adminRoutes) {
      const response = await app.inject({
        method,
        url,
        headers: { cookie },
        ...(method !== 'GET' && { payload: {} }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('serves the read-only workflow to every role that can read a job', async () => {
    const administrator = await sessionFor('administrator');
    const supervisor = await sessionFor('site_supervisor');

    for (const cookie of [administrator, supervisor]) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/jobs/workflow',
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().workflow.statuses.length).toBeGreaterThan(0);
    }
  });

  it('rejects an account with no roles before any permission check', async () => {
    // Every built-in role carries some job read (general or assigned), so the
    // "no job access at all" case is an account with no roles. That is refused at
    // principal resolution with 401, ahead of any per-route permission test -
    // which is the behaviour worth pinning, since it is the one a person actually
    // meets.
    const cookie = await sessionFor('');

    const response = await app.inject({
      method: 'GET',
      url: '/api/jobs/workflow',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('UNAUTHORIZED');
  });
});

// ===========================================================================

describe('Gate 2: the catalogue the API serves', () => {
  it('returns the 13 default statuses in pipeline order with their flags', async () => {
    const cookie = await sessionFor('administrator');
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/workflow',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.statuses.map((status: { key: string }) => status.key)).toEqual([
      '00. Cancelled',
      '01. Scoping',
      '01A. Scoped',
      '02. Awaiting PO',
      '03. WNYS',
      '04. WIP',
      '05. Work Complete',
      '06. Actuals in Progress',
      '07. Pack Ready',
      '08. Out for signature',
      '09. Awaiting change order',
      '10. Invoiced',
      '11. Partially Invoiced',
    ]);

    const cancelled = body.statuses[0];
    expect(cancelled.isTerminal).toBe(true);
    expect(cancelled.editablePlanned).toBe(false);
    expect(cancelled.editableActuals).toBe(false);

    const scoping = body.statuses.find((status: { key: string }) => status.key === '01. Scoping');
    expect(scoping.editablePlanned).toBe(true);

    const wip = body.statuses.find((status: { key: string }) => status.key === '04. WIP');
    expect(wip.editableActuals).toBe(true);
  });

  it('counts the jobs standing on each status', async () => {
    const cookie = await sessionFor('administrator');
    const projectId = await makeProject();
    const jobId = await makeJob(projectId, '03. WNYS');

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/workflow',
      headers: { cookie },
    });

    const statuses: Array<{ key: string; jobCount: number }> = response.json().statuses;
    const expected = await prisma.job.count({ where: { status: '03. WNYS' } });
    expect(statuses.find((status) => status.key === '03. WNYS')!.jobCount).toBe(expected);
    // The fixture is real, so it must be counted somewhere.
    expect(expected).toBeGreaterThan(0);

    await prisma.job.update({ where: { id: jobId }, data: { status: '01. Scoping' } });
  });

  it('offers exactly the transition capabilities as the assignable set', async () => {
    const cookie = await sessionFor('administrator');
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/workflow',
      headers: { cookie },
    });

    const permissions: Array<{ key: string }> = response.json().transitionPermissions;
    const keys = permissions.map((permission) => permission.key);

    expect(keys).toEqual([
      'job.transition.scope',
      'job.transition.execute',
      'job.transition.pack',
      'job.transition.billing',
      'job.transition.invoice',
      'job.transition.cancel',
    ]);
    for (const key of keys) expect(key.startsWith('job.transition.')).toBe(true);
  });

  it('serves the same catalogue read-only', async () => {
    const cookie = await sessionFor('administrator');
    const admin = await app.inject({
      method: 'GET',
      url: '/api/admin/workflow',
      headers: { cookie },
    });
    const shared = await app.inject({
      method: 'GET',
      url: '/api/jobs/workflow',
      headers: { cookie },
    });

    expect(shared.statusCode).toBe(200);
    expect(shared.json().workflow.statuses.length).toBe(admin.json().statuses.length);
    expect(shared.json().workflow.transitions.length).toBe(admin.json().transitions.length);
    // No admin sugar leaks into the read-only payload.
    expect(shared.json().workflow).not.toHaveProperty('transitionPermissions');
    expect(shared.json().workflow.statuses[0]).not.toHaveProperty('jobCount');
  });
});

// ===========================================================================

describe('Gate 3: statuses', () => {
  it('creates a status, appending it to the pipeline by default', async () => {
    const cookie = await sessionFor('administrator');
    const key = testStatusKey('Append');

    const response = await createStatus(cookie, {
      key,
      label: 'Awaiting QA',
      editablePlanned: false,
      editableActuals: true,
    });

    expect(response.statusCode).toBe(201);
    const created = response.json().status;
    expect(created.key).toBe(key);
    expect(created.isTerminal).toBe(false);

    const max = await prisma.jobStatusDefinition.aggregate({ _max: { sortOrder: true } });
    expect(created.sortOrder).toBe(max._max.sortOrder);

    // The shared endpoint sees it immediately: the write dropped the cache.
    const shared = await app.inject({
      method: 'GET',
      url: '/api/jobs/workflow',
      headers: { cookie },
    });
    expect(
      shared.json().workflow.statuses.some((status: { key: string }) => status.key === key),
    ).toBe(true);
  });

  it('refuses a duplicate key and a duplicate sort order', async () => {
    const cookie = await sessionFor('administrator');
    const key = testStatusKey('Duplicate');
    await createStatus(cookie, { key, label: 'Duplicate probe' });

    const duplicateKey = await createStatus(cookie, { key, label: 'Same key' });
    expect(duplicateKey.statusCode).toBe(409);
    expect(duplicateKey.json().error).toBe('STATUS_KEY_TAKEN');

    const duplicateOrder = await createStatus(cookie, {
      key: testStatusKey('Order'),
      label: 'Same order',
      sortOrder: 5,
    });
    expect(duplicateOrder.statusCode).toBe(409);
    expect(duplicateOrder.json().error).toBe('STATUS_ORDER_TAKEN');
  });

  it('refuses a key or label the database could not store', async () => {
    const cookie = await sessionFor('administrator');

    const badKey = await createStatus(cookie, { key: 'QA!bad!key', label: 'Illegal' });
    expect(badKey.statusCode).toBe(400);
    expect(badKey.json().error).toBe('VALIDATION_FAILED');

    const blankLabel = await createStatus(cookie, { key: testStatusKey('Blank'), label: '   ' });
    expect(blankLabel.statusCode).toBe(400);

    const negativeOrder = await createStatus(cookie, {
      key: testStatusKey('Negative'),
      label: 'Negative order',
      sortOrder: -1,
    });
    expect(negativeOrder.statusCode).toBe(400);
  });

  it('updates label, order and flags', async () => {
    const cookie = await sessionFor('administrator');
    const key = testStatusKey('Editable');
    await createStatus(cookie, { key, label: 'Before', sortOrder: 900 });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/workflow/statuses/${encodeURIComponent(key)}`,
      headers: { cookie },
      payload: {
        label: 'After',
        sortOrder: 901,
        editablePlanned: true,
        editableActuals: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const status = response.json().status;
    expect(status.label).toBe('After');
    expect(status.sortOrder).toBe(901);
    expect(status.editablePlanned).toBe(true);
    expect(status.editableActuals).toBe(true);
  });

  it('refuses to update an unknown status', async () => {
    const cookie = await sessionFor('administrator');
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/admin/workflow/statuses/99.%20Missing',
      headers: { cookie },
      payload: { label: 'Nowhere' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('STATUS_NOT_FOUND');
  });

  it('refuses to delete a status that jobs stand on', async () => {
    const cookie = await sessionFor('administrator');
    const key = testStatusKey('Occupied');
    await createStatus(cookie, { key, label: 'Occupied stage' });

    const projectId = await makeProject();
    const jobId = await makeJob(projectId, key);

    const refused = await app.inject({
      method: 'DELETE',
      url: `/api/admin/workflow/statuses/${encodeURIComponent(key)}`,
      headers: { cookie },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('STATUS_IN_USE');
    expect(refused.json().message).toContain('1 job(s)');

    // Move the job out, then the delete goes through and takes its edges with it.
    await prisma.job.update({ where: { id: jobId }, data: { status: '01. Scoping' } });

    const edge = await createTransition(cookie, {
      from: '01. Scoping',
      to: key,
      permission: 'job.transition.scope',
      reason: 'QA entry.',
    });
    expect(edge.statusCode).toBe(201);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/admin/workflow/statuses/${encodeURIComponent(key)}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(200);

    const edges = await prisma.jobTransitionDefinition.count({
      where: { OR: [{ fromKey: key }, { toKey: key }] },
    });
    expect(edges).toBe(0);
  });

  it('protects the last terminal status', async () => {
    const cookie = await sessionFor('administrator');

    // Unsetting Cancelled would leave no exit at all.
    const unset = await app.inject({
      method: 'PATCH',
      url: '/api/admin/workflow/statuses/00.%20Cancelled',
      headers: { cookie },
      payload: { isTerminal: false },
    });
    expect(unset.statusCode).toBe(409);
    expect(unset.json().error).toBe('LAST_TERMINAL_STATUS');

    // And it cannot be deleted either.
    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/admin/workflow/statuses/00.%20Cancelled',
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(409);
    expect(removed.json().error).toBe('LAST_TERMINAL_STATUS');
  });

  it('refuses a terminal status with outgoing transitions, and allows the flip once they are gone', async () => {
    const cookie = await sessionFor('administrator');
    const key = testStatusKey('Terminalising');
    await createStatus(cookie, { key, label: 'Not yet terminal', sortOrder: 902 });

    const edge = await createTransition(cookie, {
      from: key,
      to: '02. Awaiting PO',
      permission: 'job.transition.scope',
      reason: 'Exit from the QA stage.',
    });
    expect(edge.statusCode).toBe(201);
    const edgeId = edge.json().transition.id;

    const refused = await app.inject({
      method: 'PATCH',
      url: `/api/admin/workflow/statuses/${encodeURIComponent(key)}`,
      headers: { cookie },
      payload: { isTerminal: true },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('TERMINAL_HAS_EDGES');

    await app.inject({
      method: 'DELETE',
      url: `/api/admin/workflow/transitions/${edgeId}`,
      headers: { cookie },
    });

    const flipped = await app.inject({
      method: 'PATCH',
      url: `/api/admin/workflow/statuses/${encodeURIComponent(key)}`,
      headers: { cookie },
      payload: { isTerminal: true },
    });
    expect(flipped.statusCode).toBe(200);
    expect(flipped.json().status.isTerminal).toBe(true);
  });
});

// ===========================================================================

describe('Gate 4: transitions', () => {
  it('refuses edges that make no sense', async () => {
    const cookie = await sessionFor('administrator');

    const self = await createTransition(cookie, {
      from: '01. Scoping',
      to: '01. Scoping',
      permission: 'job.transition.scope',
      reason: 'Round trip.',
    });
    expect(self.statusCode).toBe(422);
    expect(self.json().error).toBe('SELF_TRANSITION');

    const unknown = await createTransition(cookie, {
      from: '01. Scoping',
      to: '99. Nowhere',
      permission: 'job.transition.scope',
      reason: 'Into the void.',
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error).toBe('UNKNOWN_STATUS');

    const fromTerminal = await createTransition(cookie, {
      from: '00. Cancelled',
      to: '01. Scoping',
      permission: 'job.transition.scope',
      reason: 'Rising from the dead.',
    });
    expect(fromTerminal.statusCode).toBe(422);
    expect(fromTerminal.json().error).toBe('TERMINAL_SOURCE');
  });

  it('refuses a capability outside the transition namespace', async () => {
    const cookie = await sessionFor('administrator');
    const key = testStatusKey('Capability');
    await createStatus(cookie, { key, label: 'Capability probe' });

    const response = await createTransition(cookie, {
      from: '01. Scoping',
      to: key,
      permission: 'job.write',
      reason: 'Wrong kind of permission.',
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('UNKNOWN_PERMISSION');

    const invented = await createTransition(cookie, {
      from: '01. Scoping',
      to: key,
      permission: 'job.transition.invented',
      reason: 'A permission nobody holds.',
    });
    expect(invented.statusCode).toBe(422);
    expect(invented.json().error).toBe('UNKNOWN_PERMISSION');
  });

  it('refuses a duplicate edge, and re-permissions or re-words an existing one', async () => {
    const cookie = await sessionFor('administrator');
    const key = testStatusKey('Repoint');
    await createStatus(cookie, { key, label: 'Repoint probe' });

    const created = await createTransition(cookie, {
      from: '01. Scoping',
      to: key,
      permission: 'job.transition.scope',
      reason: 'Sent for QA review.',
    });
    expect(created.statusCode).toBe(201);
    const transitionId = created.json().transition.id;

    const duplicate = await createTransition(cookie, {
      from: '01. Scoping',
      to: key,
      permission: 'job.transition.execute',
      reason: 'Second attempt.',
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe('TRANSITION_EXISTS');

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/admin/workflow/transitions/${transitionId}`,
      headers: { cookie },
      payload: { reason: 'QA review requested.' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().transition.reason).toBe('QA review requested.');

    const badPermission = await app.inject({
      method: 'PATCH',
      url: `/api/admin/workflow/transitions/${transitionId}`,
      headers: { cookie },
      payload: { permission: 'invoice.read' },
    });
    expect(badPermission.statusCode).toBe(422);
    expect(badPermission.json().error).toBe('UNKNOWN_PERMISSION');
  });

  it('refuses unknown transition ids', async () => {
    const cookie = await sessionFor('administrator');
    const missing = 999999;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/admin/workflow/transitions/${missing}`,
      headers: { cookie },
      payload: { reason: 'Ghost.' },
    });
    expect(patched.statusCode).toBe(404);
    expect(patched.json().error).toBe('TRANSITION_NOT_FOUND');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/admin/workflow/transitions/${missing}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(404);
  });
});

// ===========================================================================

describe('Gate 5: the configured workflow is what the job endpoint enforces', () => {
  it('moves a real job across a newly created edge, and honours its flags', async () => {
    const adminCookie = await sessionFor('administrator');
    const pmCookie = await sessionFor('project_manager');

    const key = testStatusKey('QA Hold');
    const created = await createStatus(adminCookie, {
      key,
      label: 'QA Hold',
      editablePlanned: false,
      editableActuals: true,
    });
    expect(created.statusCode).toBe(201);

    const edge = await createTransition(adminCookie, {
      from: '01. Scoping',
      to: key,
      permission: 'job.transition.scope',
      reason: 'Sent for QA hold.',
    });
    expect(edge.statusCode).toBe(201);
    const edgeId = edge.json().transition.id;

    const projectId = await makeProject();
    const jobId = await makeJob(projectId, '01. Scoping');

    // The new stage is offered on the job, with the edge's reason.
    const offered = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/transitions`,
      headers: { cookie: adminCookie },
    });
    const option = offered
      .json()
      .transitions.find((transition: { to: string }) => transition.to === key);
    expect(option).toBeDefined();
    expect(option.allowed).toBe(true);
    expect(option.reason).toBe('Sent for QA hold.');

    // The PM holds job.transition.scope, so the move goes through.
    const moved = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/transition`,
      headers: { cookie: pmCookie },
      payload: { status: key },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().transition.from).toBe('01. Scoping');
    expect(moved.json().transition.to).toBe(key);

    const stored = await prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true },
    });
    expect(stored.status).toBe(key);

    // The new status's flags are honoured immediately: actuals editable, planned not.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}`,
      headers: { cookie: adminCookie },
    });
    expect(detail.json().permissions.canEditActuals).toBe(true);
    expect(detail.json().permissions.canEditPlanned).toBe(false);
    expect(detail.json().permissions.actualsLockReason).toBeNull();

    // ...and the deliverables endpoint agrees.
    const deliverables = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/deliverables`,
      headers: { cookie: adminCookie },
    });
    expect(deliverables.statusCode).toBe(200);

    await app.inject({
      method: 'DELETE',
      url: `/api/admin/workflow/transitions/${edgeId}`,
      headers: { cookie: adminCookie },
    });
  });

  it('checks the capability named on the edge, not the actor’s history', async () => {
    const adminCookie = await sessionFor('administrator');
    const pmCookie = await sessionFor('project_manager');

    const key = testStatusKey('Repermissioned');
    await createStatus(adminCookie, { key, label: 'Repermissioned stage' });

    const edge = await createTransition(adminCookie, {
      from: '01. Scoping',
      to: key,
      permission: 'job.transition.scope',
      reason: 'Initial capability.',
    });
    const edgeId = edge.json().transition.id;

    const projectId = await makeProject();
    const jobId = await makeJob(projectId, '01. Scoping');

    // Re-permission the edge to a capability the PM does not hold.
    const repointed = await app.inject({
      method: 'PATCH',
      url: `/api/admin/workflow/transitions/${edgeId}`,
      headers: { cookie: adminCookie },
      payload: { permission: 'job.transition.execute' },
    });
    expect(repointed.statusCode).toBe(200);

    const pmAttempt = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/transition`,
      headers: { cookie: pmCookie },
      payload: { status: key },
    });
    expect(pmAttempt.statusCode).toBe(403);
    expect(pmAttempt.json().error).toBe('TRANSITION_FORBIDDEN');

    // The administrator holds every capability, so the same move succeeds.
    const adminAttempt = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/transition`,
      headers: { cookie: adminCookie },
      payload: { status: key },
    });
    expect(adminAttempt.statusCode).toBe(200);

    await app.inject({
      method: 'DELETE',
      url: `/api/admin/workflow/transitions/${edgeId}`,
      headers: { cookie: adminCookie },
    });
  });

  it('stops offering a transition once it is deleted', async () => {
    const adminCookie = await sessionFor('administrator');
    const key = testStatusKey('Removed');
    await createStatus(adminCookie, { key, label: 'Removed stage' });

    const edge = await createTransition(adminCookie, {
      from: '01. Scoping',
      to: key,
      permission: 'job.transition.scope',
      reason: 'Temporary edge.',
    });
    const edgeId = edge.json().transition.id;

    const projectId = await makeProject();
    const jobId = await makeJob(projectId, '01. Scoping');

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/admin/workflow/transitions/${edgeId}`,
      headers: { cookie: adminCookie },
    });
    expect(removed.statusCode).toBe(200);

    const offered = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/transitions`,
      headers: { cookie: adminCookie },
    });
    const targets = offered.json().transitions.map((transition: { to: string }) => transition.to);
    expect(targets).not.toContain(key);

    const refused = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/transition`,
      headers: { cookie: adminCookie },
      payload: { status: key },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe('ILLEGAL_TRANSITION');
  });

  it('rejects a status filter that is not in the catalogue', async () => {
    const cookie = await sessionFor('administrator');

    const response = await app.inject({
      method: 'GET',
      url: '/api/jobs?status=99.%20Nonsense',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('INVALID_STATUS');
  });

  it('refuses to move a job to another project', async () => {
    const cookie = await sessionFor('administrator');
    const projectId = await makeProject();
    const otherProjectId = await makeProject();
    const jobId = await makeJob(projectId);

    const moved = await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${jobId}`,
      headers: { cookie },
      payload: { projectId: otherProjectId },
    });
    expect(moved.statusCode).toBe(422);
    expect(moved.json().error).toBe('JOB_PROJECT_IMMUTABLE');

    // Echoing the current value is a no-op, not an error: the register
    // round-trips the row it edits.
    const echoed = await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${jobId}`,
      headers: { cookie },
      payload: { projectId, description: 'Round-tripped.' },
    });
    expect(echoed.statusCode).toBe(200);
    expect(echoed.json().job.description).toBe('Round-tripped.');
  });
});
