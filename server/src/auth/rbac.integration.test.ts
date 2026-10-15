/**
 * Phase 1 acceptance gates, exercised end-to-end through the HTTP layer.
 *
 *   1. Requests without a token return 401 Unauthorized.
 *   2. Users lacking the required role/permission return 403 Forbidden.
 *   3. An active user's profile resolves their linked employee record and
 *      active role set via /api/auth/me.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { prisma } from '../db/client.js';
import { createTestUser, destroyTestUser, login, TEST_PASSWORD } from '../test/fixtures.js';

let app: FastifyInstance;

const created: Array<{ id: number; employeeId: number }> = [];
const track = async (roleKeys: string[]) => {
  const user = await createTestUser(roleKeys);
  created.push(user);
  return user;
};

beforeAll(async () => {
  app = await buildApp({ config: loadConfig(), logger: false });
  await app.ready();
});

afterAll(async () => {
  for (const user of created) {
    await destroyTestUser(user).catch(() => undefined);
  }
  await app.close();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('Gate 1: unauthenticated requests are rejected with 401', () => {
  const protectedRoutes: Array<[string, string]> = [
    ['GET', '/api/auth/me'],
    ['POST', '/api/auth/logout'],
    ['POST', '/api/auth/change-password'],
    ['GET', '/api/_probe/commercial'],
    ['GET', '/api/_probe/actuals'],
  ];

  for (const [method, url] of protectedRoutes) {
    it(`${method} ${url} returns 401 without a token`, async () => {
      const response = await app.inject({ method: method as 'GET', url });
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe('UNAUTHORIZED');
    });
  }

  it('rejects a garbage token with 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'openerp_session=not-a-real-jwt' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('UNAUTHORIZED');
  });

  it('rejects a token signed with the wrong secret with 401', async () => {
    const { TokenCodec } = await import('../auth/tokens.js');
    const forged = await new TokenCodec({
      secret: 'a-completely-different-secret-value-that-is-long-0123456789',
    }).sign({ userId: 1, tokenVersion: 0 });

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `openerp_session=${forged}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('leaves public routes open', async () => {
    await expect(
      app.inject({ method: 'GET', url: '/health' }).then((r) => r.statusCode),
    ).resolves.toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('Gate 2: insufficient permissions are rejected with 403', () => {
  it('blocks a field supervisor from commercial rate components', async () => {
    const user = await track(['site_supervisor']);
    const cookie = await login(app, user.email, TEST_PASSWORD);

    // Authenticated, but the endpoint needs ratemaster.write.
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/_probe/commercial',
      headers: { cookie },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error).toBe('FORBIDDEN');
    expect(forbidden.json().required).toContain('ratemaster.write');
    // The response must not leak which roles they *do* hold internally beyond
    // the assigned set, but naming the missing capability is intentional.
    expect(forbidden.json().message).toMatch(/ratemaster\.write/);
  });

  it('blocks a billing clerk from commercial rate components', async () => {
    const user = await track(['billing_clerk']);
    const cookie = await login(app, user.email, TEST_PASSWORD);
    const response = await app.inject({
      method: 'GET',
      url: '/api/_probe/commercial',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it('blocks a project manager from field actuals entry', async () => {
    const user = await track(['project_manager']);
    const cookie = await login(app, user.email, TEST_PASSWORD);
    const response = await app.inject({
      method: 'GET',
      url: '/api/_probe/actuals',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().required).toContain('deliverable.write.actual');
  });

  it('allows the roles that do hold the permission', async () => {
    const qs = await track(['commercial_qs']);
    const qsCookie = await login(app, qs.email, TEST_PASSWORD);
    await expect(
      app
        .inject({ method: 'GET', url: '/api/_probe/commercial', headers: { cookie: qsCookie } })
        .then((r) => r.statusCode),
    ).resolves.toBe(200);

    const supervisor = await track(['site_supervisor']);
    const supervisorCookie = await login(app, supervisor.email, TEST_PASSWORD);
    await expect(
      app
        .inject({
          method: 'GET',
          url: '/api/_probe/actuals',
          headers: { cookie: supervisorCookie },
        })
        .then((r) => r.statusCode),
    ).resolves.toBe(200);
  });

  it('rejects a deactivated account with 403 at login and 401 afterwards', async () => {
    const user = await track(['commercial_qs']);
    const cookie = await login(app, user.email, TEST_PASSWORD);
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode,
    ).toBe(200);

    await prisma.appUser.update({ where: { id: user.id }, data: { isActive: false } });

    // Existing session is refused immediately.
    const afterDeactivation = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(afterDeactivation.statusCode).toBe(401);

    // Re-login is refused too.
    const relogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: user.email, password: TEST_PASSWORD },
    });
    expect(relogin.statusCode).toBe(403);
    expect(relogin.json().error).toBe('ACCOUNT_INACTIVE');
  });
});

// ---------------------------------------------------------------------------

describe('Gate 3: /api/auth/me resolves the employee and active role set', () => {
  it('uses database role grants as authoritative when resolving permissions', async () => {
    const role = await prisma.appRole.findUniqueOrThrow({ where: { key: 'commercial_qs' } });
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { key: 'ratemaster.write' },
    });
    const original = await prisma.rolePermission.findUnique({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
    });
    try {
      if (original)
        await prisma.rolePermission.delete({
          where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        });
      const user = await track(['commercial_qs']);
      const cookie = await login(app, user.email, TEST_PASSWORD);
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
      expect(me.statusCode).toBe(200);
      expect(me.json().permissions).not.toContain('ratemaster.write');
      expect(me.json().rolePermissions.commercial_qs).not.toContain('ratemaster.write');
    } finally {
      if (original) {
        await prisma.rolePermission.create({
          data: { roleId: role.id, permissionId: permission.id },
        });
      }
    }
  });

  it('returns the linked employee record and roles for a multi-role user', async () => {
    const user = await track(['commercial_qs', 'billing_clerk']);
    const cookie = await login(app, user.email, TEST_PASSWORD);

    const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(response.statusCode).toBe(200);

    const body = response.json();

    expect(body.user.email).toBe(user.email);
    expect(body.user.isActive).toBe(true);

    // The employee record must be the one actually linked via the FK.
    expect(body.employee.id).toBe(user.employeeId);
    expect(body.employee.name).toBe('Test');
    expect(body.employee.surname).toBe('User');

    expect(body.roles.map((r: { key: string }) => r.key).sort()).toEqual([
      'billing_clerk',
      'commercial_qs',
    ]);

    // Effective permissions are the union of both roles.
    expect(body.permissions).toContain('ratemaster.write'); // QS
    expect(body.permissions).toContain('invoice.write'); // billing
    expect(body.permissions).not.toContain('admin.user.write'); // neither

    // Per-role grants are reported separately so the UI can explain why.
    expect(Object.keys(body.rolePermissions).sort()).toEqual(['billing_clerk', 'commercial_qs']);
  });

  it('never returns the password hash or token', async () => {
    const user = await track(['project_manager']);
    const cookie = await login(app, user.email, TEST_PASSWORD);
    const body = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } }))
      .body;
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('password_hash');
    expect(body).not.toMatch(/\$2[aby]\$/);
  });
});

describe('login behaviour', () => {
  it('issues an HttpOnly session cookie and no token in the body', async () => {
    const user = await track(['project_manager']);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: user.email, password: TEST_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(/\$2[aby]\$/);
    expect(JSON.stringify(response.json())).not.toContain('token');

    const setCookie = response.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
    expect(raw.toLowerCase()).toContain('httponly');
    expect(raw).toContain('openerp_session=');
    expect(raw.toLowerCase()).toContain('samesite=lax');
  });

  it('gives an identical error for a wrong password and an unknown email', async () => {
    const user = await track(['project_manager']);

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: user.email, password: 'Wrong#Password123' },
    });
    const unknownEmail = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@example.test', password: TEST_PASSWORD },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    // Identical message => no account enumeration.
    expect(wrongPassword.json().message).toBe(unknownEmail.json().message);
  });

  it('validates the login payload', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'not-an-email', password: '' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('VALIDATION_FAILED');
  });
});

describe('password change', () => {
  it('changes the password and invalidates existing sessions', async () => {
    const user = await track(['project_manager']);
    const cookie = await login(app, user.email, TEST_PASSWORD);
    const newPassword = 'Changed#Rate2026';

    const change = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: TEST_PASSWORD, newPassword },
    });
    expect(change.statusCode).toBe(200);

    // The token minted before the change is now stale.
    const stale = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(stale.statusCode).toBe(401);

    // The new password works.
    await expect(login(app, user.email, newPassword)).resolves.toBeTypeOf('string');
    // The old one does not.
    const oldPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: user.email, password: TEST_PASSWORD },
    });
    expect(oldPassword.statusCode).toBe(401);
  });

  it('refuses an incorrect current password', async () => {
    const user = await track(['project_manager']);
    const cookie = await login(app, user.email, TEST_PASSWORD);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'Nope#Wrong123', newPassword: 'Another#Rate2026' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('enforces the password policy on the new password', async () => {
    const user = await track(['project_manager']);
    const cookie = await login(app, user.email, TEST_PASSWORD);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'weak' },
    });
    expect(response.statusCode).toBe(400);
    // A dedicated code so the UI can show the specific policy reason.
    expect(response.json().error).toBe('PASSWORD_POLICY_VIOLATION');
    expect(response.json().message).toMatch(/at least/i);
  });
});

describe('logout', () => {
  it('clears the session cookie', async () => {
    const user = await track(['project_manager']);
    const cookie = await login(app, user.email, TEST_PASSWORD);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);

    const raw = Array.isArray(response.headers['set-cookie'])
      ? response.headers['set-cookie'][0]!
      : response.headers['set-cookie']!;
    expect(raw).toMatch(/openerp_session=;/);
  });
});
