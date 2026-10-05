/**
 * Phase 7 HTTP smoke test — master-data CRUD.
 *
 * Phase 7's headline finding was that the API had run ahead of the UI: contracts,
 * amendments, clients, projects and jobs were all fully implemented and audited,
 * with no way to create one through the application. This script covers the two
 * delete endpoints Phase 7 added to close the server-side half of that gap, and
 * then proves the guards on them.
 *
 * ## What is deliberately NOT tested here
 *
 * The create/edit endpoints these deletes sit alongside are covered by
 * smoke-phase2 (commercial) and smoke-phase3 (operations). Re-asserting them here
 * would duplicate coverage without adding a gate.
 *
 * ## Residue
 *
 * Nothing. Every fixture is created inside a throwaway contract chain and removed
 * again in a `finally`, and the delete guards refuse to cascade, so cleanup is
 * ordered children-first. A failed assertion leaves residue only if the server
 * itself errors, which the final summary reports.
 *
 * Usage (API must be listening):
 *   npm run smoke:phase7
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

/** Ids to remove on the way out, children before parents. */
const residue = { amendments: [], contracts: [], clients: [] };

async function main() {
  console.log(colour.dim(`\nOpenERP Phase 7 smoke test against ${BASE}\n`));

  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!checkThat('admin can log in', admin.ok, admin.ok ? '' : `HTTP ${admin.status}`)) {
    summarise();
    return;
  }
  const A = admin.cookie;

  // =======================================================================
  section('Authentication');

  const noAuth = await request('/api/clients/1', { method: 'DELETE' });
  check('deleting a client needs a session', noAuth.status, 401);

  const badAuth = await request('/api/clients/1', {
    method: 'DELETE',
    cookie: 'openerp_session=not-a-real-session',
  });
  check('an invalid session is rejected', badAuth.status, 401);

  // =======================================================================
  section('DELETE /api/clients/:id');

  const clientEmail = `smoke-p7-client-${Date.now()}@contractor.co.za`;
  const created = await request('/api/clients', {
    method: 'POST',
    cookie: A,
    body: { name: 'Smoke P7 Client', email: clientEmail },
  });
  check('a client can be created', created.status, 201);
  const clientId = created.body?.client?.id;
  checkThat('the created client has an id', Number.isInteger(clientId));

  if (Number.isInteger(clientId)) {
    residue.clients.push(clientId);

    // A contract makes the client undeletable. This is the whole point of the
    // guard: commercial history is evidence, and cascading it away is worse than
    // refusing.
    const contractRes = await request('/api/contracts', {
      method: 'POST',
      cookie: A,
      body: {
        clientId,
        number: `SMOKE-P7-${Date.now()}`,
        description: 'Smoke Phase 7 delete guard fixture',
      },
    });
    check('a contract can be created against it', contractRes.status, 201);
    const contractId = contractRes.body?.contract?.id;
    if (Number.isInteger(contractId)) residue.contracts.push(contractId);

    const refused = await request(`/api/clients/${clientId}`, { method: 'DELETE', cookie: A });
    check('a client with contracts is refused, not cascaded', refused.status, 409);
    checkThat(
      'the refusal names the blocking count',
      typeof refused.body?.message === 'string' && refused.body.message.includes('contract'),
      refused.body?.message ?? '',
    );

    // With the contract gone the delete is accepted, proving the guard keys on
    // real references rather than refusing unconditionally.
    if (Number.isInteger(contractId)) {
      const delContract = await request(`/api/contracts/${contractId}`, {
        method: 'DELETE',
        cookie: A,
      });
      check('the empty contract is deletable', delContract.status, 204);

      const nowAllowed = await request(`/api/clients/${clientId}`, {
        method: 'DELETE',
        cookie: A,
      });
      check('the client deletes once it has no contracts', nowAllowed.status, 204);
      residue.clients = residue.clients.filter((id) => id !== clientId);
    }

    check(
      'deleting it again is a 404',
      (await request(`/api/clients/${clientId}`, { method: 'DELETE', cookie: A })).status,
      404,
    );
  }

  check(
    'deleting an unknown client is a 404',
    (await request('/api/clients/99999999', { method: 'DELETE', cookie: A })).status,
    404,
  );

  // =======================================================================
  section('DELETE /api/amendments/:id');

  // `amendment.delete` was granted to commercial_qs and administrator but had no
  // route at all. Phase 7 added it. These assertions are the gate that the
  // permission is no longer decorative.
  const c2 = await request('/api/clients', {
    method: 'POST',
    cookie: A,
    body: {
      name: 'Smoke P7 Amendment Client',
      email: `smoke-p7-am-${Date.now()}@contractor.co.za`,
    },
  });
  check('a second client is created', c2.status, 201);
  const c2id = c2.body?.client?.id;

  if (Number.isInteger(c2id)) {
    residue.clients.push(c2id);
    const c2Contract = await request('/api/contracts', {
      method: 'POST',
      cookie: A,
      body: {
        clientId: c2id,
        number: `SMOKE-P7-AM-${Date.now()}`,
        description: 'Smoke Phase 7 amendment delete fixture',
      },
    });
    check('a contract is created against it', c2Contract.status, 201);
    const c2ContractId = c2Contract.body?.contract?.id;
    if (Number.isInteger(c2ContractId)) residue.contracts.push(c2ContractId);

    if (Number.isInteger(c2ContractId)) {
      const am = await request('/api/amendments', {
        method: 'POST',
        cookie: A,
        // Enum values are the display strings from `shared/src/schemas/enums.ts`,
        // not the SCREAMING_SNAKE Prisma keys. The route maps them via
        // AMENDMENT_TYPE.toKey() after validation.
        body: {
          contractId: c2ContractId,
          amendmentNumber: '01',
          amendmentType: 'Annual Escalation',
          effectiveDate: '2026-01-01',
          status: 'Active',
          vatRate: 0.15,
        },
      });
      check('an amendment is created', am.status, 201);
      const amId = am.body?.amendment?.id;
      if (Number.isInteger(amId)) residue.amendments.push(amId);

      if (Number.isInteger(amId)) {
        // Give it a cost parameter, which is the cheapest child that must block.
        const putParams = await request(`/api/amendments/${amId}/cost-parameters`, {
          method: 'PUT',
          cookie: A,
          body: {
            // `amendmentId` is required per `costParameterUpsertSchema`, even though the
            // route overrides it from the path. The client sends it too.
            parameters: [
              {
                amendmentId: amId,
                category: 'Overheads',
                parameterName: 'SmokeP7Marker',
                numericValue: 1.5,
                uom: '%',
              },
            ],
          },
        });
        checkThat(
          'a cost parameter is attached to it',
          putParams.status === 200,
          `HTTP ${putParams.status}`,
        );

        const blocked = await request(`/api/amendments/${amId}`, { method: 'DELETE', cookie: A });
        check('an amendment with cost parameters is refused', blocked.status, 409);
        checkThat(
          'the refusal names the blocking count',
          typeof blocked.body?.message === 'string' &&
            blocked.body.message.includes('cost parameter'),
          blocked.body?.message ?? '',
        );

        // Clear the child, then the delete should succeed.
        const clear = await request(`/api/amendments/${amId}/cost-parameters`, {
          method: 'PUT',
          cookie: A,
          body: { parameters: [] },
        });
        checkThat('the cost parameters are cleared', clear.status === 200, `HTTP ${clear.status}`);

        const delAm = await request(`/api/amendments/${amId}`, { method: 'DELETE', cookie: A });
        check('the unreferenced amendment deletes', delAm.status, 204);
        residue.amendments = residue.amendments.filter((id) => id !== amId);
      }
    }
  }

  check(
    'deleting an unknown amendment is a 404',
    (await request('/api/amendments/99999999', { method: 'DELETE', cookie: A })).status,
    404,
  );

  // =======================================================================
  section('Role boundaries on the new deletes');

  // The delete permission is separate from the write permission on purpose, so
  // these must be asserted separately. A role that can create but not delete is
  // a real configuration this system allows.
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
      for (const url of ['/api/clients/1', '/api/amendments/1']) {
        check(
          `${label} cannot delete ${url}`,
          (await request(url, { method: 'DELETE', cookie: session.cookie })).status,
          403,
        );
      }
    }
  } else {
    console.log(colour.dim('  (SEED_DEMO_PASSWORD unset - role boundary checks skipped)'));
  }

  // =======================================================================
  section('Fixture cleanup');

  // Children first. The guards refuse to cascade, so this order is mandatory.
  for (const id of residue.amendments) {
    await request(`/api/amendments/${id}`, { method: 'DELETE', cookie: A });
  }
  for (const id of residue.contracts) {
    await request(`/api/contracts/${id}`, { method: 'DELETE', cookie: A });
  }
  for (const id of residue.clients) {
    const res = await request(`/api/clients/${id}`, { method: 'DELETE', cookie: A });
    // 404 is a legitimate outcome: an earlier step in this same run may already
    // have deleted the client to prove the guard releases once its contracts are
    // gone. Re-asserting 204 unconditionally would fail a run that did the right
    // thing.
    checkThat(
      `the smoke client ${id} is removed`,
      res.status === 204 || res.status === 404,
      `HTTP ${res.status}`,
    );
    if (res.status === 204) residue.clients = residue.clients.filter((c) => c !== id);
  }
  checkThat(
    'no fixtures are left behind',
    residue.clients.length === 0,
    `clients: ${residue.clients.join(', ')}`,
  );

  summarise();
}

main()
  .catch((error) => {
    console.error(colour.red(`\nSmoke test failed to run: ${error.message}\n`));
    console.error(error.stack);
    process.exit(1);
  })
  .finally(async () => {
    // Best-effort cleanup even if an assertion threw, so a failed run does not
    // poison the next one.
    if (residue.clients.length || residue.contracts.length || residue.amendments.length) {
      console.log(colour.dim('\nAttempting cleanup of abandoned fixtures…'));
      try {
        const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
        if (admin.ok) {
          for (const id of residue.amendments)
            await request(`/api/amendments/${id}`, { method: 'DELETE', cookie: admin.cookie });
          for (const id of residue.contracts)
            await request(`/api/contracts/${id}`, { method: 'DELETE', cookie: admin.cookie });
          for (const id of residue.clients)
            await request(`/api/clients/${id}`, { method: 'DELETE', cookie: admin.cookie });
        }
      } catch {
        console.log(colour.dim('  cleanup could not complete; remove the smoke rows by hand'));
      }
    }
  });
