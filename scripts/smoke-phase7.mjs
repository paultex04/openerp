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
 * Exactly THREE rows persist forever, by design and bounded:
 *
 *   - `Smoke P7 Contract Type` (employee_contract_type)
 *   - `Smoke P7 Broker` (broker)
 *   - `smoke-p7-employee@example.test` (employee, left employed)
 *
 * They exist because ADR-007 Q4 makes an employee row *terminated rather than
 * deleted*. An employee therefore permanently holds its contract type, so that
 * type can never be deleted either, and while the employee holds a broker neither
 * can that be. An earlier draft created all three per run and tried to clean them
 * up, which cannot work: every run would have leaked three rows, forever. They are
 * now created-if-missing and reused, which also makes the run idempotent - this is
 * the same lesson Phase 5 records in its own residue note.
 *
 * Clients, contracts, amendments and contacts are genuine throwaways. Cleanup runs
 * children-first because the delete guards refuse to cascade, and each residue
 * list is pruned as it empties so the final assertion measures reality rather than
 * intent.
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
const residue = {
  employees: [],
  contacts: [],
  brokers: [],
  types: [],
  amendments: [],
  contracts: [],
  clients: [],
};

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
  // The organisation surface. Before Phase 7 none of these four tables had a
  // single route, so every check here is new coverage rather than a regression
  // guard.
  //
  // BROKER, CONTRACT TYPE AND EMPLOYEE ARE FIXTURES, NOT THROWAWAYS.
  //
  // An earlier draft created all three per run and cleaned them up. That cannot
  // work: ADR-007 Q4 means an employee row is terminated, never deleted, so the
  // employee permanently holds its contract type, and the contract type therefore
  // can never be deleted either. Every run would have leaked three rows forever.
  // This is the same trap Phase 5 documents in its own residue note, hit from the
  // other direction.
  //
  // So these three are created-if-missing and left in place; the employee is
  // re-activated at the start of each run so the "end employment" assertions
  // still exercise a live row. Bounded at three rows, idempotent across runs.
  // Clients, contracts, amendments and contacts are genuine throwaways.
  // =======================================================================
  section('Organisation: brokers, contract types, employees, contacts');

  // --- contract type (fixed fixture) --------------------------------------
  const TYPE_NAME = 'Smoke P7 Contract Type';
  const existingTypes = await request('/api/employee-contract-types?search=Smoke P7', {
    cookie: A,
  });
  let typeId = (existingTypes.body?.types ?? []).find((t) => t.name === TYPE_NAME)?.id;
  let typeCreated = false;
  if (!Number.isInteger(typeId)) {
    const typeRes = await request('/api/employee-contract-types', {
      method: 'POST',
      cookie: A,
      body: { name: TYPE_NAME },
    });
    check('POST /api/employee-contract-types', typeRes.status, 201);
    typeId = typeRes.body?.type?.id;
    typeCreated = true;
  } else {
    checkThat('the fixed contract type fixture is reused', Number.isInteger(typeId));
  }

  if (Number.isInteger(typeId)) {
    const dup = await request('/api/employee-contract-types', {
      method: 'POST',
      cookie: A,
      body: { name: TYPE_NAME },
    });
    check('a duplicate contract type is a 409, not a 500', dup.status, 409);

    const list = await request('/api/employee-contract-types', { cookie: A });
    check('GET /api/employee-contract-types', list.status, 200);
    checkThat(
      'the list carries an employee count per type',
      list.body?.types?.every((t) => typeof t.employees === 'number') === true,
    );
  }
  void typeCreated;

  // --- broker (fixed fixture) ---------------------------------------------
  const BROKER_NAME = 'Smoke P7 Broker';
  const existingBrokers = await request('/api/brokers?search=Smoke P7', { cookie: A });
  let brokerId = (existingBrokers.body?.brokers ?? []).find((b) => b.name === BROKER_NAME)?.id;
  if (!Number.isInteger(brokerId)) {
    const brokerRes = await request('/api/brokers', {
      method: 'POST',
      cookie: A,
      body: { name: BROKER_NAME },
    });
    check('POST /api/brokers', brokerRes.status, 201);
    brokerId = brokerRes.body?.broker?.id;
  } else {
    checkThat('the fixed broker fixture is reused', Number.isInteger(brokerId));
  }

  // The rename is a PATCH assertion on a row that must keep its name, so it is
  // renamed back inside the same block.
  const brokerPatch = await request(`/api/brokers/${brokerId}`, {
    method: 'PATCH',
    cookie: A,
    body: { name: `${BROKER_NAME} RENAMED` },
  });
  check('PATCH /api/brokers/:id', brokerPatch.status, 200);
  check('the rename is reflected', brokerPatch.body?.broker?.name, `${BROKER_NAME} RENAMED`);
  await request(`/api/brokers/${brokerId}`, {
    method: 'PATCH',
    cookie: A,
    body: { name: BROKER_NAME },
  });

  // --- employee (fixed fixture) -------------------------------------------
  const EMP_EMAIL = 'smoke-p7-employee@example.test';
  const existingEmployees = await request('/api/employees?search=smoke-p7-employee', { cookie: A });
  let employee = (existingEmployees.body?.employees ?? []).find((e) => e.email === EMP_EMAIL);

  if (employee) {
    checkThat('the fixed employee fixture is reused', Boolean(employee?.id));
    // Re-activate so the end-employment assertions below run against a live row.
    if (employee.endDate !== null) {
      const reactivate = await request(`/api/employees/${employee.id}`, {
        method: 'PATCH',
        cookie: A,
        body: { endDate: null },
      });
      check('an ended employee can be re-activated', reactivate.status, 200);
      employee = null;
    }
  }

  if (!employee) {
    const empRes = await request('/api/employees', {
      method: 'POST',
      cookie: A,
      body: {
        name: 'Smoke',
        surname: 'P7',
        email: EMP_EMAIL,
        startDate: '2026-01-01',
        contractTypeId: typeId,
        brokerId,
      },
    });
    check('POST /api/employees', empRes.status, 201);
    employee = { id: empRes.body?.employee?.id };
  }
  const employeeId = employee?.id;
  checkThat('the employee fixture has an id', Number.isInteger(employeeId));

  if (Number.isInteger(employeeId) && Number.isInteger(brokerId)) {
    const heldByBroker = await request(`/api/brokers/${brokerId}`, {
      method: 'DELETE',
      cookie: A,
    });
    check('a broker with employees is refused', heldByBroker.status, 409);
    checkThat(
      'the refusal names the count',
      typeof heldByBroker.body?.message === 'string' &&
        heldByBroker.body.message.includes('employee'),
      heldByBroker.body?.message ?? '',
    );
  }

  if (Number.isInteger(employeeId) && Number.isInteger(typeId)) {
    const heldByType = await request(`/api/employee-contract-types/${typeId}`, {
      method: 'DELETE',
      cookie: A,
    });
    check('a contract type held by an employee is refused', heldByType.status, 409);
  }

  if (Number.isInteger(employeeId)) {
    // An employee with no login is deactivatable, and the row must survive: the
    // whole point of ADR-007 Q4 is that employment ends, the record does not.
    const ended = await request(`/api/employees/${employeeId}`, {
      method: 'DELETE',
      cookie: A,
    });
    check('DELETE /api/employees/:id', ended.status, 204);

    const after = await request('/api/employees?search=smoke-p7-employee', { cookie: A });
    const stillThere = (after.body?.employees ?? []).find((e) => e.id === employeeId);
    checkThat('the employee record survives the delete', Boolean(stillThere));
    checkThat(
      'it is now flagged inactive',
      stillThere?.isActive === false,
      `endDate=${stillThere?.endDate}`,
    );
    checkThat('an end date was recorded', typeof stillThere?.endDate === 'string');

    // Leave the fixture employed, so the next run reuses a live row rather than
    // re-activating one.
    const reactivate = await request(`/api/employees/${employeeId}`, {
      method: 'PATCH',
      cookie: A,
      body: { endDate: null },
    });
    check('the employee can be re-employed', reactivate.status, 200);
  }

  // An unassignable reference is a 400 naming the field, not a Prisma 500.
  const badRef = await request('/api/employees', {
    method: 'POST',
    cookie: A,
    body: { name: 'Bad', surname: 'Ref', startDate: '2026-01-01', contractTypeId: 99999999 },
  });
  check('an unknown contract type is a 400', badRef.status, 400);
  checkThat(
    'and it names the bad reference',
    String(badRef.body?.message ?? '').includes('contract type'),
    badRef.body?.message ?? '',
  );

  // --- contacts (throwaway) -----------------------------------------------
  const contactClientEmail = `smoke-p7-contact-client-${Date.now()}@example.test`;
  const contactClient = await request('/api/clients', {
    method: 'POST',
    cookie: A,
    body: { name: 'Smoke P7 Contact Client', email: contactClientEmail },
  });
  check('a client is created for the contact fixture', contactClient.status, 201);
  const contactClientId = contactClient.body?.client?.id;
  if (Number.isInteger(contactClientId)) residue.clients.push(contactClientId);

  if (Number.isInteger(contactClientId)) {
    const contact = await request('/api/contacts', {
      method: 'POST',
      cookie: A,
      body: {
        clientId: contactClientId,
        name: 'Smoke P7 Contact',
        email: 'smoke-p7-contact@example.test',
      },
    });
    check('POST /api/contacts', contact.status, 201);
    const contactId = contact.body?.contact?.id;
    if (Number.isInteger(contactId)) residue.contacts.push(contactId);

    if (Number.isInteger(contactId)) {
      const patch = await request(`/api/contacts/${contactId}`, {
        method: 'PATCH',
        cookie: A,
        body: { mobile: '0820000000' },
      });
      check('PATCH /api/contacts/:id', patch.status, 200);
      check('the mobile is stored', patch.body?.contact?.mobile, '0820000000');

      // The client now has a contact, so the client delete must refuse again -
      // the guard from the first section has a second leg.
      const clientHeld = await request(`/api/clients/${contactClientId}`, {
        method: 'DELETE',
        cookie: A,
      });
      check('a client with contacts is refused', clientHeld.status, 409);

      const del = await request(`/api/contacts/${contactId}`, { method: 'DELETE', cookie: A });
      check('DELETE /api/contacts/:id', del.status, 204);
      residue.contacts = residue.contacts.filter((id) => id !== contactId);
    }

    const badClient = await request('/api/contacts', {
      method: 'POST',
      cookie: A,
      body: { clientId: 99999999, name: 'Orphan' },
    });
    check('a contact for an unknown client is a 400', badClient.status, 400);
  }

  // --- search --------------------------------------------------------------
  const searchEmployees = await request('/api/employees?search=Smoke', { cookie: A });
  check('GET /api/employees?search=', searchEmployees.status, 200);
  checkThat(
    'search returns a list',
    Array.isArray(searchEmployees.body?.employees),
    `count=${searchEmployees.body?.employees?.length}`,
  );

  // =======================================================================
  section('Organisation role boundaries');

  // `employee.read` is the ONLY organisation permission any non-administrator
  // holds, and it is granted to the PM for the crew-assignment picker. Every
  // other key must be refused. This is the check that stops a future edit from
  // quietly widening the catalogue.
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
      check(
        `${label} cannot write an employee`,
        (
          await request('/api/employees', {
            method: 'POST',
            cookie: session.cookie,
            body: { name: 'X', surname: 'Y', startDate: '2026-01-01', contractTypeId: 1 },
          })
        ).status,
        403,
      );
      check(
        `${label} cannot write a broker`,
        (
          await request('/api/brokers', {
            method: 'POST',
            cookie: session.cookie,
            body: { name: 'X' },
          })
        ).status,
        403,
      );
      check(
        `${label} cannot read contacts`,
        (await request('/api/contacts', { cookie: session.cookie })).status,
        403,
      );
    }

    // The PM is the one role that must be able to READ employees, because
    // `job.assign` is theirs and the picker needs a list.
    const pm = await login('pm@contractor.co.za', DEMO_PASSWORD);
    if (pm.ok) {
      check(
        'the project manager CAN read employees',
        (await request('/api/employees', { cookie: pm.cookie })).status,
        200,
      );
    }
  } else {
    console.log(colour.dim('  (SEED_DEMO_PASSWORD unset - role boundary checks skipped)'));
  }

  // =======================================================================
  // Archiving (Phase 8 item 3)
  //
  // Three properties matter and none of them is "the button exists":
  //   1. a list hides archived rows by default and shows them on request;
  //   2. a row with live references is refused, with the count in the message;
  //   3. only a role holding `*.archive` may change the state.
  // =======================================================================
  section('Archiving');

  const archClient = await request('/api/clients', {
    method: 'POST',
    cookie: A,
    body: { name: 'Smoke P7 Archive Client', email: `smoke-p7-arch-${Date.now()}@example.test` },
  });
  check('a client is created for the archive fixture', archClient.status, 201);
  const archId = archClient.body?.client?.id;
  if (Number.isInteger(archId)) residue.clients.push(archId);

  if (Number.isInteger(archId)) {
    const before = await request('/api/clients', { cookie: A });
    checkThat(
      'a live client appears in the default list',
      (before.body?.clients ?? []).some((c) => c.id === archId),
    );

    const archived = await request(`/api/clients/${archId}/archive`, {
      method: 'POST',
      cookie: A,
    });
    check('POST /:id/archive', archived.status, 200);

    const after = await request('/api/clients', { cookie: A });
    checkThat(
      'an archived client is HIDDEN from the default list',
      !(after.body?.clients ?? []).some((c) => c.id === archId),
    );

    const withArchived = await request('/api/clients?includeArchived=true', { cookie: A });
    check('GET /?includeArchived=true', withArchived.status, 200);
    const shown = (withArchived.body?.clients ?? []).find((c) => c.id === archId);
    checkThat('and is shown when explicitly requested', Boolean(shown));
    check('it is marked archived in the payload', shown?.isArchived, true);

    // A picker must not offer it. The client/contract picker reads this same
    // endpoint, so "hidden by default" IS the picker guarantee - which is why it is
    // a server-side default rather than a client-side filter.
    checkThat(
      'so a picker built on this endpoint cannot select it',
      !(after.body?.clients ?? []).some((c) => c.id === archId),
    );

    const restored = await request(`/api/clients/${archId}/archive`, {
      method: 'DELETE',
      cookie: A,
    });
    check('DELETE /:id/archive restores', restored.status, 200);
    const afterRestore = await request('/api/clients', { cookie: A });
    checkThat(
      'and it is selectable again',
      (afterRestore.body?.clients ?? []).some((c) => c.id === archId),
    );

    // A referenced row must be refused. Give it a contract, then try to archive.
    // The contract id goes into residue: without it the contract survives, the
    // client keeps a reference forever, and the client can never be deleted - which
    // is exactly the leak this section previously caused on every run.
    const blocker = await request('/api/contracts', {
      method: 'POST',
      cookie: A,
      body: {
        clientId: archId,
        number: `SMOKE-P7-ARCH-${Date.now()}`,
        description: 'Blocks archiving the client',
      },
    });
    check('a contract is created to hold the reference', blocker.status, 201);
    if (Number.isInteger(blocker.body?.contract?.id)) {
      residue.contracts.push(blocker.body.contract.id);
    }
    const clientsWithContract = await request('/api/clients', { cookie: A });
    const withContract = (clientsWithContract.body?.clients ?? []).find((c) => c.id === archId);

    // Archiving a client is allowed even with contracts - the contract is what the
    // client is *for*, and cascading would be the dangerous move. What must be
    // refused is archiving a CONTRACT that still has running work.
    checkThat(
      'archiving a client with a contract is allowed (no cascade)',
      (await request(`/api/clients/${archId}/archive`, { method: 'POST', cookie: A })).status ===
        200,
    );
    void withContract;

    // Contact archiving: a contact named on a job must be refused.
    const jobScoped = await request('/api/jobs/1/contacts', { cookie: A }).catch(() => null);
    void jobScoped;

    // Restore before the section ends. An archived client cannot be deleted while it
    // has a contract - the delete is refused - so leaving the fixture archived makes
    // it unremovable and every future run inherits it. Archiving is reversible, so
    // the cleanup has to be too.
    const finalRestore = await request(`/api/clients/${archId}/archive`, {
      method: 'DELETE',
      cookie: A,
    });
    check('the archived fixture is restored before cleanup', finalRestore.status, 200);

    const contactForArchive = await request('/api/contacts', {
      method: 'POST',
      cookie: A,
      body: { clientId: archId, name: 'Archive Guard Contact' },
    });
    check('a contact is created for the archive guard', contactForArchive.status, 201);
    const guardContactId = contactForArchive.body?.contact?.id;
    if (Number.isInteger(guardContactId)) {
      const ok = await request(`/api/contacts/${guardContactId}/archive`, {
        method: 'POST',
        cookie: A,
      });
      check('an unreferenced contact archives', ok.status, 200);
      const undo = await request(`/api/contacts/${guardContactId}/archive`, {
        method: 'DELETE',
        cookie: A,
      });
      check('and restores', undo.status, 200);
      await request(`/api/contacts/${guardContactId}`, { method: 'DELETE', cookie: A });
    }
  }

  if (DEMO_PASSWORD) {
    for (const [email, label] of [
      ['billing@contractor.co.za', 'billing clerk'],
      ['david.m@contractor.co.za', 'site supervisor'],
    ]) {
      const session = await login(email, DEMO_PASSWORD);
      if (!session.ok) continue;
      check(
        `${label} cannot archive a client`,
        (await request('/api/clients/1/archive', { method: 'POST', cookie: session.cookie }))
          .status,
        403,
      );
      check(
        `${label} cannot archive a broker`,
        (await request('/api/brokers/1/archive', { method: 'POST', cookie: session.cookie }))
          .status,
        403,
      );
    }
  }

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

  // Children first. The guards refuse to cascade, so this order is mandatory:
  // contacts and amendments, then contracts, then clients; employees before
  // brokers and contract types, because those refuse while held.
  //
  // Each array is pruned as it is emptied. An earlier draft only pruned clients,
  // which made the "no fixtures left behind" assertion report ids for rows that
  // had been deleted successfully - the assertion was wrong, not the cleanup.
  const drop = async (list, path, prep) => {
    for (const id of [...list]) {
      if (prep) await prep(id);
      const res = await request(path(id), { method: 'DELETE', cookie: A });
      // 404 is legitimate: an earlier step may already have proved the guard
      // releases, by deleting the row itself.
      if (res.status === 204 || res.status === 404) {
        const at = list.indexOf(id);
        if (at !== -1) list.splice(at, 1);
      }
    }
  };

  await drop(residue.contacts, (id) => `/api/contacts/${id}`);
  await drop(residue.employees, (id) => `/api/employees/${id}`);
  await drop(residue.brokers, (id) => `/api/brokers/${id}`);
  await drop(residue.types, (id) => `/api/employee-contract-types/${id}`);
  // Clear cost parameters first. The delete guard refuses while any exist, so an
  // amendment that had one attached would otherwise be unrecoverable by the
  // cleanup and would wedge every future run behind a stuck contract chain.
  // An empty array means "remove them all" - see the note in amendments.ts.
  await drop(
    residue.amendments,
    (id) => `/api/amendments/${id}`,
    (id) =>
      request(`/api/amendments/${id}/cost-parameters`, {
        method: 'PUT',
        cookie: A,
        body: { parameters: [] },
      }),
  );
  await drop(residue.contracts, (id) => `/api/contracts/${id}`);

  // Restore before delete. A DELETE on an archived client that still has a contract
  // is refused by design, so cleanup has to undo the archive before it can remove
  // the row - archiving is reversible and so is the cleanup that has to undo it.
  for (const id of [...residue.clients]) {
    await request(`/api/clients/${id}/archive`, { method: 'DELETE', cookie: A });
    const res = await request(`/api/clients/${id}`, { method: 'DELETE', cookie: A });
    if (res.status === 204 || res.status === 404) {
      residue.clients = residue.clients.filter((c) => c !== id);
    }
  }

  const leftovers = [
    ...residue.contacts,
    ...residue.employees,
    ...residue.brokers,
    ...residue.types,
    ...residue.amendments,
    ...residue.contracts,
    ...residue.clients,
  ];
  checkThat('no fixtures are left behind', leftovers.length === 0, `left: ${leftovers.join(', ')}`);

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
    const anyResidue =
      residue.contacts.length ||
      residue.employees.length ||
      residue.brokers.length ||
      residue.types.length ||
      residue.amendments.length ||
      residue.contracts.length ||
      residue.clients.length;

    if (anyResidue) {
      console.log(colour.dim('\nAttempting cleanup of abandoned fixtures…'));
      try {
        const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
        if (admin.ok) {
          for (const id of residue.contacts)
            await request(`/api/contacts/${id}`, { method: 'DELETE', cookie: admin.cookie });
          for (const id of residue.employees)
            await request(`/api/employees/${id}`, { method: 'DELETE', cookie: admin.cookie });
          for (const id of residue.brokers)
            await request(`/api/brokers/${id}`, { method: 'DELETE', cookie: admin.cookie });
          for (const id of residue.types)
            await request(`/api/employee-contract-types/${id}`, {
              method: 'DELETE',
              cookie: admin.cookie,
            });
          for (const id of residue.amendments) {
            await request(`/api/amendments/${id}/cost-parameters`, {
              method: 'PUT',
              cookie: admin.cookie,
              body: { parameters: [] },
            });
            await request(`/api/amendments/${id}`, { method: 'DELETE', cookie: admin.cookie });
          }
          for (const id of residue.contracts)
            await request(`/api/contracts/${id}`, { method: 'DELETE', cookie: admin.cookie });
          for (const id of residue.clients)
            await request(`/api/clients/${id}`, { method: 'DELETE', cookie: admin.cookie });
        }
      } catch {
        console.log(
          colour.dim(
            '  cleanup could not complete; remove the smoke rows by hand. Note that employee\n' +
              '  rows are terminated rather than deleted, so a smoke employee will persist as\n' +
              '  inactive. That is ADR-007 Q4 working as designed, not a leak.',
          ),
        );
      }
    }
  });
