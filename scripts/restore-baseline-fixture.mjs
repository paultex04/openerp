/**
 * Restores the parts of the baseline database that the integration suites write
 * to, so a local test run does not leave the dev database dirty.
 *
 * WHY THIS EXISTS
 *
 * The billing and commercial suites exercise the real seeded invoice
 * (INV-2026-03-0042 on job 1) and the seeded client (client 1) around it. The
 * suites create their own fixtures and tear those down, but a few assertions
 * deliberately touch baseline rows rather than fixture rows:
 *
 *   - `commercial.integration.test.ts` rewrites the legacy invoice's VAT
 *     breakdown to prove the columns are enforced.
 *   - `billing.integration.test.ts` cancels the seeded invoice so job 1 becomes
 *     billable, then restores its status. `PAID` is terminal, so the restore only
 *     succeeds from a non-terminal status: once the invoice drifts to `Paid` the
 *     cancellation is refused, the test fails halfway through, and the database
 *     is left in the very state the test was trying to avoid.
 *   - `billing.integration.test.ts` also fills in client 1's VAT number to prove
 *     the compliance check keys on that field, and nulls it again in a
 *     `finally`. A run that is *killed* rather than failed never reaches the
 *     `finally`, leaving the registered seeded client with a tax number it is
 *     supposed to lack (the ADR-001 baseline gap). The next Gate 1 run then
 *     reports a spurious compliance pass — the failure mode this script exists
 *     for, observed on a real run in Phase 14.
 *
 * Both failure modes are self-perpetuating, so this script is the documented way
 * out. It is idempotent and safe to re-run.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not recreate the invoice lines, the client, the contract chain or the
 * job. It restores the seeded rows' *numeric, status and VAT-registration*
 * columns to the published values asserted by the suites, which is what actually
 * drifts. Run `npm run smoke:phase4` afterwards to confirm.
 *
 * Usage: node scripts/restore-baseline-fixture.mjs [--dry]
 */
import { loadEnvFile } from './lib/env.mjs';
import pg from 'pg';

loadEnvFile();

const dry = process.argv.includes('--dry');

const SEEDED_INVOICE_NUMBER = 'INV-2026-03-0042';

/** Client 1 is the seeded client the suites key on by id. */
const SEEDED_CLIENT_ID = 1;

/**
 * The published, VAT-exempt figures for the legacy invoice.
 *
 * These are the values the acceptance suites assert. `total_amount` is the
 * pre-VAT legacy column, so it is the subtotal with no tax added.
 */
const EXPECTED = {
  status: 'Submitted',
  SubtotalAmount: '26784.45',
  TaxAmount: '0.00',
  TotalWithTax: '26784.45',
  TotalAmount: '26784.45',
};

/**
 * The seeded client's shipped VAT state: registered, but with no number on file
 * (ADR-001 records the gap; `billing.integration.test.ts` Gate 1 asserts it).
 */
const EXPECTED_CLIENT = { vatRegistered: true, vatNumber: null };

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/** Returns -1 when the row is missing, 0 when it already matches, 1 when restored. */
async function restoreInvoice() {
  const { rows } = await pool.query(
    `SELECT id, invoice_number, status,
            total_amount, subtotal_amount, tax_amount, total_with_tax
       FROM invoice
      WHERE invoice_number = $1`,
    [SEEDED_INVOICE_NUMBER],
  );

  if (rows.length === 0) {
    console.error(`No invoice numbered ${SEEDED_INVOICE_NUMBER}.`);
    return -1;
  }

  const before = rows[0];
  console.log('invoice before:', before);

  const already =
    before.status === EXPECTED.status &&
    Number(before.subtotal_amount) === Number(EXPECTED.SubtotalAmount) &&
    Number(before.tax_amount) === Number(EXPECTED.TaxAmount) &&
    Number(before.total_with_tax) === Number(EXPECTED.TotalWithTax) &&
    Number(before.total_amount) === Number(EXPECTED.TotalAmount);

  if (already) {
    console.log(`${SEEDED_INVOICE_NUMBER} already matches the baseline.`);
    return 0;
  }

  if (dry) {
    console.log(`${SEEDED_INVOICE_NUMBER} would be restored (--dry).`);
    return 0;
  }

  // Status and money columns only. The CHECK constraints added by migration 0002
  // require total_with_tax = subtotal_amount + tax_amount and non-negative
  // amounts, all of which the values above satisfy together - so they must be
  // written in one statement, not one column at a time.
  await pool.query(
    `UPDATE invoice
        SET status          = $2,
            subtotal_amount = $3,
            tax_amount      = $4,
            total_with_tax  = $5,
            total_amount    = $6
      WHERE invoice_number = $1`,
    [
      SEEDED_INVOICE_NUMBER,
      EXPECTED.status,
      EXPECTED.SubtotalAmount,
      EXPECTED.TaxAmount,
      EXPECTED.TotalWithTax,
      EXPECTED.TotalAmount,
    ],
  );

  const after = await pool.query(
    `SELECT id, invoice_number, status,
            total_amount, subtotal_amount, tax_amount, total_with_tax
       FROM invoice WHERE invoice_number = $1`,
    [SEEDED_INVOICE_NUMBER],
  );
  console.log('invoice after: ', after.rows[0]);
  console.log(`Restored ${SEEDED_INVOICE_NUMBER}.`);
  return 1;
}

/** Returns -1 when the row is missing, 0 when it already matches, 1 when restored. */
async function restoreSeededClient() {
  const { rows } = await pool.query(
    `SELECT id, name, is_vat_registered, vat_number
       FROM client
      WHERE id = $1`,
    [SEEDED_CLIENT_ID],
  );

  if (rows.length === 0) {
    console.error(`No client with id ${SEEDED_CLIENT_ID} (the seeded client).`);
    return -1;
  }

  const before = rows[0];
  console.log('client before: ', before);

  const already =
    before.is_vat_registered === EXPECTED_CLIENT.vatRegistered &&
    before.vat_number === EXPECTED_CLIENT.vatNumber;

  if (already) {
    console.log(`Client ${SEEDED_CLIENT_ID} already matches the baseline.`);
    return 0;
  }

  if (dry) {
    console.log(`Client ${SEEDED_CLIENT_ID} would be restored (--dry).`);
    return 0;
  }

  await pool.query(
    `UPDATE client
        SET is_vat_registered = $2,
            vat_number        = $3
      WHERE id = $1`,
    [SEEDED_CLIENT_ID, EXPECTED_CLIENT.vatRegistered, EXPECTED_CLIENT.vatNumber],
  );

  const after = await pool.query(
    `SELECT id, name, is_vat_registered, vat_number FROM client WHERE id = $1`,
    [SEEDED_CLIENT_ID],
  );
  console.log('client after:  ', after.rows[0]);
  console.log(`Restored client ${SEEDED_CLIENT_ID}.`);
  return 1;
}

const invoice = await restoreInvoice();
const client = await restoreSeededClient();

await pool.end();

if (invoice < 0 || client < 0) process.exit(1);
if (!dry && invoice === 0 && client === 0) console.log('\nBaseline fixture already matches.');
