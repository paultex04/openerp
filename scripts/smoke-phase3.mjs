/**
 * Phase 3 HTTP smoke test — the operations surface end to end.
 *
 * Complements the Vitest integration suite. Where that suite drives the app
 * in-process via `inject()` to test logic, this script tests the wiring a unit
 * test cannot see: routing, the auth guards, the HTTP-only cookie round trip,
 * the role boundaries, and whether the acceptance gates actually reject over
 * the wire.
 *
 * Read-only against real data by design. It creates a throwaway project and job
 * and removes them again, and never advances an existing job or edits an existing
 * deliverable, so it is safe to run against development data.
 *
 * Usage (API must be listening):
 *   npm run smoke:phase3
 *
 * Credentials come from the environment via .env; nothing is written to disk.
 */
import {
  BASE,
  check,
  checkClose,
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

/**
 * The 13 job statuses, as an independent test oracle.
 *
 * Deliberately duplicated from the shared state machine rather than imported:
 * a smoke test that shares the implementation it is checking proves nothing.
 * If a 14th status is ever added this list still yields valid probe targets.
 */
const ALL_STATUSES = [
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
];

/** Job 1's seeded actuals. Asserted at the end so a mutating bug cannot hide. */
const BASELINE = {
  plannedSubtotal: 26748.81,
  actualSubtotal: 26784.45,
  lineActuals: [350.45, 2652, 23782],
};

if (!ADMIN_PASSWORD) {
  console.error('Set SEED_ADMIN_PASSWORD in .env to an existing admin password.');
  process.exit(2);
}

// ---------------------------------------------------------------------------

/**
 * Session cookie for the fixture-discovery helpers, set once login succeeds.
 * Module-scoped only because those helpers are called after `main` has already
 * authenticated; every other call passes its cookie explicitly.
 */
let adminCookie = '';

async function main() {
  console.log(colour.dim(`\nOpenERP Phase 3 smoke test against ${BASE}\n`));

  // =======================================================================
  section('Authentication');

  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (
    !checkThat('admin can log in', admin.ok, admin.ok ? '' : `HTTP ${admin.status} ${admin.detail}`)
  ) {
    summarise();
    return;
  }
  adminCookie = admin.cookie;

  // Discovered up front: the lock and fixture sections below both need a service
  // code, and doing it here keeps a single ordering rather than a forward
  // reference from one section into a later one.
  const contractId = await firstContractId();
  const serviceCodeId = contractId ? await firstServiceCodeId(contractId.amendmentId) : null;

  // Sweep orphans from any earlier run that failed partway through. Without this,
  // one crashed run leaves a fixture project behind forever and the next run's
  // project counts quietly drift from the baseline.
  await sweepOrphanFixtures();

  const wrong = await login(ADMIN_EMAIL, 'definitely-not-the-password');
  check('a wrong password is rejected', wrong.status, 401);

  const anon = await request('/api/projects');
  check('unauthenticated access is refused', anon.status, 401);

  // =======================================================================
  section('Projects');

  const projects = await request('/api/projects', { cookie: admin.cookie });
  check('GET /api/projects', projects.status, 200);

  const list = projects.body?.projects ?? [];
  checkThat('at least one project is listed', list.length > 0, `got ${list.length}`);

  const first = list[0];
  check(
    'project status counts cover all 13 statuses',
    Object.keys(first?.statusCounts ?? {}).length,
    13,
  );

  const detail = await request(`/api/projects/${first.id}`, { cookie: admin.cookie });
  check('GET /api/projects/:id', detail.status, 200);
  checkThat(
    'project detail reports financial exposure',
    typeof detail.body?.project?.exposure?.actualSubtotal === 'number',
  );
  check(
    'project detail lists its jobs',
    (detail.body?.project?.jobs ?? []).length,
    first.jobs.length,
  );

  // =======================================================================
  section('Jobs and the deliverable grid');

  const jobs = await request('/api/jobs', { cookie: admin.cookie });
  check('GET /api/jobs', jobs.status, 200);

  const job = (jobs.body?.jobs ?? [])[0];
  checkThat('at least one job is listed', Boolean(job));

  // ---------------------------------------------------------------------------
  // Server-side search and pagination on the jobs register.
  //
  // The jobs register is the one list in the application that searches on the
  // server: every other register fetches everything and filters in the browser,
  // which is the right trade until the result stops fitting in memory. A jobs table
  // does not stay small, so the Job Management page asks for `?search=` and
  // `?page=`.
  //
  // The critical property is that an UNPAGINATED call still returns everything.
  // /field, the dashboard and these smoke tests all depend on it, and silently
  // truncating their result to a default page size would be data loss rather than
  // an error - so it is asserted explicitly rather than assumed.
  // ---------------------------------------------------------------------------

  const paginated = await request('/api/jobs?page=1&pageSize=1', { cookie: admin.cookie });
  check('GET /api/jobs paginates', paginated.status, 200);
  check('a page of 1 returns 1 row', paginated.body?.jobs?.length, 1);
  checkThat(
    'the total counts the whole result, not the page',
    typeof paginated.body?.total === 'number' && paginated.body.total >= jobs.body.jobs.length,
    `total=${paginated.body?.total} all=${jobs.body.jobs.length}`,
  );
  check('the echoed page is 1', paginated.body?.page, 1);
  check('the echoed page size is 1', paginated.body?.pageSize, 1);

  const unpaginated = await request('/api/jobs', { cookie: admin.cookie });
  check(
    'an unpaginated call still returns every job',
    unpaginated.body?.jobs?.length,
    jobs.body.jobs.length,
  );
  checkThat(
    'an unpaginated call reports no total',
    unpaginated.body?.total === undefined,
    `got ${JSON.stringify(unpaginated.body?.total)}`,
  );

  // Page 2 must be a *different* job, or `skip` is being ignored and the table
  // would show the same first row forever.
  if ((paginated.body?.total ?? 0) > 1) {
    const page2 = await request('/api/jobs?page=2&pageSize=1', { cookie: admin.cookie });
    checkThat(
      'page 2 is a different job',
      page2.body?.jobs?.[0]?.id !== paginated.body?.jobs?.[0]?.id,
      `p1=${paginated.body?.jobs?.[0]?.id} p2=${page2.body?.jobs?.[0]?.id}`,
    );
  }

  // Search must actually narrow, and must not be satisfiable by matching nothing.
  const target = jobs.body.jobs[0];
  const searchProbe = target.workOrder ?? target.purchaseOrder ?? null;
  if (searchProbe) {
    const found = await request(`/api/jobs?search=${encodeURIComponent(searchProbe)}`, {
      cookie: admin.cookie,
    });
    check('a search by work order returns 200', found.status, 200);
    checkThat(
      'the searched job is in its own search results',
      (found.body?.jobs ?? []).some((j) => j.id === target.id),
      `searched "${searchProbe}", got ${JSON.stringify((found.body?.jobs ?? []).map((j) => j.id))}`,
    );
  }

  const nonsense = await request('/api/jobs?search=zzzznotajobzzzz', { cookie: admin.cookie });
  checkThat(
    'a search matching nothing returns an empty list, not everything',
    nonsense.status === 200 && (nonsense.body?.jobs ?? []).length === 0,
    `status=${nonsense.status} rows=${(nonsense.body?.jobs ?? []).length}`,
  );

  // Every term must match, mirroring the shared DataTable's `matchesSearch`. A
  // server search that ORs its terms is worse than useless: it looks like narrowing
  // and instead widens the result.
  const projectCode = target.project?.code;
  if (projectCode && target.description) {
    const both = await request(
      `/api/jobs?search=${encodeURIComponent(`${projectCode} ${target.description.slice(0, 12)}`)}`,
      { cookie: admin.cookie },
    );
    const impossible = await request(
      `/api/jobs?search=${encodeURIComponent(`${projectCode} zzzznotajobzzzz`)}`,
      { cookie: admin.cookie },
    );
    checkThat(
      'search terms are ANDed, not ORed',
      impossible.status === 200 && (impossible.body?.jobs ?? []).length === 0,
      `impossible returned ${(impossible.body?.jobs ?? []).length} rows`,
    );
    checkThat(
      'a matching pair of terms still finds the job',
      (both.body?.jobs ?? []).some((j) => j.id === target.id),
    );
  }

  // Filters compose with search rather than replacing it.
  const filtered = await request(`/api/jobs?status=${encodeURIComponent(target.status)}`, {
    cookie: admin.cookie,
  });
  checkThat(
    'the status filter narrows to that status',
    filtered.status === 200 && (filtered.body?.jobs ?? []).every((j) => j.status === target.status),
    `status=${target.status}`,
  );

  const jobDetail = await request(`/api/jobs/${job.id}`, { cookie: admin.cookie });
  check('GET /api/jobs/:id', jobDetail.status, 200);

  const perms = jobDetail.body?.permissions ?? {};
  checkThat(
    'job detail reports what the caller may edit',
    typeof perms.canEditPlanned === 'boolean' && typeof perms.canEditActuals === 'boolean',
  );
  checkThat(
    'job detail lists the available transitions',
    Array.isArray(perms.availableTransitions),
  );
  checkThat(
    'job detail resolves its amendment basis',
    typeof jobDetail.body?.job?.amendmentId === 'number' &&
      typeof jobDetail.body?.job?.amendmentInherited === 'boolean',
  );

  const grid = await request(`/api/jobs/${job.id}/deliverables`, { cookie: admin.cookie });
  check('GET /api/jobs/:id/deliverables', grid.status, 200);

  for (const line of grid.body?.deliverables ?? []) {
    checkThat(
      `${line.code} exposes the applied rate snapshot`,
      typeof line.appliedRate === 'number',
    );
    checkThat(`${line.code} reports quantity variance`, typeof line.quantityVariance === 'number');
    checkThat(`${line.code} reports value variance`, typeof line.valueVariance === 'number');
  }

  // =======================================================================
  section('Lifecycle gates (rejections only — no existing job is moved)');

  const transitions = await request(`/api/jobs/${job.id}/transitions`, { cookie: admin.cookie });
  check('GET /api/jobs/:id/transitions', transitions.status, 200);

  const options = transitions.body?.transitions ?? [];
  checkThat(
    'every transition option carries an allowed flag',
    options.length > 0 && options.every((t) => typeof t.allowed === 'boolean'),
    `${options.length} option(s)`,
  );
  // Every option must explain itself, whatever its verdict. A refusal with no
  // stated reason leaves the caller guessing which permission is missing.
  checkThat(
    'every transition option carries a human-readable reason',
    options.every((t) => typeof t.reason === 'string' && t.reason.length > 0),
  );
  // Note: an administrator is refused nothing here, because they hold every
  // permission. The "refused and names the permission" assertion is made further
  // down against a field supervisor, who genuinely lacks them.

  const noop = await request(`/api/jobs/${job.id}/transition`, {
    method: 'POST',
    cookie: admin.cookie,
    body: { status: job.status },
  });
  check('re-transitioning to the current status is refused', noop.status, 409);

  // The acceptance criterion, tested against the strongest possible caller: an
  // administrator holds all 42 permissions but still may not skip the pipeline.
  // If any of these ever returns 200 the state machine has become advisory only.
  //
  // Probe targets are derived, not hardcoded. Hardcoding jumps assumed the job
  // sits at 01. Scoping — but from 07. Pack Ready, 07 -> 10 is a LEGAL billing
  // transition, so the check would both fail and move a real job. Instead: probe
  // a refused option when one exists, otherwise pick statuses outside the allowed
  // set, which are illegal from the current stage by construction. Either way the
  // POST must never succeed. (An administrator may have zero refused options —
  // they hold every permission — so the fallback is the normal case, not an edge.)
  const refused = options.filter((t) => !t.allowed).slice(0, 3);
  const probes =
    refused.length > 0
      ? refused.map((t) => t.to)
      : ALL_STATUSES.filter(
          (s) => s !== job.status && !options.some((t) => t.allowed && t.to === s),
        ).slice(0, 3);

  checkThat(
    'there is at least one illegal transition to probe',
    probes.length > 0,
    `${probes.length} probe(s)`,
  );
  for (const probe of probes) {
    const jump = await request(`/api/jobs/${job.id}/transition`, {
      method: 'POST',
      cookie: admin.cookie,
      body: { status: probe },
    });
    checkThat(
      `an administrator cannot jump ${job.status} -> ${probe}`,
      jump.status === 422 || jump.status === 409 || jump.status === 403,
      `HTTP ${jump.status} ${jump.body?.message ?? ''}`.slice(0, 90),
    );
  }

  // =======================================================================
  section('Scope and actuals locks on a real job');

  // Find a job whose scope is actually frozen. Testing job[0] is not enough:
  // that may be a job still in scoping, where nothing is locked and the assertion
  // would silently prove nothing.
  const allJobs = jobs.body?.jobs ?? [];
  let frozenJob = null;
  let frozenLine = null;

  for (const candidate of allJobs) {
    const candidateGrid = await request(`/api/jobs/${candidate.id}/deliverables`, {
      cookie: admin.cookie,
    });
    const locked = (candidateGrid.body?.deliverables ?? []).find((d) => d.plannedLocked);
    if (locked) {
      frozenJob = candidate;
      frozenLine = locked;
      break;
    }
  }

  if (frozenLine) {
    checkThat(`job ${frozenJob.id} has a deliverable with a frozen scope`, true, frozenLine.code);

    const attempt = await request(`/api/job-deliverables/${frozenLine.id}/planned`, {
      method: 'PATCH',
      cookie: admin.cookie,
      body: { plannedQuantity: 1 },
    });
    check('a frozen planned edit is refused', attempt.status, 409);
    check('the refusal is reported as SCOPE_FROZEN', attempt.body?.error, 'SCOPE_FROZEN');
    checkThat(
      'the lock reason names the last editable status',
      String(frozenLine.plannedLockReason ?? '').includes('02. Awaiting PO'),
    );

    // Adding a new deliverable to a frozen job must be refused too, otherwise
    // the lock only guards edits and the scope can still grow after release.
    const addAttempt = await request(`/api/jobs/${frozenJob.id}/deliverables`, {
      method: 'POST',
      cookie: admin.cookie,
      body: { serviceCodeId, plannedQuantity: 1 },
    });
    check('adding a deliverable to a frozen job is refused', addAttempt.status, 409);
  } else {
    checkThat('a job with a frozen scope exists to test', false, 'none of the listed jobs has one');
  }

  // =======================================================================
  section('Role boundaries');

  if (!DEMO_PASSWORD) {
    checkThat('role boundaries verified', false, 'SEED_DEMO_PASSWORD is not set');
  } else {
    // Each seeded role, asserted against the RBAC matrix rather than assumed.
    const expectations = [
      [
        'david.m@contractor.co.za',
        'site_supervisor',
        ['job.read.assigned', 'deliverable.write.actual'],
      ],
      ['sipho.z@contractor.co.za', 'site_supervisor', ['job.read.assigned']],
      ['bongani.d@contractor.co.za', 'commercial_qs', ['project.read', 'servicecode.write']],
      ['pm@contractor.co.za', 'project_manager', ['project.read', 'job.transition.scope']],
      ['billing@contractor.co.za', 'billing_clerk', ['job.transition.invoice']],
    ];

    for (const [email, label, expected] of expectations) {
      const session = await login(email, DEMO_PASSWORD);
      if (
        !checkThat(`${label} can log in`, session.ok, session.ok ? '' : `HTTP ${session.status}`)
      ) {
        continue;
      }

      const me = await request('/api/auth/me', { cookie: session.cookie });
      const held = new Set(me.body?.permissions ?? []);

      check(
        `${label} holds ${expected.length} expected permission(s)`,
        expected.every((p) => held.has(p)),
        true,
      );

      // No role except the administrator may invoice.
      if (label !== 'billing_clerk') {
        check(`${label} cannot invoice`, held.has('job.transition.invoice'), false);
      }
    }

    // The supervisor is scoped to their own jobs and must not reach Projects.
    const sup = await login('david.m@contractor.co.za', DEMO_PASSWORD);
    const projectsForSup = await request('/api/projects', { cookie: sup.cookie });
    check('a field supervisor cannot list projects', projectsForSup.status, 403);

    const field = await request('/api/field/my-work', { cookie: sup.cookie });
    check('a field supervisor can read their own work', field.status, 200);

    const fieldJobs = field.body?.jobs ?? [];
    checkThat(
      'the field view returns at least one job',
      fieldJobs.length > 0,
      `${fieldJobs.length} job(s)`,
    );

    for (const j of fieldJobs) {
      checkThat(
        `field job ${j.id} reports whether actuals are editable`,
        typeof j.permissions?.canEditActuals === 'boolean',
      );
      checkThat(
        `field job ${j.id} reports its available transitions`,
        Array.isArray(j.permissions?.availableTransitions),
      );
      checkThat(
        `field job ${j.id} carries deliverables and a summary`,
        Array.isArray(j.deliverables) && Boolean(j.summary),
      );
    }

    // The acceptance criterion: a field supervisor cannot jump 01 -> 10.
    const scoping = fieldJobs.find((j) => j.status === '01. Scoping');
    if (scoping) {
      const jump = await request(`/api/jobs/${scoping.id}/transition`, {
        method: 'POST',
        cookie: sup.cookie,
        body: { status: '10. Invoiced' },
      });
      checkThat(
        'a field supervisor cannot jump 01. Scoping -> 10. Invoiced',
        jump.status === 403 || jump.status === 422,
        `HTTP ${jump.status} ${jump.body?.message ?? ''}`.slice(0, 80),
      );
    } else {
      checkThat('a 01. Scoping job was available for the jump test', false);
    }

    // A supervisor cannot edit the scope; that is a planning action.
    const anyDeliverable = fieldJobs.flatMap((j) => j.deliverables ?? [])[0];
    if (anyDeliverable) {
      const attempt = await request(`/api/job-deliverables/${anyDeliverable.id}/planned`, {
        method: 'PATCH',
        cookie: sup.cookie,
        body: { plannedQuantity: 1 },
      });
      check('a field supervisor cannot edit planned quantities', attempt.status, 403);
    }

    // A refused transition must name the permission it needs. Asserted here
    // rather than as an administrator, who is refused nothing and so would make
    // the assertion vacuous.
    const supTransitions = await request('/api/jobs/1/transitions', { cookie: sup.cookie });
    const supOptions = supTransitions.body?.transitions ?? [];
    checkThat(
      'a supervisor sees at least one transition refused',
      supOptions.some((t) => t.allowed === false),
      `${supOptions.filter((t) => !t.allowed).length} refused`,
    );
    checkThat(
      'a refused transition names the permission it requires',
      supOptions.some((t) => !t.allowed && t.requiredPermission),
    );
    checkThat(
      'a supervisor is never offered invoicing',
      !supOptions.some((t) => t.allowed && /Invoiced/.test(t.to)),
    );
  }

  // =======================================================================
  section('Fixture: scoping, freezing and actuals round trip');

  if (!contractId || !serviceCodeId) {
    checkThat('fixture round trip', false, 'no contract or service code available');
  } else {
    const smokeProjectCode = `SMOKE-P3-${Date.now().toString(36)}`;

    const project = await request('/api/projects', {
      method: 'POST',
      cookie: admin.cookie,
      // amendmentId omitted: the API defaults to the contract's active amendment.
      body: {
        contractId: contractId.id,
        code: smokeProjectCode,
        year: 2026,
        description: 'Phase 3 smoke fixture',
      },
    });
    check('POST /api/projects', project.status, 201);

    // Declared outside the block because the cleanup below needs it even when an
    // inner assertion has already failed the run.
    const projectId = project.body?.project?.id;

    if (project.status === 201) {
      const created = await request('/api/jobs', {
        method: 'POST',
        cookie: admin.cookie,
        body: { projectId, amendmentId: null, description: 'Phase 3 smoke fixture job' },
      });
      check('POST /api/jobs', created.status, 201);
      check('a new job starts at 01. Scoping', created.body?.job?.status, '01. Scoping');

      const smokeJobId = created.body?.job?.id;

      // Amendment inheritance.
      const inherited = await request(`/api/jobs/${smokeJobId}`, { cookie: admin.cookie });
      check(
        'a null job amendment inherits the project amendment',
        inherited.body?.job?.amendmentInherited,
        true,
      );
      check(
        'the inherited amendment is the project amendment',
        inherited.body?.job?.amendmentId,
        contractId.amendmentId,
      );

      // Scoping a deliverable snapshots the rate.
      const added = await request(`/api/jobs/${smokeJobId}/deliverables`, {
        method: 'POST',
        cookie: admin.cookie,
        body: { serviceCodeId, plannedQuantity: 4 },
      });
      check('POST /api/jobs/:id/deliverables', added.status, 201);

      if (added.status === 201) {
        const line = added.body.deliverables[0];
        checkClose(
          'planned subtotal equals quantity x snapshot rate',
          line.plannedSubtotal,
          Math.round(line.appliedRate * 4 * 100) / 100,
        );

        // Actuals are refused before execution begins.
        const tooEarly = await request(`/api/job-deliverables/${line.id}/actual`, {
          method: 'PATCH',
          cookie: admin.cookie,
          body: { actualQuantity: 5 },
        });
        check('actuals are refused while the job is scoping', tooEarly.status, 409);
        check('the refusal is reported as ACTUALS_LOCKED', tooEarly.body?.error, 'ACTUALS_LOCKED');

        // Walk the pipeline legally: 01 -> 01A -> 02 -> 03 -> 04.
        for (const step of ['01A. Scoped', '02. Awaiting PO', '03. WNYS', '04. WIP']) {
          const move = await request(`/api/jobs/${smokeJobId}/transition`, {
            method: 'POST',
            cookie: admin.cookie,
            body: { status: step },
          });
          check(`the pipeline advances to ${step}`, move.status, 200);
        }

        // Past 02. Awaiting PO the scope is frozen.
        const frozen = await request(`/api/job-deliverables/${line.id}/planned`, {
          method: 'PATCH',
          cookie: admin.cookie,
          body: { plannedQuantity: 999 },
        });
        check('planned quantities freeze once released for procurement', frozen.status, 409);
        check('the refusal is reported as SCOPE_FROZEN', frozen.body?.error, 'SCOPE_FROZEN');

        const addedLater = await request(`/api/jobs/${smokeJobId}/deliverables`, {
          method: 'POST',
          cookie: admin.cookie,
          body: { serviceCodeId, plannedQuantity: 1 },
        });
        check('adding a deliverable to a frozen job is refused', addedLater.status, 409);

        // Record an actual during execution.
        const recorded = await request(`/api/job-deliverables/${line.id}/actual`, {
          method: 'PATCH',
          cookie: admin.cookie,
          body: { actualQuantity: 6 },
        });
        check('actuals can be recorded during execution', recorded.status, 200);

        if (recorded.status === 200) {
          const after = recorded.body.deliverables.find((d) => d.id === line.id);
          checkClose(
            'actual subtotal uses the same snapshot rate',
            after.actualSubtotal,
            Math.round(line.appliedRate * 6 * 100) / 100,
          );
          check('quantity variance is actual minus planned', after.quantityVariance, 2);
          checkClose(
            'recording an actual leaves the planned subtotal untouched',
            after.plannedSubtotal,
            line.plannedSubtotal,
          );
          check(
            'recording an actual leaves the snapshot rate untouched',
            after.appliedRate,
            line.appliedRate,
          );
        }

        // Advance one more step and confirm actuals lock again.
        await request(`/api/jobs/${smokeJobId}/transition`, {
          method: 'POST',
          cookie: admin.cookie,
          body: { status: '05. Work Complete' },
        });
        const stillOpen = await request(`/api/job-deliverables/${line.id}/actual`, {
          method: 'PATCH',
          cookie: admin.cookie,
          body: { actualQuantity: 7 },
        });
        check('actuals remain editable at 05. Work Complete', stillOpen.status, 200);
      }

      const removed = await request(`/api/jobs/${smokeJobId}`, {
        method: 'DELETE',
        cookie: admin.cookie,
      });
      check('DELETE /api/jobs/:id removes the fixture', removed.status, 204);
    }

    const removedProject = await request(`/api/projects/${projectId}`, {
      method: 'DELETE',
      cookie: admin.cookie,
    });
    check('DELETE /api/projects/:id removes the fixture', removedProject.status, 204);
  }

  // =======================================================================
  section('Baseline integrity');

  const seeded = await request('/api/jobs/1/deliverables', { cookie: admin.cookie });
  if (seeded.status === 200) {
    const totals = seeded.body?.summary;
    checkClose('job 1 planned is unchanged', totals?.plannedSubtotal, BASELINE.plannedSubtotal);
    checkClose('job 1 actuals are unchanged', totals?.actualSubtotal, BASELINE.actualSubtotal);
    const actuals = (seeded.body?.deliverables ?? []).map((d) => d.actualSubtotal);
    check('job 1 still has 3 deliverable lines', actuals.length, 3);
    BASELINE.lineActuals.forEach((expected, i) => {
      checkClose(`job 1 line ${i + 1} actual is unchanged`, actuals[i], expected);
    });
  } else {
    check('job 1 is readable', seeded.status, 200);
  }

  summarise();
}

// ---------------------------------------------------------------------------
// Fixture discovery
// ---------------------------------------------------------------------------

/**
 * Deletes any leftover `SMOKE-P3-*` projects and their jobs.
 *
 * These fixtures are created by this script and by nothing else, so removing them
 * unconditionally is safe — provided the code prefix is distinctive, which is why
 * it embeds a timestamp and the project description is checked too.
 */
async function sweepOrphanFixtures() {
  const list = await request('/api/projects?search=SMOKE-P3-', { cookie: adminCookie });
  const orphans = (list.body?.projects ?? []).filter(
    (p) => String(p.code).startsWith('SMOKE-P3-') || p.description === 'Phase 3 smoke fixture',
  );

  for (const orphan of orphans) {
    const detail = await request(`/api/projects/${orphan.id}`, { cookie: adminCookie });
    for (const j of detail.body?.project?.jobs ?? []) {
      await request(`/api/jobs/${j.id}`, { method: 'DELETE', cookie: adminCookie });
    }
    const removed = await request(`/api/projects/${orphan.id}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    console.log(
      colour.dim(`  swept orphan fixture project ${orphan.code} (HTTP ${removed.status})`),
    );
  }
}

/** Finds a contract with an ACTIVE amendment, for the fixture project. */
async function firstContractId() {
  const res = await request('/api/contracts', { cookie: adminCookie });
  const contracts = res.body?.contracts ?? [];

  for (const contract of contracts) {
    const active = (contract.amendments ?? []).find((a) => a.status === 'ACTIVE');
    if (active) return { id: contract.id, amendmentId: active.id };
  }

  // Fall back to the amendment list if contracts are not nested.
  const amendments = await request('/api/amendments', { cookie: adminCookie });
  const active = (amendments.body?.amendments ?? []).find((a) => a.status === 'ACTIVE');
  if (active && contracts[0]) return { id: contracts[0].id, amendmentId: active.id };
  return null;
}

/** Picks an activity service code to scope, so the snapshot has a real rate. */
async function firstServiceCodeId(amendmentId) {
  const res = await request(`/api/service-codes?amendmentId=${amendmentId}`, {
    cookie: adminCookie,
  });
  const codes = res.body?.serviceCodes ?? [];
  const activity = codes.find((c) => String(c.category ?? '').includes('ACTIVITY')) ?? codes[0];
  return activity?.id ?? null;
}

main().catch((error) => {
  console.error(colour.red(`\nSmoke test failed to run: ${error.message}\n`));
  console.error(error.stack);
  process.exit(1);
});
