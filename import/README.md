# OpenERP data import

Fill `OpenERP-import-template.xlsx` with existing business data, validate it
without writing anything, then import it. The workbook and both scripts live
with the code so the template can never drift from what the importer accepts.

## Order of work

1. **Seed first.** `npm run seed --workspace server` — roles, permissions and
   the `Full Time` contract type. The importer reuses seeded rows by exact name.
2. **Regenerate the template** (optional, but do it if the app has moved on
   since the committed copy):
   `npm run import:template`
3. **Fill the sheets in tab order, left to right.** Clients → … → Crew. Every
   reference points backwards to something already entered.
4. **Dry run** (writes nothing, checks everything):
   `npm run import:data -- --file import/OpenERP-import-template.xlsx`
5. **Fix every FAIL** it reports. Re-run until clean.
6. **Back up the database.**
7. **Apply:** add `--apply`.

## What the dry run proves

- Every reference resolves: unknown or ambiguous names fail with sheet, row
  and column.
- Every enum value is one the API accepts (same shared lists, same error on
  a typo).
- Uniqueness within the file and against the database (emails, contract
  numbers, project codes, codes per amendment, rate code/shift pairs).
- Amendment scoping: a project, job or line pointing at another contract's
  amendment is refused, mirroring the server's 422.
- The pricing ties: rate build-ups, recipe rollups and job planned totals are
  computed with the application's own engines and printed, e.g.
  `TEST-ART-NT → 203.97 ZAR/hr`.

## Conventions

- Dates are ISO text `YYYY-MM-DD`. If Excel reformats a cell, set it to Text
  and retype.
- `TRUE` / `FALSE` capitalised, from the dropdown.
- Money: plain numbers, 2 decimals max. Rates: 4 decimals max.
- **Fractions vs percents** (the one that bites): columns ending in
  _fraction_ are fractions (`0.095` = 9.5%, the API rejects above 1);
  `CostParameters` rows with UoM `%` are percent _numbers_ (`9.5` = 9.5%,
  the engine divides by 100 itself).
- References are natural keys — emails, contract numbers, project codes —
  never database ids.
- `*` means required. Blank optional cells stay blank; never type N/A.
- Rows whose first cell starts with `EXAMPLE` are worked examples and are
  skipped. Delete or overwrite them.
- Blank `Overhead cost` + `SG&A cost` on a rate card derives both from the
  amendment parameters (which must then exist). Providing them stores them as
  authoritative, per ADR-001 Q1.
- Blank amendment on a job inherits the project's (the Phase 3 rule).
- Blank applied rate on a job line snapshots the code's current rate.

## Deliberately not imported

- **User accounts.** Passwords cannot come from a spreadsheet. Import the
  employees, then create logins in Administration → Users.
- **Actual quantities and invoices.** Open work only: jobs arrive at Scoping /
  Scoped / Awaiting PO with planned quantities. Actuals are recorded in the
  field view; invoices are raised from them. History stays where it is.
- **Existing rows are never overwritten.** A natural-key collision aborts the
  row with an error. Brokers and contract types are the exception: pure
  reference data, reused by exact name.
- **Contacts link to jobs by email.** A contact without an email can be
  imported but cannot be named on a job — link those in the app.

## If apply fails partway

Validation runs first and aborts on any error, so a mid-apply failure means
something changed in the database between validation and write (usually a
duplicate created concurrently). Rows written before the failure stay written:
restore from the backup, remove the cause, re-run. Writes are sequential, not
one transaction, because the pricing service owns its writes and cannot join a
caller transaction.

Every applied row is audit-logged as `system`, row by row — the trail shows
exactly which rows the import created.
