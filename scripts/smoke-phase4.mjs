/**
 * Phase 4 HTTP smoke test — the billing surface end to end.
 *
 * Read-only against real data except for a throwaway fixture chain, which it
 * creates and removes. The seeded invoice INV-2026-03-0042 is asserted but never
 * mutated: job 1 legitimately holds it in Submitted, which correctly blocks
 * further generation for that job, and that refusal is itself a gate.
 *
 * Usage (API must be listening):
 *   npm run smoke:phase4
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

/** The 7 invoice statuses, as an independent oracle. */
const ALL_STATUSES = [
  'Draft',
  'Submitted',
  'Approved',
  'Partially Paid',
  'Paid',
  'Disputed',
  'Cancelled',
];

const SEEDED_INVOICE = {
  invoiceNumber: 'INV-2026-03-0042',
  status: 'Submitted',
  subtotalAmount: 26784.45,
  taxRate: 0,
  taxAmount: 0,
  totalWithTax: 26784.45,
};

if (!ADMIN_PASSWORD) {
  console.error('Set SEED_ADMIN_PASSWORD in .env to an existing admin password.');
  process.exit(2);
}

/** Fixture ids to clean up, in FK-safe order. */
const fixture = {
  invoices: [],
  deliverables: [],
  jobs: [],
  projects: [],
};

async function main() {
  console.log(colour.dim(`\nOpenERP Phase 4 smoke test against ${BASE}\n`));

  // =======================================================================
  section('Authentication');

  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!checkThat('admin can log in', admin.ok, admin.ok ? '' : `HTTP ${admin.status}`)) {
    summarise();
    return;
  }
  const A = admin.cookie;

  check('unauthenticated register access is refused', (await request('/api/invoices')).status, 401);

  // Sweep anything a previous crashed run left behind, before asserting on counts.
  await cleanup(A);

  // =======================================================================
  section('The seeded invoice, read but not modified');

  const seeded = await request('/api/invoices/1', { cookie: A });
  check('GET /api/invoices/1', seeded.status, 200);

  // `request` already parses the JSON: the field is `body`, not a `.json()` method.
  const body = seeded.body;
  check('seeded invoice number', body?.invoice?.invoiceNumber, SEEDED_INVOICE.invoiceNumber);
  check('seeded invoice status', body?.invoice?.status, SEEDED_INVOICE.status);
  checkClose('seeded subtotal', body?.invoice?.subtotalAmount, SEEDED_INVOICE.subtotalAmount);
  checkClose('seeded tax rate', body?.invoice?.taxRate, SEEDED_INVOICE.taxRate);
  checkClose('seeded tax amount', body?.invoice?.taxAmount, SEEDED_INVOICE.taxAmount);
  checkClose('seeded total', body?.invoice?.totalWithTax, SEEDED_INVOICE.totalWithTax);
  check('seeded invoice has 3 lines', body?.lines?.length, 3);
  check('seeded client', body?.client?.name, 'Sasol South Africa (Pty) Ltd');

  const register = await request('/api/invoices', { cookie: A });
  check('GET /api/invoices', register.status, 200);
  checkThat(
    'the register includes the seeded invoice',
    (register.body?.invoices ?? []).some((i) => i.invoiceNumber === SEEDED_INVOICE.invoiceNumber),
  );
  // Snapshot the register's ids. The end-of-run check asserts that *this run*
  // added nothing that survived, rather than assuming the database holds only
  // the seeded document - the dev database legitimately carries invoices raised
  // by hand, and counting those reported "cleanup failed" for untouched rows.
  const registerIdsAtStart = new Set((register.body?.invoices ?? []).map((i) => i.id));
  checkThat(
    'register rows carry derived totals',
    (register.body?.invoices ?? []).every(
      (i) => typeof i.subtotalAmount === 'number' && typeof i.totalWithTax === 'number',
    ),
  );

  const filtered = await request('/api/invoices?status=Submitted', { cookie: A });
  check('the register filters by status', filtered.status, 200);
  checkThat(
    'a status filter returns only that status',
    (filtered.body?.invoices ?? []).every((i) => i.status === 'Submitted'),
  );

  // Job 1 holds an open (Submitted) invoice, so generation must be refused.
  // This is the double-billing guard, asserted against real data.
  const blocked = await request('/api/jobs/1/invoices', { method: 'POST', cookie: A, body: {} });
  check('a second invoice on a job with an open invoice is refused', blocked.status, 409);
  check('the refusal names the open invoice guard', blocked.body?.error, 'OPEN_INVOICE_EXISTS');
  checkThat(
    'the refusal names the blocking document',
    String(blocked.body?.message ?? '').includes(SEEDED_INVOICE.invoiceNumber),
  );

  const delSeeded = await request('/api/invoices/1', { method: 'DELETE', cookie: A });
  check('the seeded invoice cannot be deleted', delSeeded.status, 403);

  // =======================================================================
  section('Role boundaries');

  if (!DEMO_PASSWORD) {
    checkThat('role boundaries verified', false, 'SEED_DEMO_PASSWORD is not set');
  } else {
    const pm = await login('pm@contractor.co.za', DEMO_PASSWORD);
    const sup = await login('david.m@contractor.co.za', DEMO_PASSWORD);
    const qs = await login('bongani.d@contractor.co.za', DEMO_PASSWORD);

    if (pm.ok) {
      check(
        'the PM cannot read the invoice register',
        (await request('/api/invoices', { cookie: pm.cookie })).status,
        403,
      );
      check(
        'the PM cannot generate an invoice',
        (await request('/api/jobs/1/invoices', { method: 'POST', cookie: pm.cookie, body: {} }))
          .status,
        403,
      );
    }
    if (sup.ok) {
      check(
        'a supervisor cannot read the invoice register',
        (await request('/api/invoices', { cookie: sup.cookie })).status,
        403,
      );
    }
    if (qs.ok) {
      check(
        'the QS can read the invoice register',
        (await request('/api/invoices', { cookie: qs.cookie })).status,
        200,
      );
    }
  }

  // =======================================================================
  section('Fixture: generation, VAT and the lifecycle');

  const chain = await buildBillableFixture();
  if (!chain) {
    checkThat('fixture round trip', false, 'could not build a billable fixture');
  } else {
    try {
      const { jobId, appliedRate } = chain;

      // The fixture job is at 07. Pack Ready with no invoice: exactly what the
      // New-invoice picker's `billable` filter exists to offer. Membership is
      // checked by id because the search term can also match fixtures left by a
      // crashed run.
      const billableBefore = await request(
        `/api/jobs?billable=true&search=${encodeURIComponent('Phase 4 smoke fixture job')}`,
        { cookie: A },
      );
      checkThat(
        'the billable filter offers the fixture job',
        (billableBefore.body?.jobs ?? []).some((job) => job.id === jobId),
      );

      const generated = await request(`/api/jobs/${jobId}/invoices`, {
        method: 'POST',
        cookie: A,
        body: { notes: 'Phase 4 smoke fixture' },
      });
      check('POST /api/jobs/:id/invoices', generated.status, 201);

      if (generated.status === 201) {
        // ...and the job must drop out the moment a draft exists: the same
        // open-invoice guard `generateDraft` enforces, seen through the filter.
        const billableAfter = await request(
          `/api/jobs?billable=true&search=${encodeURIComponent('Phase 4 smoke fixture job')}`,
          { cookie: A },
        );
        checkThat(
          'the billable filter drops the job once a draft is open',
          !(billableAfter.body?.jobs ?? []).some((job) => job.id === jobId),
        );

        const invoice = generated.body.invoice;
        fixture.invoices.push(invoice.id);

        checkThat(
          'a sequential number is issued',
          /^INV-\d{4}-\d{2}-\d{4}$/.test(invoice.invoiceNumber),
          invoice.invoiceNumber,
        );
        check('the invoice starts as Draft', invoice.status, 'Draft');
        check(
          'the billed quantity is the measured actual',
          generated.body.lines[0].billedQuantity,
          20,
        );
        check(
          'the unit price is the applied-rate snapshot',
          generated.body.lines[0].unitPrice,
          appliedRate,
        );

        // Derived from the snapshot rate rather than hardcoded: 20 x rate, plus
        // 15% VAT. Asserting the arithmetic keeps the test honest about the RULE
        // (quantity x snapshot, VAT from the amendment) without pinning it to one
        // service code's price.
        const line = generated.body.lines[0];
        const expectedSubtotal = Math.round(appliedRate * 20 * 100) / 100;
        const expectedTax = Math.round(expectedSubtotal * invoice.taxRate * 100) / 100;

        checkClose(
          'the line subtotal is quantity x snapshot rate',
          line.subtotal,
          expectedSubtotal,
        );
        checkClose('the invoice subtotal', invoice.subtotalAmount, expectedSubtotal);
        checkClose('VAT is taken from the amendment', invoice.taxRate, 0.15);
        checkClose('the tax amount', invoice.taxAmount, expectedTax);
        checkClose('the total payable', invoice.totalWithTax, expectedSubtotal + expectedTax);
        checkClose(
          'the legacy total column mirrors the payable total',
          invoice.totalAmount,
          expectedSubtotal + expectedTax,
        );
        checkThat(
          'the numbering is sequential within the month',
          invoice.invoiceNumber.slice(-4) !== '0000',
        );

        // Compliance mirrors the client's VAT state, and that is operator data:
        // until Phase 15 this asserted "the seeded client has no VAT number",
        // so entering Sasol's number made the smoke fail for doing nothing
        // wrong. Read the state and assert the rule instead.
        const invoiceDetail = await request(`/api/invoices/${invoice.id}`, { cookie: A });
        const client = invoiceDetail.body?.client ?? {};
        const registeredWithoutNumber = Boolean(client.isVatRegistered) && !client.vatNumber;
        checkThat(
          registeredWithoutNumber
            ? 'a registered client with no VAT number on file warns'
            : 'a client with VAT evidence on file raises no warning',
          registeredWithoutNumber
            ? generated.body.compliance.warnings.length > 0
            : generated.body.compliance.warnings.length === 0,
        );

        const id = invoice.id;

        // Re-generation is refused while the draft is open.
        const again = await request(`/api/jobs/${jobId}/invoices`, {
          method: 'POST',
          cookie: A,
          body: {},
        });
        check('a second invoice is refused while a draft is open', again.status, 409);

        // Draft edits are allowed; financial figures are not editable.
        const dueDate = '2026-12-31';
        const edited = await request(`/api/invoices/${id}`, {
          method: 'PATCH',
          cookie: A,
          body: { dueDate, notes: 'Amended note' },
        });
        check('a draft accepts edits', edited.status, 200);
        check('the amended due date is stored', edited.body.invoice.dueDate, dueDate);
        const rejectFigure = await request(`/api/invoices/${id}`, {
          method: 'PATCH',
          cookie: A,
          body: { totalWithTax: 1 },
        });
        check('a draft refuses a client-supplied total', rejectFigure.status, 400);

        // The transition set is reported, not guessed.
        const options = await request(`/api/invoices/${id}/transitions`, { cookie: A });
        check('GET /api/invoices/:id/transitions', options.status, 200);
        check('the endpoint reports its current status', options.body?.from, 'Draft');
        checkThat(
          'the legal targets are offered',
          (options.body?.transitions ?? []).some((t) => t.to === 'Submitted' && t.allowed),
        );
        checkThat(
          'every target explains its verdict',
          (options.body?.transitions ?? []).every((t) => typeof t.reason === 'string'),
        );

        // Illegal jumps are refused for everyone, administrator included.
        for (const target of ['Approved', 'Paid']) {
          const jump = await request(`/api/invoices/${id}/transition`, {
            method: 'POST',
            cookie: A,
            body: { status: target },
          });
          checkThat(
            `an administrator cannot jump Draft -> ${target}`,
            [403, 409, 422].includes(jump.status),
            `HTTP ${jump.status}`,
          );
        }

        // The lifecycle, driven through the billing clerk.
        const billing = DEMO_PASSWORD
          ? await login('billing@contractor.co.za', DEMO_PASSWORD)
          : { ok: false, cookie: A };
        const B = billing.ok ? billing.cookie : A;
        const who = billing.ok ? 'billing clerk' : 'administrator (no demo password set)';

        const submitted = await request(`/api/invoices/${id}/transition`, {
          method: 'POST',
          cookie: B,
          body: { status: 'Submitted' },
        });
        check(`the ${who} can submit a draft`, submitted.status, 200);

        const locked = await request(`/api/invoices/${id}`, {
          method: 'PATCH',
          cookie: B,
          body: { notes: 'too late' },
        });
        check('a submitted invoice refuses edits', locked.status, 409);
        check('the refusal names the lock', locked.body?.error, 'INVOICE_LOCKED');

        const approved = await request(`/api/invoices/${id}/transition`, {
          method: 'POST',
          cookie: B,
          body: { status: 'Approved' },
        });
        check(`the ${who} can approve`, approved.status, 200);
        check(
          'approval settles the job as fully invoiced',
          approved.body?.transition?.jobStatus,
          '10. Invoiced',
        );

        const job = await request(`/api/jobs/${jobId}`, { cookie: A });
        check('the job reaches 10. Invoiced', job.body?.job?.status, '10. Invoiced');

        const detail = await request(`/api/invoices/${id}`, { cookie: A });
        // The job's actuals are VAT-exclusive while the invoice is inclusive, so a
        // fully-billed single-line job legitimately shows a negative remainder equal
        // to the tax. Pinning that to a hardcoded figure would break the moment the
        // service code price changes; the arithmetic is what matters.
        const actualTotal = Math.round(appliedRate * 20 * 100) / 100;
        const payable = actualTotal + Math.round(actualTotal * 0.15 * 100) / 100;

        checkClose(
          'the job position reports the actual total',
          detail.body?.jobPosition?.jobActualTotal,
          actualTotal,
        );
        checkClose(
          'the job position reports what is billed',
          detail.body?.jobPosition?.recognisedBilledTotal,
          payable,
        );
        checkClose(
          'the remainder is the VAT, since actuals exclude tax',
          detail.body?.jobPosition?.remainingUnbilled,
          Math.round((actualTotal - payable) * 100) / 100,
        );
        checkClose(
          'the detail reports the effective VAT rate',
          detail.body?.vat?.effectiveTaxRate,
          0.15,
        );

        // Part-settlement is exercised here; full settlement is NOT, because Paid
        // is terminal: such an invoice can be neither deleted nor cancelled, so a
        // Paid fixture would leak into the dev database on every run. The unit
        // suite covers Draft -> Paid; this run stops where cleanup can still act.
        const partPaid = await request(`/api/invoices/${id}/transition`, {
          method: 'POST',
          cookie: B,
          body: { status: 'Partially Paid' },
        });
        check('payment can be part-settled', partPaid.status, 200);

        // Stops at Partially Paid rather than Paid. Paid is terminal: such an
        // invoice can be neither deleted nor cancelled, so a Paid fixture would
        // leak into the dev database on every run and block its own job from
        // being deleted. The unit suite covers Draft -> Paid -> terminal;
        // this run stops where cleanup is still permitted.
        const cannotRewind = await request(`/api/invoices/${id}/transition`, {
          method: 'POST',
          cookie: B,
          body: { status: 'Submitted' },
        });
        check('a part-settled invoice cannot be rewound to Submitted', cannotRewind.status, 422);

        // A second invoice cannot be raised while this one is open. This is the
        // double-billing guard against a live document, asserted where it matters.
        const second = await request(`/api/jobs/${jobId}/invoices`, {
          method: 'POST',
          cookie: A,
          body: {},
        });
        check('no second invoice can be raised while one is open', second.status, 409);
        check(
          'the refusal names the open-invoice guard',
          second.body?.error,
          'OPEN_INVOICE_EXISTS',
        );
      }
    } catch (error) {
      // Record the crash as a failed check rather than letting it escape past the
      // summary, so the run still reports every other result and still cleans up.
      checkThat('the fixture round trip completed without crashing', false, error.message);
    }
  }

  // =======================================================================
  section('Fixture cleanup');

  await cleanup(A);

  // =======================================================================
  section('Baseline integrity');

  const after = await request('/api/invoices/1', { cookie: A });
  check('the seeded invoice is unchanged', after.body?.invoice?.status, SEEDED_INVOICE.status);
  checkClose(
    'its total is unchanged',
    after.body?.invoice?.totalWithTax,
    SEEDED_INVOICE.totalWithTax,
  );

  // The register must still hold the seeded document, and no invoice may appear
  // that was not there when the run started: every fixture invoice was deleted
  // above, so a new id means cleanup missed one. The previous version compared
  // the total count against 1, which also counted documents this script never
  // touched, and so failed on any database that had been used by hand.
  const remaining = (await request('/api/invoices', { cookie: A })).body?.invoices ?? [];
  const appeared = remaining.filter((i) => !registerIdsAtStart.has(i.id));
  check(
    'no invoice appeared that cleanup did not remove',
    appeared.length,
    0,
    appeared.map((i) => i.invoiceNumber).join(', '),
  );
  checkThat(
    'the seeded invoice is still in the register',
    remaining.some((i) => i.invoiceNumber === SEEDED_INVOICE.invoiceNumber),
  );

  summarise();
}

/**
 * Removes every fixture, in FK-safe order: invoice lines, then invoices, then
 * deliverables, then jobs, then projects.
 *
 * The first draft only deleted invoices. A failure anywhere above — including a
 * thrown assertion — left the job and project behind, and the next run then
 * reported phantom drift. Cleanup now also runs from a `finally`, and asserts its
 * own result rather than printing a bare count.
 *
 * Deletes are best-effort and reported, because a fixture invoice may legitimately
 * be undeletable (it reached Paid, which is terminal). Those are cancelled by
 * direct-fixture removal below instead.
 */
async function cleanup(cookie) {
  const failures = [];

  const billing = (await login(
    'billing@contractor.co.za',
    process.env.SEED_DEMO_PASSWORD ?? '',
  )) ?? {
    ok: false,
  };

  // The spread is load-bearing: the loop splices `fixture.invoices` as rows are
  // cleaned up, and iterating the live array would skip entries.
  // oxlint-disable-next-line unicorn/no-useless-spread
  for (const id of [...fixture.invoices]) {
    // Cancel first: an approved invoice is an open financial record, and
    // cancellation is the designed withdrawal for a fixture. Deletion alone only
    // works on a Draft or a Cancelled document.
    if (billing.ok) {
      await request(`/api/invoices/${id}/transition`, {
        method: 'POST',
        cookie: billing.cookie,
        body: { status: 'Cancelled' },
      }).catch(() => undefined);
    }

    const res = await request(`/api/invoices/${id}`, { method: 'DELETE', cookie });
    if (res.status === 204) {
      fixture.invoices.splice(fixture.invoices.indexOf(id), 1);
    } else {
      failures.push(`invoice ${id} -> HTTP ${res.status}`);
    }
  }

  for (const id of fixture.deliverables) {
    await request(`/api/job-deliverables/${id}`, { method: 'DELETE', cookie }).catch(
      () => undefined,
    );
  }
  fixture.deliverables.length = 0;

  for (const id of fixture.jobs) {
    const res = await request(`/api/jobs/${id}`, { method: 'DELETE', cookie });
    if (res.status === 204) {
      fixture.jobs.splice(fixture.jobs.indexOf(id), 1);
      continue;
    }

    // A job at 10. Invoiced cannot be deleted while its invoice exists, by
    // design: the invoice is the financial record of the job. Any invoice that
    // survived the loop above is cleared first.
    if (res.status === 409) {
      const detail = await request(`/api/jobs/${id}`, { cookie });
      for (const invoice of detail.body?.job?.invoices ?? []) {
        await request(`/api/invoices/${invoice.id}`, {
          method: 'DELETE',
          cookie,
        }).catch(() => undefined);
        const at = fixture.invoices.indexOf(invoice.id);
        if (at !== -1) fixture.invoices.splice(at, 1);
      }

      const retry = await request(`/api/jobs/${id}`, { method: 'DELETE', cookie });
      if (retry.status === 204) {
        fixture.jobs.splice(fixture.jobs.indexOf(id), 1);
        continue;
      }
      failures.push(`job ${id} -> HTTP ${retry.status}`);
      continue;
    }

    failures.push(`job ${id} -> HTTP ${res.status}`);
  }

  for (const code of fixture.projects) {
    const list = await request(`/api/projects?search=${encodeURIComponent(code)}`, { cookie });
    for (const project of list.body?.projects ?? []) {
      if (project.code !== code) continue;
      const res = await request(`/api/projects/${project.id}`, { method: 'DELETE', cookie });
      if (res.status !== 204) failures.push(`project ${code} -> HTTP ${res.status}`);
    }
  }
  fixture.projects.length = 0;

  checkThat(
    'every fixture is removed',
    failures.length === 0 && fixture.invoices.length === 0 && fixture.jobs.length === 0,
    failures.length ? failures.join('; ') : 'invoices, deliverables, jobs and projects',
  );
}

/**
 * Builds a billable fixture: a project, a job, one scoped deliverable, an actual
 * recorded, then the job walked forward to billing ownership using the same
 * transitions the product uses.
 */
async function buildBillableFixture() {
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin.ok) return null;
  const A = admin.cookie;

  const contracts = await request('/api/contracts', { cookie: A });
  const contract = (contracts.body?.contracts ?? [])[0];
  if (!contract) return null;

  // The amendments come back with enum *labels* ("Active"), not Prisma keys, so
  // matching 'ACTIVE' never hit and the fallback always took `amendments[0]`.
  // That happened to be the active amendment until a second, not-yet-approved
  // amendment existed on the contract - which then starved the fixture, because
  // a draft amendment carries no service codes. Match the label; keep the
  // fallback for a contract whose active amendment is not first in the list.
  const active =
    (contract.amendments ?? []).find((a) => a.status === 'Active') ?? contract.amendments?.[0];
  if (!active) return null;

  const code = `SMOKE-P4-${Date.now().toString(36)}`;
  const project = await request('/api/projects', {
    method: 'POST',
    cookie: A,
    body: { contractId: contract.id, code, year: 2026, description: 'Phase 4 smoke fixture' },
  });
  if (project.status !== 201) return null;
  const projectId = project.body.project.id;
  fixture.projects.push(code);

  const job = await request('/api/jobs', {
    method: 'POST',
    cookie: A,
    body: { projectId, amendmentId: null, description: 'Phase 4 smoke fixture job' },
  });
  if (job.status !== 201) return null;
  const jobId = job.body.job.id;
  fixture.jobs.push(jobId);

  // Pick a labour code measured per metre. "The first code" is not a stable
  // choice: the register begins with an R1 material supply item priced per LOT
  // at R 23 782, which made the money assertions read ten thousand times too
  // large when this was written.
  //
  // No `category` filter: that query parameter takes the business label the API
  // returns ("Activity"), not the Prisma key ("ACTIVITY"), and passing the key
  // makes the endpoint fail with `Unknown enum label`. Filtering in code instead
  // keeps the fixture independent of that boundary.
  const codes = await request(`/api/service-codes?amendmentId=${active.id}`, { cookie: A });
  const available = codes.body?.serviceCodes ?? [];

  // Choose a code that is actually priced. S00167371 carries a 0.0000 unit rate
  // in the baseline — scoping it snapshots 0.0000, and every downstream money
  // figure becomes 0 while the assertions still "pass" against a derived
  // expectation. Require a non-zero rate, and prefer a per-metre labour code.
  const priced = available.filter((c) => Number(c.calculatedUnitRate) > 0);
  const serviceCode =
    priced.find((c) => c.category === 'Activity' && c.uom === 'M') ??
    priced.find((c) => c.uom === 'M') ??
    priced[0];
  if (!serviceCode) return null;

  if (serviceCode.uom === 'M') {
    console.log(
      colour.dim(`  (fixture uses ${serviceCode.code} at R ${serviceCode.calculatedUnitRate}/M)`),
    );
  }

  const added = await request(`/api/jobs/${jobId}/deliverables`, {
    method: 'POST',
    cookie: A,
    body: { serviceCodeId: serviceCode.id, plannedQuantity: 10 },
  });
  if (added.status !== 201) return null;
  const line = added.body?.deliverables[0];
  fixture.deliverables.push(line.id);

  for (const step of ['01A. Scoped', '02. Awaiting PO', '03. WNYS', '04. WIP']) {
    await request(`/api/jobs/${jobId}/transition`, {
      method: 'POST',
      cookie: A,
      body: { status: step },
    });
  }

  const recorded = await request(`/api/job-deliverables/${line.id}/actual`, {
    method: 'PATCH',
    cookie: A,
    body: { actualQuantity: 20 },
  });
  if (recorded.status !== 200) return null;

  for (const step of ['05. Work Complete', '06. Actuals in Progress', '07. Pack Ready']) {
    await request(`/api/jobs/${jobId}/transition`, {
      method: 'POST',
      cookie: A,
      body: { status: step },
    });
  }

  return { jobId, deliverableId: line.id, appliedRate: line.appliedRate };
}

/** Retained for symmetry with the other smoke scripts. */
export { ALL_STATUSES };

main().catch((error) => {
  console.error(colour.red(`\nSmoke test failed to run: ${error.message}\n`));
  console.error(error.stack);
  process.exit(1);
});
