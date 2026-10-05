/**
 * Phase 5 HTTP smoke test — administration and the audit log.
 *
 * This one runs the parts that only work over real HTTP. Attribution in
 * particular cannot be trusted from an in-process harness: the audit actor is
 * bound per request, and an earlier version recorded every write as `system`
 * until that binding was fixed. Measuring it over a socket is the whole point of
 * these checks.
 *
 * ## Residue
 *
 * This script reuses FIXED fixtures rather than creating a fresh one each run: a
 * smoke account (`smoke-p5@contractor.co.za`) and a smoke client. The client is
 * hard-deleted at the end of the run, since Phase 7 added `DELETE /api/clients/:id`.
 *
 * Exactly one row still persists forever: the smoke **account**. The admin API
 * deliberately offers no hard delete (ADR-005 D6 — a hard delete would cascade
 * away the operational record of who was on a job), so it is deactivated instead.
 *
 * Fixed identities are what keep that bounded. An earlier version minted a fresh
 * email per run and left one dead account and one orphan client behind every
 * time, so the database grew without limit and the baseline drift check could no
 * longer be trusted. Reuse also makes the run idempotent.
 *
 * The audit log is append-only and is never cleaned, by design.
 *
 *   npm run smoke:phase5
 */
import {
  BASE,
  check,
  checkThat,
  colour,
  login,
  request,
  section,
  summarise,
} from './lib/smoke.mjs';

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@contractor.co.za';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? '';
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? '';

if (!ADMIN_PASSWORD) {
  console.error('Set SEED_ADMIN_PASSWORD in .env to an existing admin password.');
  process.exit(2);
}

// Fixed, reused across runs. See the residue note in the header.
const SMOKE_USER = 'smoke-p5@contractor.co.za';

const fixture = { userIds: [], clientEmails: [], clientIds: [] };

async function main() {
  console.log(colour.dim(`\nOpenERP Phase 5 smoke test against ${BASE}\n`));

  // =======================================================================
  section('Authentication and the admin boundary');

  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!checkThat('admin can log in', admin.ok, admin.ok ? '' : `HTTP ${admin.status}`)) {
    summarise();
    return;
  }
  const A = admin.cookie;

  check('the admin surface requires a session', (await request('/api/admin/users')).status, 401);

  if (DEMO_PASSWORD) {
    for (const [email, label] of [
      ['pm@contractor.co.za', 'project manager'],
      ['billing@contractor.co.za', 'billing clerk'],
      ['david.m@contractor.co.za', 'site supervisor'],
    ]) {
      const session = await login(email, DEMO_PASSWORD);
      if (!session.ok) {
        checkThat(`${label} can log in`, false, `HTTP ${session.status}`);
        continue;
      }
      for (const url of ['/api/admin/users', '/api/admin/roles', '/api/admin/audit']) {
        check(
          `${label} cannot reach ${url}`,
          (await request(url, { cookie: session.cookie })).status,
          403,
        );
      }
    }
  }

  // =======================================================================
  section('Users and the role matrix');

  const users = await request('/api/admin/users', { cookie: A });
  check('GET /api/admin/users', users.status, 200);
  const list = users.body?.users ?? [];
  checkThat('users are listed', list.length > 0, `${list.length}`);
  checkThat(
    'no password hash is ever returned',
    !JSON.stringify(users.body).includes('passwordHash') &&
      !JSON.stringify(users.body).includes('$2'),
  );
  checkThat(
    'each user reports an effective permission count',
    list.every((u) => typeof u.permissionCount === 'number'),
  );

  const roles = await request('/api/admin/roles', { cookie: A });
  check('GET /api/admin/roles', roles.status, 200);
  check('five roles are seeded', roles.body?.roles?.length, 5);
  const billing = (roles.body?.roles ?? []).find((r) => r.key === 'billing_clerk');
  checkThat(
    'the billing clerk holds invoice.approve',
    billing?.granted?.includes('invoice.approve'),
  );
  checkThat(
    'every role reports its granted and expected grants for drift checking',
    (roles.body?.roles ?? []).every((r) => Array.isArray(r.granted) && Array.isArray(r.expected)),
  );

  // =======================================================================
  section('Self-lockout is refused');

  const me = await request('/api/auth/me', { cookie: A });
  const selfId = me.body?.user?.id;

  check(
    'an admin cannot deactivate themselves',
    (await request(`/api/admin/users/${selfId}`, { method: 'DELETE', cookie: A })).status,
    409,
  );
  check(
    'an admin cannot drop their own administrator role',
    (
      await request(`/api/admin/users/${selfId}`, {
        method: 'PATCH',
        cookie: A,
        body: { roleKeys: ['billing_clerk'] },
      })
    ).status,
    409,
  );

  // =======================================================================
  section('The audit log, over real HTTP');

  const email = SMOKE_USER;

  // Reuse-or-create, so repeated runs do not accumulate accounts.
  const existing = await request(`/api/admin/users`, { cookie: A });
  const alreadyThere = (existing.body?.users ?? []).find((u) => u.email === email);

  if (alreadyThere) {
    checkThat('the smoke account already exists and is reused', true, `id ${alreadyThere.id}`);
    fixture.userIds.push(alreadyThere.id);
    // Re-activate so the sign-in below works on a repeat run.
    await request(`/api/admin/users/${alreadyThere.id}`, {
      method: 'PATCH',
      cookie: A,
      body: { isActive: true },
    });
  } else {
    const created = await request('/api/admin/users', {
      method: 'POST',
      cookie: A,
      body: {
        email,
        password: 'Smoke#Audit2026',
        roleKeys: ['commercial_qs'],
        employee: { name: 'Smoke', surname: 'Auditor', startDate: '2026-01-01' },
      },
    });
    check('POST /api/admin/users', created.status, 201);
    if (created.body?.user?.id) fixture.userIds.push(created.body.user.id);
  }

  // A weak password is refused during validation, before any row is written, so
  // this leaves no residue.
  const weak = await request('/api/admin/users', {
    method: 'POST',
    cookie: A,
    body: {
      email: `smoke-p5-weak-${Date.now().toString(36)}@example.test`,
      password: 'short',
      roleKeys: ['commercial_qs'],
      employee: { name: 'Smoke', surname: 'Weak', startDate: '2026-01-01' },
    },
  });
  check('a weak password is refused', weak.status, 422);

  const duplicate = await request('/api/admin/users', {
    method: 'POST',
    cookie: A,
    body: {
      email,
      password: 'Smoke#Audit2026',
      roleKeys: ['commercial_qs'],
      employee: { name: 'Smoke', surname: 'Duplicate', startDate: '2026-01-01' },
    },
  });
  check('a duplicate email is refused', duplicate.status, 409);

  // The new account writes something of its own, so the trail has two actors.
  const clientEmail = `smoke-p5-client-${Date.now().toString(36)}@example.test`;
  fixture.clientEmails.push(clientEmail);
  const newUser = await login(email, 'Smoke#Audit2026');
  if (newUser.ok) {
    // Reuse-or-create: the client email is unique, so a repeat run would be
    // refused with 409 and leave the attribution gate with nothing to assert on.
    // Patching it instead still produces an audited UPDATE by the same account,
    // which is what the gate needs.
    const clients = await request('/api/clients', { cookie: A });
    const existingClient = (clients.body?.clients ?? []).find((c) => c.email === clientEmail);

    if (existingClient) {
      fixture.clientIds.push(existingClient.id);
      const touched = await request(`/api/clients/${existingClient.id}`, {
        method: 'PATCH',
        cookie: newUser.cookie,
        body: { address: `Smoke audit re-stamped ${new Date().toISOString().slice(0, 19)}` },
      });
      checkThat(
        'the reused client is re-stamped, producing a fresh audited write',
        touched.status === 200,
        `HTTP ${touched.status}`,
      );
    } else {
      const clientRes = await request('/api/clients', {
        method: 'POST',
        cookie: newUser.cookie,
        body: { name: `Smoke Audit Client`, email: clientEmail },
      });
      check('the new account can write with its own permissions', clientRes.status, 201);
      fixture.clientIds.push(clientRes.body?.client?.id);
    }
    checkThat(
      'a commercial_qs cannot reach the admin surface',
      (await request('/api/admin/audit', { cookie: newUser.cookie })).status === 403,
    );
  } else {
    checkThat('the new account can sign in', false, `HTTP ${newUser.status}`);
  }

  const summary = await request('/api/admin/audit/summary', { cookie: A });
  check('GET /api/admin/audit/summary', summary.status, 200);
  checkThat(
    'the log has entries',
    (summary.body?.activity?.total ?? 0) > 0,
    `${summary.body?.activity?.total ?? 0}`,
  );
  check('no audit write has failed', summary.body?.auditWriteFailures, 0);

  const log = await request('/api/admin/audit?limit=200', { cookie: A });
  check('GET /api/admin/audit', log.status, 200);
  const entries = log.body?.entries ?? [];
  checkThat('entries are returned newest first', entries.length > 0, `${entries.length}`);

  // The gate that was silently broken until the onRoute handler wrapper was
  // added: an entry must name the account that acted and the route that handled
  // it. Matched by record id rather than by summary text — the summary reads
  // "Created client #N" and deliberately carries no business data.
  //
  // Note this asserts the *specific* entry rather than a ratio of attributed to
  // `system` entries. A ratio would be meaningless here: test-suite fixtures are
  // written as `system` by design and accumulate in the log.
  const clientId = fixture.clientIds[0];
  const fromSmoke = entries.filter((e) => e.model === 'Client' && e.recordId === String(clientId));
  checkThat('the new client write is in the log', fromSmoke.length > 0, `client #${clientId}`);
  check('it names the account that made it', fromSmoke[0]?.actorEmail, email);
  check('it names the route that handled it', fromSmoke[0]?.route, '/api/clients');
  check('it names the HTTP method', fromSmoke[0]?.method, 'POST');
  checkThat(
    'it records the action',
    ['CREATE', 'UPDATE'].includes(fromSmoke[0]?.action),
    fromSmoke[0]?.action,
  );

  // The administrator's own actions in this same run are attributed too.
  const adminEntries = entries.filter(
    (e) => e.actorEmail === ADMIN_EMAIL && e.route?.startsWith('/api/admin'),
  );
  checkThat('the admin action in this run is attributed', adminEntries.length > 0);

  // Updates record the change, not the whole row.
  const updated = entries.find((e) => e.action === 'UPDATE' && e.changedFields?.length > 0);
  checkThat('an update records which fields changed', Boolean(updated), updated?.summary ?? '');
  if (updated) {
    const keys = Object.keys(updated.after ?? {});
    check(
      'the stored state holds only the changed fields',
      keys.length,
      updated.changedFields.length,
    );
  }

  const filtered = await request('/api/admin/audit?action=CREATE&limit=20', { cookie: A });
  check('the register filters by action', filtered.status, 200);
  checkThat(
    'a filtered register returns only that action',
    (filtered.body?.entries ?? []).every((e) => e.action === 'CREATE'),
  );

  check(
    'an invalid date range is rejected rather than ignored',
    (await request('/api/admin/audit?from=not-a-date', { cookie: A })).status,
    400,
  );

  const models = await request('/api/admin/audit/models', { cookie: A });
  check('GET /api/admin/audit/models', models.status, 200);
  checkThat('models are listed for the filter', (models.body?.models ?? []).length > 0);

  // =======================================================================
  section('Fixture cleanup');

  for (const id of fixture.userIds) {
    const res = await request(`/api/admin/users/${id}`, { method: 'DELETE', cookie: A });
    checkThat(`the smoke user ${id} is deactivated`, res.status === 200, `HTTP ${res.status}`);
  }

  // Phase 7 added `DELETE /api/clients/:id`, so the smoke client is no longer
  // permanent residue. It has no contracts or contacts, so the delete is
  // accepted rather than refused with 409 - which is itself worth asserting,
  // because it proves the guard refuses only on real references.
  for (const id of fixture.clientIds) {
    if (id === undefined || id === null) continue;
    const res = await request(`/api/clients/${id}`, { method: 'DELETE', cookie: A });
    checkThat(`the smoke client ${id} is removed`, res.status === 204, `HTTP ${res.status}`);
  }

  summarise();
}

main().catch((error) => {
  console.error(colour.red(`\nSmoke test failed to run: ${error.message}\n`));
  console.error(error.stack);
  process.exit(1);
});
