/**
 * Phase 13 HTTP smoke test — workflow persistence, contract types, user
 * creation modes and the role-permission editor.
 *
 * Everything here needs a real socket. The amendment persistence bug this phase
 * fixed only showed up as a PATCH response and a later read disagreeing; the
 * role editor's locking rules live in the route; and the two employee modes on
 * user creation are a transaction over two tables. The invoice modal and the
 * job-detail route are UI behaviour, covered by `smoke:phase6` and the client
 * build.
 *
 * ## Residue
 *
 * Bounded and deliberate, like the other smoke scripts:
 *
 *   - the smoke account `smoke-p13@contractor.co.za` and the employee created
 *     with it persist (ADR-005 D6: the admin API has no hard delete), but the
 *     account is deactivated at the end of every run;
 *   - the amendment fixture is hard-deleted at the end — it prices nothing, so
 *     the reference guard does not apply;
 *   - `billing_clerk` grants are edited and restored to their pre-run snapshot.
 *     The role's `permissionsCustomized` marker flips to true the first time and
 *     stays; it records that an administrator edited the role, which is what
 *     happened.
 *
 *   npm run smoke:phase13
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

if (!ADMIN_PASSWORD) {
  console.error('Set SEED_ADMIN_PASSWORD in .env to an existing admin password.');
  process.exit(2);
}

// Fixed identity, reused across runs. See the residue note in the header.
const SMOKE_USER = 'smoke-p13@contractor.co.za';
const SMOKE_PASSWORD = 'Smoke#Phase2026x';

const CONTRACT_TYPES = ['Monthly Core', 'Hourly Core', 'All Inclusive', 'BCEA', 'NBCEI'];

async function main() {
  console.log(colour.dim(`\nOpenERP Phase 13 smoke test against ${BASE}\n`));

  // =======================================================================
  section('Authentication');
  // =======================================================================

  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!checkThat('admin can log in', admin.ok, admin.ok ? '' : `HTTP ${admin.status}`)) {
    summarise();
    return;
  }
  const A = admin.cookie;

  check('the admin surface requires a session', (await request('/api/admin/roles')).status, 401);

  // =======================================================================
  section('Employee contract types');
  // =======================================================================

  const options = await request('/api/admin/users/create-options', { cookie: A });
  check('GET /api/admin/users/create-options', options.status, 200);

  const typeNames = (options.body?.contractTypes ?? []).map((t) => t.name);
  for (const name of CONTRACT_TYPES) {
    checkThat(
      `contract type "${name}" is provisioned`,
      typeNames.includes(name),
      `${typeNames.length} type(s) offered`,
    );
  }

  const contractTypeId = (options.body?.contractTypes ?? [])[0]?.id;
  checkThat(
    'a contract type id is available for the create tests',
    Number.isInteger(contractTypeId),
  );

  // =======================================================================
  section('User creation: link an employee, or create one atomically');
  // =======================================================================

  const usersBefore = await request('/api/admin/users', { cookie: A });
  check('GET /api/admin/users', usersBefore.status, 200);
  const alreadyThere = (usersBefore.body?.users ?? []).find((u) => u.email === SMOKE_USER);

  let smokeUserId = alreadyThere?.id;

  if (alreadyThere) {
    checkThat(
      'the smoke account exists from an earlier run and is reused',
      true,
      `id ${alreadyThere.id}`,
    );
  } else {
    const created = await request('/api/admin/users', {
      method: 'POST',
      cookie: A,
      body: {
        email: SMOKE_USER,
        password: SMOKE_PASSWORD,
        roleKeys: ['billing_clerk'],
        employee: {
          mode: 'new',
          name: 'Smoke',
          surname: 'Phase Thirteen',
          startDate: '2026-01-01',
          rate: 150,
          contractTypeId,
        },
      },
    });
    check('a user can be created together with a new employee', created.status, 201);
    checkThat(
      'the created user reports its employee id',
      Number.isInteger(created.body?.user?.employeeId),
      `employeeId ${created.body?.user?.employeeId}`,
    );
    checkThat(
      'the created user carries the requested role',
      (created.body?.user?.roleKeys ?? []).includes('billing_clerk'),
    );
    smokeUserId = created.body?.user?.id;
  }

  const duplicate = await request('/api/admin/users', {
    method: 'POST',
    cookie: A,
    body: {
      email: SMOKE_USER,
      password: SMOKE_PASSWORD,
      roleKeys: ['billing_clerk'],
      employee: {
        mode: 'new',
        name: 'Smoke',
        surname: 'Duplicate',
        startDate: '2026-01-01',
        rate: 150,
        contractTypeId,
      },
    },
  });
  check('the duplicate email is refused', duplicate.status, 409);
  check('  ... with EMAIL_TAKEN', duplicate.body?.error, 'EMAIL_TAKEN');

  // mode 'existing' guards, both refused without writing anything.
  const claimedEmployeeId = (usersBefore.body?.users ?? [])[0]?.employee?.id;
  if (Number.isInteger(claimedEmployeeId)) {
    const taken = await request('/api/admin/users', {
      method: 'POST',
      cookie: A,
      body: {
        email: 'smoke-p13-taken@contractor.co.za',
        password: SMOKE_PASSWORD,
        roleKeys: ['billing_clerk'],
        employee: { mode: 'existing', employeeId: claimedEmployeeId },
      },
    });
    check('linking an employee who already has an account is refused', taken.status, 409);
    check('  ... with EMPLOYEE_HAS_USER', taken.body?.error, 'EMPLOYEE_HAS_USER');
  } else {
    checkThat('an employee with an account was listed for the link check', false);
  }

  const missing = await request('/api/admin/users', {
    method: 'POST',
    cookie: A,
    body: {
      email: 'smoke-p13-missing@contractor.co.za',
      password: SMOKE_PASSWORD,
      roleKeys: ['billing_clerk'],
      employee: { mode: 'existing', employeeId: 99_999_999 },
    },
  });
  check('linking a non-existent employee is refused', missing.status, 422);
  check('  ... with EMPLOYEE_NOT_ELIGIBLE', missing.body?.error, 'EMPLOYEE_NOT_ELIGIBLE');

  if (Number.isInteger(smokeUserId)) {
    const off = await request(`/api/admin/users/${smokeUserId}`, { method: 'DELETE', cookie: A });
    check('the smoke account is deactivated after the run', off.status, 200);
    const after = await request('/api/admin/users', { cookie: A });
    const row = (after.body?.users ?? []).find((u) => u.id === smokeUserId);
    checkThat('it reads back as inactive', row?.isActive === false);
  }

  // =======================================================================
  section('Role grants: editable, except the locked and protected bits');
  // =======================================================================

  const roles = await request('/api/admin/roles', { cookie: A });
  check('GET /api/admin/roles', roles.status, 200);
  const roleList = roles.body?.roles ?? [];

  const administrator = roleList.find((r) => r.key === 'administrator');
  const billing = roleList.find((r) => r.key === 'billing_clerk');
  checkThat('the administrator role is reported as locked', administrator?.locked === true);
  checkThat(
    'every other role is reported as unlocked',
    roleList.filter((r) => r.key !== 'administrator').every((r) => r.locked === false),
  );

  const snapshot = billing?.granted ?? [];
  checkThat('billing_clerk holds at least two grants', snapshot.length >= 2, `${snapshot.length}`);

  const locked = await request('/api/admin/roles/administrator/permissions', {
    method: 'PUT',
    cookie: A,
    body: { permissionKeys: administrator?.granted ?? ['admin.user.read'] },
  });
  check('the administrator role cannot be edited', locked.status, 409);
  check('  ... with ROLE_LOCKED', locked.body?.error, 'ROLE_LOCKED');

  const protectedGrant = await request('/api/admin/roles/billing_clerk/permissions', {
    method: 'PUT',
    cookie: A,
    body: { permissionKeys: ['admin.user.read'] },
  });
  check('an admin.* grant is refused for a non-administrator role', protectedGrant.status, 422);
  check('  ... with PROTECTED_PERMISSION', protectedGrant.body?.error, 'PROTECTED_PERMISSION');

  const unknownGrant = await request('/api/admin/roles/billing_clerk/permissions', {
    method: 'PUT',
    cookie: A,
    body: { permissionKeys: ['totally.unknown'] },
  });
  check('an unknown permission key is refused', unknownGrant.status, 422);
  check('  ... with UNKNOWN_PERMISSION', unknownGrant.body?.error, 'UNKNOWN_PERMISSION');

  // Editable path: drop one real grant, read it back, then restore. The
  // `finally` is what keeps a mid-run failure from leaving the role reduced.
  const reduced = snapshot.slice(1);
  const grantsOf = async (key) => {
    const res = await request('/api/admin/roles', { cookie: A });
    return (res.body?.roles ?? []).find((r) => r.key === key)?.granted ?? [];
  };

  const edited = await request('/api/admin/roles/billing_clerk/permissions', {
    method: 'PUT',
    cookie: A,
    body: { permissionKeys: reduced },
  });
  check('a non-administrator grant list can be edited', edited.status, 200);
  try {
    const afterEdit = await grantsOf('billing_clerk');
    checkThat(
      'the edited grants are what a subsequent read returns',
      afterEdit.join(',') === reduced.join(','),
      `${afterEdit.length} grant(s)`,
    );
  } finally {
    const restored = await request('/api/admin/roles/billing_clerk/permissions', {
      method: 'PUT',
      cookie: A,
      body: { permissionKeys: snapshot },
    });
    check('the original grants are restored', restored.status, 200);
  }
  const afterRestore = await grantsOf('billing_clerk');
  checkThat(
    'the restore is visible in a subsequent read',
    afterRestore.join(',') === snapshot.join(','),
    `${afterRestore.length} grant(s)`,
  );

  // =======================================================================
  section('Amendment type and status edits persist');
  // =======================================================================

  const contracts = await request('/api/contracts', { cookie: A });
  const contractId = (contracts.body?.contracts ?? [])[0]?.id;
  if (!checkThat('a contract exists to hang the fixture on', Number.isInteger(contractId))) {
    summarise();
    return;
  }

  const stamp = Date.now().toString(36);
  const createdAmendment = await request('/api/amendments', {
    method: 'POST',
    cookie: A,
    body: {
      contractId,
      amendmentNumber: `SMOKE-13-${stamp}`,
      amendmentType: 'Annual Escalation',
      effectiveDate: '2026-01-01',
      status: 'Draft',
      vatRate: 0.15,
    },
  });
  check('POST /api/amendments', createdAmendment.status, 201);
  check(
    'a new amendment starts in the status it was given',
    createdAmendment.body?.amendment?.status,
    'Draft',
  );

  const amendmentId = createdAmendment.body?.amendment?.id;
  if (Number.isInteger(amendmentId)) {
    const patched = await request(`/api/amendments/${amendmentId}`, {
      method: 'PATCH',
      cookie: A,
      body: { amendmentType: 'Scope Change', status: 'Active' },
    });
    check('PATCH /api/amendments/:id', patched.status, 200);
    check(
      'the response carries the new type',
      patched.body?.amendment?.amendmentType,
      'Scope Change',
    );
    check('the response carries the new status', patched.body?.amendment?.status, 'Active');

    const list = await request(`/api/amendments?contractId=${contractId}`, { cookie: A });
    const reread = (list.body?.amendments ?? []).find((a) => a.id === amendmentId);
    checkThat(
      'the edit survives a fresh read (the Phase 13 persistence bug)',
      Boolean(reread),
      `HTTP ${list.status}`,
    );
    check('the persisted type is the edited one', reread?.amendmentType, 'Scope Change');
    check('the persisted status is the edited one', reread?.status, 'Active');

    const removed = await request(`/api/amendments/${amendmentId}`, {
      method: 'DELETE',
      cookie: A,
    });
    check('the fixture amendment is hard-deleted', removed.status, 204);
  }

  summarise();
}

main().catch((error) => {
  console.error(colour.red(`\nSmoke test failed to run: ${error.message}\n`));
  console.error(error.stack);
  process.exit(1);
});
